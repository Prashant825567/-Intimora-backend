// Telegram MTProto storage layer (teleproto)
// - upload video + thumbnail to a private channel
// - stream byte ranges back for HTTP range requests (video playback, no direct download)
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { Api } = require("teleproto");

let _client = null;

function cfg() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH not set");
  return { apiId, apiHash };
}

async function getClient() {
  if (_client && _client.isConnected && _client.isConnected()) return _client;
  const { apiId, apiHash } = cfg();
  const session = new StringSession(process.env.TELEGRAM_SESSION || "");
  _client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    maxConcurrentDownloads: 4,
    downloadPool: { poolSize: 2, workers: 4, requestDeadlineMs: 60000 },
  });
  await _client.connect();
  if (!(await _client.isUserAuthorized())) {
    throw new Error("Telegram session not authorized — run `npm run login` and set TELEGRAM_SESSION");
  }
  return _client;
}

// ================= LOGIN (web, two-step, no 2FA) =================
async function sendLoginCode(phoneNumber) {
  const { apiId, apiHash } = cfg();
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  await client.connect();
  await client.invoke(new Api.auth.SendCode({
    phoneNumber,
    settings: new Api.CodeSettings(),
  }));
  await client.disconnect();
  return true;
}

async function verifyLogin(phoneNumber, phoneCode) {
  const { apiId, apiHash } = cfg();
  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
  await client.connect();
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCode }));
  } catch (err) {
    if (err.errorType === "SESSION_PASSWORD_NEEDED" || err.errorCode === 400 && /password/i.test(String(err.message))) {
      throw new Error("2FA is enabled on this account. Use `npm run login` locally to log in with your 2FA password, then paste the session string.");
    }
    throw err;
  }
  const me = await client.getMe();
  const saved = client.session.save();
  await client.disconnect();
  return { session: saved, user: { id: String(me.id), username: me.username || "", firstName: me.firstName || "" } };
}

// ================= UTIL: fileReference base64 =================
function refToBase64(ref) {
  if (!ref) return "";
  if (Buffer.isBuffer(ref)) return ref.toString("base64");
  if (typeof ref === "string") return ref;
  return Buffer.from(ref).toString("base64");
}
function refFromBase64(b64) {
  return Buffer.from(b64 || "", "base64");
}

// ================= UPLOAD =================
// Sends the video to the channel AS A DOCUMENT (forceDocument) so Telegram stores
// the exact bytes (no transcoding / compression). The thumbnail is sent separately
// as a photo so we can serve it independently and durably.
async function uploadVideo(filePath, { caption, thumbPath }) {
  const client = await getClient();
  const channel = process.env.TELEGRAM_CHANNEL;
  if (!channel) throw new Error("TELEGRAM_CHANNEL not set");

  // 1) upload the video document (with thumbnail attached)
  const msg = await client.sendFile(channel, {
    file: filePath,
    caption: caption || "",
    forceDocument: true,        // exact bytes, no video processing
    thumb: thumbPath,           // thumbnail attached to the document
    workers: 4,
  });

  const doc = msg.document;
  if (!doc) throw new Error("Telegram did not return a document — check channel/permissions");

  const videoLoc = {
    tg_doc_id: String(doc.id),
    tg_access_hash: String(doc.accessHash),
    tg_file_ref: refToBase64(doc.fileReference),
    tg_size: Number(doc.size),
    tg_mime: doc.mimeType || "",
    tg_channel: channel,
    tg_msg_id: msg.id,
  };

  // 2) upload the thumbnail as a separate photo (durable, independently streamable)
  let thumbLoc = null;
  if (thumbPath) {
    const tmsg = await client.sendFile(channel, {
      file: thumbPath,
      forceDocument: false,     // send as a photo
      workers: 2,
    });
    const photo = tmsg.photo;
    if (photo) {
      thumbLoc = {
        thumb_doc_id: String(photo.id),
        thumb_access_hash: String(photo.accessHash),
        thumb_file_ref: refToBase64(photo.fileReference),
        thumb_size: Number(photo.size),
      };
    }
  }

  return { ...videoLoc, ...thumbLoc };
}

// ================= STREAMING (HTTP range) =================
// Telegram stores files as 512 KB parts. With precise:false we fetch part-aligned
// ranges (contiguous, exact bytes) and discard any misaligned head. This gives a
// correct HTTP Range response for the <video> element.
const PART = 512 * 1024;

function makeDocLocation(docId, accessHash, fileRef, thumbSize = "") {
  return new Api.InputDocumentFileLocation({
    id: BigInt(docId),
    accessHash: BigInt(accessHash),
    fileReference: refFromBase64(fileRef),
    thumbSize,
  });
}

// fetch a single 512 KB part
async function getFileChunk(client, video, offset, limit) {
  const res = await client.invoke(new Api.upload.GetFile({
    location: makeDocLocation(video.tg_doc_id, video.tg_access_hash, video.tg_file_ref, ""),
    offset: BigInt(offset),
    limit,
    precise: false,
    cdnSupported: false,
  }));
  return res.bytes || Buffer.alloc(0);
}

// Stream a byte range [start, end] as an async generator of Buffers.
// Parts are fetched in small parallel batches (4) but yielded in order, so the
// browser receives contiguous exact bytes for a correct HTTP 206 response.
async function* streamRange(video, start, end) {
  const client = await getClient();
  const fileSize = video.tg_size;
  if (start >= fileSize) return;
  end = Math.min(end, fileSize - 1);
  const alignedStart = Math.floor(start / PART) * PART;
  let headDiscard = start - alignedStart; // bytes to skip from the very first part

  const parts = [];
  for (let offset = alignedStart; offset <= end; offset += PART) {
    parts.push({ offset, limit: Math.min(PART, end - offset + 1) });
  }

  const POOL = 4;
  for (let i = 0; i < parts.length; i += POOL) {
    const batch = parts.slice(i, i + POOL);
    const results = await Promise.all(
      batch.map((p) => getFileChunk(client, video, p.offset, p.limit))
    );
    for (const bytes of results) {
      if (headDiscard > 0) {
        const skip = Math.min(headDiscard, bytes.length);
        const rest = bytes.subarray(skip);
        if (rest.length) yield rest;
        headDiscard -= skip;
      } else if (bytes.length) {
        yield bytes;
      }
    }
  }
}

// thumbnail (separate photo) — fetch whole small image
async function fetchThumbnail(video) {
  if (!video.thumb_doc_id) return null;
  const client = await getClient();
  const loc = makeDocLocation(video.thumb_doc_id, video.thumb_access_hash, video.thumb_file_ref, "");
  const res = await client.invoke(new Api.upload.GetFile({
    location: loc,
    offset: BigInt(0),
    limit: PART,
    precise: false,
    cdnSupported: false,
  }));
  return res.bytes || null;
}

// ================= METADATA STORAGE (in Telegram) =================
// Each video's metadata is stored as a JSON text message in the same channel.
// SQLite is a fast cache; Telegram is the durable source of truth.
// Format of the JSON: { t:"meta", id, title, description, views, likes, shares,
//   duration, createdAt, video:{...}, thumbnail:{...} }

function buildMetadata(v) {
  return {
    t: "meta",
    id: v.id,
    title: v.title,
    description: (v.description || "").slice(0, 1000),
    views: v.views,
    likes: v.likes,
    shares: v.shares,
    duration: v.duration,
    createdAt: v.created_at,
    video: {
      docId: v.tg_doc_id,
      accessHash: v.tg_access_hash,
      fileRef: v.tg_file_ref,
      size: v.tg_size,
      mime: v.tg_mime,
      msgId: v.tg_msg_id,
    },
    thumbnail: v.thumb_doc_id ? {
      docId: v.thumb_doc_id,
      accessHash: v.thumb_access_hash,
      fileRef: v.thumb_file_ref,
      size: v.thumb_size,
    } : null,
  };
}

// Send metadata as a text message. Returns the Telegram message id.
async function sendMetadata(metadata) {
  const client = await getClient();
  const channel = process.env.TELEGRAM_CHANNEL;
  if (!channel) throw new Error("TELEGRAM_CHANNEL not set");
  const msg = await client.sendMessage(channel, { message: JSON.stringify(metadata) });
  return msg.id;
}

// Edit an existing metadata message with fresh data.
async function editMetadata(msgId, metadata) {
  const client = await getClient();
  const channel = process.env.TELEGRAM_CHANNEL;
  await client.editMessage(channel, { message: msgId, text: JSON.stringify(metadata) });
}

// Read metadata messages from the channel (for sync / rebuild).
// Returns array of { ...metadata, _msgId: Telegram message id }.
async function readMetadataFromTelegram(limit = 5000) {
  const client = await getClient();
  const channel = process.env.TELEGRAM_CHANNEL;
  const result = [];
  for await (const msg of client.iterMessages(channel, { limit })) {
    if (!msg.message) continue; // skip media messages (video/thumbnail)
    try {
      const data = JSON.parse(msg.message);
      if (data && data.t === "meta") result.push({ ...data, _msgId: msg.id });
    } catch { /* not JSON (e.g. video caption) — skip */ }
  }
  return result;
}

// Sync one video's metadata to Telegram (reads DB row, edits the message).
async function syncMetadataToTelegram(video) {
  if (!video || !video.meta_msg_id) return;
  const metadata = buildMetadata(video);
  await editMetadata(video.meta_msg_id, metadata);
}

module.exports = {
  getClient,
  sendLoginCode,
  verifyLogin,
  uploadVideo,
  streamRange,
  fetchThumbnail,
  buildMetadata,
  sendMetadata,
  editMetadata,
  readMetadataFromTelegram,
  syncMetadataToTelegram,
  refToBase64,
};
