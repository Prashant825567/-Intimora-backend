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

// ---- Channel helpers (3 separate channels) ----
function channelVideo() {
  const c = process.env.TELEGRAM_CHANNEL_VIDEO;
  if (!c) throw new Error("TELEGRAM_CHANNEL_VIDEO not set");
  return c;
}
function channelThumb() {
  const c = process.env.TELEGRAM_CHANNEL_THUMB;
  if (!c) throw new Error("TELEGRAM_CHANNEL_THUMB not set");
  return c;
}
function channelMeta() {
  const c = process.env.TELEGRAM_CHANNEL_META;
  if (!c) throw new Error("TELEGRAM_CHANNEL_META not set");
  return c;
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
  const channel = channelVideo();

  // 1) upload the video document (with thumbnail attached) — VIDEO channel
  const msg = await client.sendFile(channel, {
    file: filePath,
    caption: caption || "",
    forceDocument: true,
    thumb: thumbPath,
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

  // 2) upload the thumbnail as a separate photo — THUMBNAIL channel
  let thumbLoc = null;
  if (thumbPath) {
    const thumbChannel = channelThumb();
    const tmsg = await client.sendFile(thumbChannel, {
      file: thumbPath,
      forceDocument: false,
      workers: 2,
    });
    const photo = tmsg.photo;
    if (photo) {
      thumbLoc = {
        thumb_doc_id: String(photo.id),
        thumb_access_hash: String(photo.accessHash),
        thumb_file_ref: refToBase64(photo.fileReference),
        thumb_size: Number(photo.size),
        thumb_msg_id: tmsg.id,
      };
    }
  }

  return { ...videoLoc, ...thumbLoc };
}

// ================= UPLOAD THUMBNAIL (custom) =================
// Uploads a custom thumbnail image to the channel as a photo.
async function uploadThumbnail(imagePath) {
  const client = await getClient();
  const channel = channelThumb();

  const msg = await client.sendFile(channel, {
    file: imagePath,
    forceDocument: false,     // send as a photo
    workers: 2,
  });
  const photo = msg.photo;
  if (!photo) throw new Error("Telegram did not return a photo");
  return {
    thumb_doc_id: String(photo.id),
    thumb_access_hash: String(photo.accessHash),
    thumb_file_ref: refToBase64(photo.fileReference),
    thumb_size: Number(photo.size),
    thumb_msg_id: msg.id,
  };
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

function makePhotoLocation(docId, accessHash, fileRef, thumbSize = "") {
  return new Api.InputPhotoFileLocation({
    id: BigInt(docId),
    accessHash: BigInt(accessHash),
    fileReference: refFromBase64(fileRef),
    thumbSize,
  });
}

// Refresh expired file reference for a document (video)
async function refreshDocFileRef(docId, accessHash) {
  const client = await getClient();
  const doc = await client.invoke(new Api.messages.GetDocument({
    document: new Api.InputDocument({
      id: BigInt(docId),
      accessHash: BigInt(accessHash),
    }),
  }));
  return doc.document.fileReference;
}

// Refresh expired file reference for a photo (thumbnail)
async function refreshPhotoFileRef(photoId, accessHash) {
  const client = await getClient();
  const locations = await client.invoke(new Api.photos.GetPhotoFileLocations({
    id: new Api.InputPhoto({
      id: BigInt(photoId),
      accessHash: BigInt(accessHash),
    }),
  }));
  if (locations.locations && locations.locations.length > 0) {
    return locations.locations[0].fileReference;
  }
  return null;
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
  console.log(`[getFileChunk] offset=${offset} limit=${limit} bytes=${res.bytes ? res.bytes.length : 0}`);
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

  // Refresh expired file reference
  try {
    const freshRef = await refreshDocFileRef(video.tg_doc_id, video.tg_access_hash);
    if (freshRef) {
      video.tg_file_ref = refToBase64(freshRef);
      console.log("[streamRange] refreshed video file ref");
    }
  } catch (e) {
    console.log("[streamRange] file ref refresh failed:", e.message);
  }
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

  // Refresh expired file reference
  try {
    const freshRef = await refreshPhotoFileRef(video.thumb_doc_id, video.thumb_access_hash);
    if (freshRef) {
      video.thumb_file_ref = refToBase64(freshRef);
    }
  } catch (e) {
    console.log("[fetchThumbnail] file ref refresh failed:", e.message);
  }

  const loc = makePhotoLocation(video.thumb_doc_id, video.thumb_access_hash, video.thumb_file_ref, "");
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
    views: v.views || 0,
    likes: v.likes || 0,
    shares: v.shares || 0,
    likedBy: v.likedBy || [],
    duration: v.duration || 0,
    createdAt: v.created_at || Math.floor(Date.now() / 1000),
    video: {
      docId: v.tg_doc_id,
      accessHash: v.tg_access_hash,
      fileRef: v.tg_file_ref,
      size: v.tg_size,
      mime: v.tg_mime,
      msgId: v.tg_msg_id,
      filename: v.tg_filename || "video.mp4",
    },
    thumbnail: v.thumb_doc_id ? {
      docId: v.thumb_doc_id,
      accessHash: v.thumb_access_hash,
      fileRef: v.thumb_file_ref,
      size: v.thumb_size,
      msgId: v.thumb_msg_id || null,
    } : null,
  };
}

// Send metadata as a text message. Returns the Telegram message id.
async function sendMetadata(metadata) {
  const client = await getClient();
  const channel = channelMeta();
  const msg = await client.sendMessage(channel, { message: JSON.stringify(metadata) });
  return msg.id;
}

// Edit an existing metadata message with fresh data.
async function editMetadata(msgId, metadata) {
  const client = await getClient();
  const channel = channelMeta();
  await client.editMessage(channel, { message: msgId, text: JSON.stringify(metadata) });
}

// Read metadata messages from the META channel (for sync / rebuild).
// Returns array of { ...metadata, _msgId: Telegram message id }.
async function readMetadataFromTelegram(limit = 5000) {
  const client = await getClient();
  const channel = channelMeta();
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

// Find a specific video's metadata message by id. Scans messages for the matching JSON.
async function findVideoById(videoId) {
  const client = await getClient();
  const channel = channelMeta();
  for await (const msg of client.iterMessages(channel, { limit: 5000 })) {
    if (!msg.message) continue;
    try {
      const data = JSON.parse(msg.message);
      if (data && data.t === "meta" && data.id === videoId) {
        return { ...data, _msgId: msg.id };
      }
    } catch { /* skip non-JSON */ }
  }
  return null;
}

// Update stats on an existing metadata message (edit in place).
// `updates` is a partial object to merge into the metadata.
async function updateVideoStats(videoId, updates) {
  const msg = await findVideoById(videoId);
  if (!msg) return null;
  const data = { ...msg };
  Object.assign(data, updates);
  await editMetadata(msg._msgId, data);
  return data;
}

// Delete all 3 messages for a video from 3 separate channels.
async function deleteVideoMessages(videoId) {
  const client = await getClient();

  const msg = await findVideoById(videoId);
  if (!msg) return { deleted: false };

  const results = { deleted: true, channels: {} };

  // delete metadata from META channel
  try { await client.deleteMessages(channelMeta(), [msg._msgId]); results.channels.meta = true; } catch {}
  // delete video from VIDEO channel
  if (msg.video && msg.video.msgId) {
    try { await client.deleteMessages(channelVideo(), [msg.video.msgId]); results.channels.video = true; } catch {}
  }
  // delete thumbnail from THUMBNAIL channel
  if (msg.thumbnail && msg.thumbnail.msgId) {
    try { await client.deleteMessages(channelThumb(), [msg.thumbnail.msgId]); results.channels.thumb = true; } catch {}
  }

  return results;
}

// Get direct Telegram CDN URL for a video (for redirect streaming on serverless platforms).
// Requires TELEGRAM_CHANNEL_PUBLIC env var (the VIDEO channel's public username, e.g. "intimora_videos").
// Returns null if not set (fallback to server streaming).
function getDirectUrl(video) {
  const publicChannel = process.env.TELEGRAM_CHANNEL_PUBLIC;
  if (!publicChannel) return null;
  const filename = video.video?.filename || "video.mp4";
  const msgId = video.video?.msgId;
  if (!msgId) return null;
  return `https://t.me/${publicChannel}/${msgId}/${filename}`;
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
  uploadThumbnail,
  streamRange,
  fetchThumbnail,
  buildMetadata,
  sendMetadata,
  editMetadata,
  readMetadataFromTelegram,
  findVideoById,
  updateVideoStats,
  deleteVideoMessages,
  getDirectUrl,
  syncMetadataToTelegram,
  refToBase64,
};
