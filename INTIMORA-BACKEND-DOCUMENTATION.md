# Intimora Backend — Complete Code Documentation

> **Ye file pure workspace ke sab files ka documentation hai.**
> Har file ka purpose, description, aur full code ek jagah pe hai.
> Koi bhi AI ya developer is file se samajh sakta hai ki pura code kaam kaise karta hai.

---

## 📁 Table of Contents

### PART 1 — VERCEL (Node.js) BACKEND
1. [`backend/server.js`](#1-backendserverjs) — Express API server
2. [`backend/telegram.js`](#2-backendtelegramjs) — Telegram MTProto client
3. [`backend/store.js`](#3-backendstorejs) — Video metadata store (Telegram-based)
4. [`backend/users.js`](#4-backendusersjs) — User management (Telegram-based)

### PART 2 — PHP BACKEND (InfinityFree)
5. [`php-backend/config.php`](#5-php-backendconfigphp) — All configuration (hardcoded)
6. [`php-backend/mtproto.php`](#6-php-backendmtprotophp) — PHP MTProto client
7. [`php-backend/telegram.php`](#7-php-backendtelegramphp) — Telegram functions for PHP
8. [`php-backend/store.php`](#8-php-backendstorephp) — Telegram-based storage layer
9. [`php-backend/index.php`](#9-php-backendindexphp) — Main API router

### PART 3 — SHARED CONCEPTS
10. [Data Flow Diagram](#10-data-flow-diagram)
11. [Telegram Channels](#11-telegram-channels)
12. [API Endpoints (Both Backends)](#12-api-endpoints-both-backends)

---

# PART 1 — VERCEL (Node.js) BACKEND

---

## 1. `backend/server.js`

**Purpose:** Express API server — main entry point for Vercel/Netlify backend.

**Kaam:**
- Express server chalta hai
- Sare API routes define karta hai (videos, users, admin)
- CORS handle karta hai
- Firebase token verification karta hai
- Video streaming handle karta hai (HTTP Range + fast-start)
- Netlify serverless compatibility

**Key Features:**
- CORS middleware (specific origins allowed)
- Firebase Auth token verification via REST API
- Infinite scroll pagination for videos
- Video streaming with MTProto + HTTP Range support
- Fast-start optimization (sends moov atom first)
- Admin API with `x-api-key` auth
- Admin panel served at `/admin`

**Full Code:**
```javascript
// Express server — backend only. Reads data from Telegram, streams videos.
// Admin panel uploads directly via MTProto (browser), sends metadata here.
// Compatible with Netlify (serverless-http) and local (node functions/server.js).
const express = require("express");
const path = require("path");
const serverless = require("serverless-http");

const store = require("./store");
const tg = require("./telegram");
const users = require("./users");

// ---- Firebase Auth — token verification via REST API (no service account key needed) ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

async function verifyFirebaseToken(token) {
  if (!FIREBASE_API_KEY) throw new Error("FIREBASE_API_KEY not set");
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token, maxResults: 1 }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  if (!data.users || data.users.length === 0) throw new Error("Invalid token");
  return data.users[0];
}

// ---- Auth middleware — verify Firebase ID token ----
async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "No auth token" });
  }
  const token = header.split(" ")[1];
  try {
    const decoded = await verifyFirebaseToken(token);
    req.userId = decoded.localId;
    req.userEmail = decoded.email || "";
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- CORS middleware ----
const ALLOWED_ORIGINS = [
  "https://intimora.new.tg",
  "http://localhost:5173",
];
const vercelUrl = process.env.VERCEL_URL;
if (vercelUrl) ALLOWED_ORIGINS.push(`https://${vercelUrl}`);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes(origin.replace(/^https?:\/\//, 'https://')))) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-Range",
      "Access-Control-Max-Age": "86400",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag",
    });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---- Path normalization for Netlify serverless ----
app.use((req, res, next) => {
  if (req.url.startsWith('/.netlify/functions/api')) {
    req.url = req.url.replace(/^\/\.netlify\/functions\/api/, '/api');
  }
  next();
});

const PORT = parseInt(process.env.PORT, 10) || 10000;

function ok(res, data) { return res.json({ ok: true, data }); }
function fail(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

function publicVideo(v) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    exclusive: v.exclusive === true || v.exclusive === 'true',
    size: v.video?.size,
    mime: v.video?.mime,
    thumbSize: v.thumbnail?.size,
    duration: v.duration,
    views: v.views,
    likes: v.likes,
    shares: v.shares,
    createdAt: v.createdAt,
    streamUrl: `/api/videos/${v.id}/stream`,
    thumbnailUrl: `/api/videos/${v.id}/thumbnail`,
  };
}

function adminAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) return fail(res, "Unauthorized", 401);
  next();
}

// === PUBLIC API ===
app.get("/api/health", (req, res) => ok(res, { status: "up", time: Date.now() }));

app.get("/api/videos", async (req, res) => {
  try {
    const cursor = parseInt(req.query.cursor, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
    const metas = await store.listVideos(cursor, limit);
    const videos = metas.map(publicVideo);
    const nextCursor = videos.length ? metas[metas.length - 1].createdAt : null;
    ok(res, { videos, nextCursor });
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return ok(res, { videos: [], nextCursor: null });
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
    const metas = await store.searchVideos(q);
    ok(res, { videos: metas.slice(0, limit).map(publicVideo), nextCursor: null });
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/videos/:id", async (req, res) => {
  try {
    let v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    v = await store.incrementViews(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    ok(res, publicVideo(v));
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/videos/:id/thumbnail", async (req, res) => {
  try {
    const v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    const streamFormat = store.toStreamFormat(v);
    const img = await tg.fetchThumbnail(streamFormat);
    if (!img) return fail(res, "No thumbnail", 404);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(img);
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/videos/:id/stream", async (req, res) => {
  try {
    const v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    const streamFormat = store.toStreamFormat(v);
    const fileSize = streamFormat.tg_size;
    let start = 0, end = fileSize - 1, status = 200;

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) {
          start = parseInt(m[1], 10);
          end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
        } else if (m[2]) {
          const suffix = parseInt(m[2], 10);
          start = Math.max(0, fileSize - suffix);
          end = fileSize - 1;
        }
        end = Math.min(end, fileSize - 1);
        status = 206;
      }
    }
    if (start >= fileSize || start > end) {
      return res.status(416).set({
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
      }).json({ ok: false, error: "Range not satisfiable" });
    }

    // Fast-start optimization
    if (start === 0) {
      try {
        const moov = await tg.findMoovAtom(streamFormat);
        if (moov) {
          const ftypData = await tg.readFileRange(streamFormat, 0, 31);
          const totalBytes = ftypData.length + moov.data.length;
          res.status(206);
          res.set({
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": totalBytes,
            "Content-Range": `bytes 0-${totalBytes - 1}/${fileSize}`,
            "Cache-Control": "public, max-age=3600",
            "Vary": "Origin, Range",
            "Cross-Origin-Resource-Policy": "cross-origin",
          });
          res.write(ftypData);
          res.write(moov.data);
          return res.end();
        }
      } catch (e) {
        console.log("[fast-start] moov search failed:", e.message);
      }
    }

    res.status(status);
    res.set({
      "Content-Type": streamFormat.tg_mime || "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=3600",
      "Vary": "Origin, Range",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (status === 206) res.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

    for await (const chunk of tg.streamRange(streamFormat, start, end)) {
      if (!res.write(chunk)) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (e) {
    try { res.end(); } catch {}
    console.error("stream error:", e.message);
  }
});

app.post("/api/videos/:id/share", async (req, res) => {
  try {
    const v = await store.incrementShares(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    ok(res, { shares: v.shares });
  } catch (e) { fail(res, e.message, 500); }
});

// === USER SYSTEM ===
app.post("/api/auth/verify", auth, async (req, res) => {
  try {
    const user = await users.findByUid(req.userId);
    if (!user) {
      return ok(res, { exists: false, email: req.userEmail, uid: req.userId });
    }
    ok(res, { exists: true, user });
  } catch (e) { fail(res, e.message, 500); }
});

app.post("/api/auth/profile", auth, async (req, res) => {
  try {
    const { name, username, referralCode, avatar } = req.body;
    if (!name || !username) return fail(res, "Name and username required", 400);
    const existing = await users.findByUid(req.userId);
    if (existing) return fail(res, "User already exists", 400);
    const usernameTaken = await users.findByUsername(username);
    if (usernameTaken) return fail(res, "Username already exists", 400);
    let referredBy = "";
    if (referralCode && referralCode.trim()) {
      const referrer = await users.findByReferralCode(referralCode.trim());
      if (!referrer) return fail(res, "Invalid referral code", 400);
      referredBy = referrer.referralCode;
    }
    const user = await users.createUser({
      email: req.userEmail, name, username, uid: req.userId, avatar: avatar || "", referredBy,
    });
    ok(res, { user: { id: user.id, name: user.name, username: user.username, referralCode: user.referralCode } });
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const user = await users.findByUid(req.userId);
    if (!user) return fail(res, "User not found", 404);
    ok(res, { user });
  } catch (e) { fail(res, e.message, 500); }
});

app.post("/api/videos/:id/like", auth, async (req, res) => {
  try {
    const result = await users.toggleLike(req.userId, req.params.id);
    if (!result) return fail(res, "User not found", 404);
    ok(res, result);
  } catch (e) { fail(res, e.message, 500); }
});

app.post("/api/videos/:id/save", auth, async (req, res) => {
  try {
    const result = await users.toggleSave(req.userId, req.params.id);
    if (!result) return fail(res, "User not found", 404);
    ok(res, result);
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/user/liked", auth, async (req, res) => {
  try {
    const likedIds = await users.getLikedVideos(req.userId);
    if (!likedIds) return fail(res, "User not found", 404);
    const videos = [];
    for (const id of likedIds) {
      const v = await store.getVideo(id);
      if (v) videos.push(v);
    }
    ok(res, { videos });
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/user/saved", auth, async (req, res) => {
  try {
    const savedIds = await users.getSavedVideos(req.userId);
    if (!savedIds) return fail(res, "User not found", 404);
    const videos = [];
    for (const id of savedIds) {
      const v = await store.getVideo(id);
      if (v) videos.push(v);
    }
    ok(res, { videos });
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/api/user/referrals", auth, async (req, res) => {
  try {
    const tree = await users.getReferralTree(req.userId);
    if (!tree) return fail(res, "User not found", 404);
    ok(res, { tree });
  } catch (e) { fail(res, e.message, 500); }
});

// === ADMIN API ===
app.post("/api/admin/metadata", adminAuth, async (req, res) => {
  try {
    const metadata = req.body;
    if (!metadata || !metadata.id || !metadata.video) {
      return fail(res, "Missing required fields (id, video)");
    }
    const normalized = {
      t: "meta",
      id: metadata.id,
      title: metadata.title || "Untitled",
      description: (metadata.description || "").slice(0, 1000),
      views: metadata.views || 0,
      likes: metadata.likes || 0,
      shares: metadata.shares || 0,
      likedBy: metadata.likedBy || [],
      duration: metadata.duration || 0,
      createdAt: metadata.createdAt || Math.floor(Date.now() / 1000),
      video: {
        docId: metadata.video.tg_doc_id || metadata.video.docId,
        accessHash: metadata.video.tg_access_hash || metadata.video.accessHash,
        fileRef: metadata.video.tg_file_ref || metadata.video.fileRef,
        size: metadata.video.tg_size || metadata.video.size,
        mime: metadata.video.tg_mime || metadata.video.mime || "video/mp4",
        msgId: metadata.video.tg_msg_id || metadata.video.msgId,
        filename: metadata.video.tg_filename || metadata.video.filename || "video.mp4",
      },
      thumbnail: metadata.thumbnail ? {
        docId: metadata.thumbnail.thumb_doc_id || metadata.thumbnail.docId,
        accessHash: metadata.thumbnail.thumb_access_hash || metadata.thumbnail.accessHash,
        fileRef: metadata.thumbnail.thumb_file_ref || metadata.thumbnail.fileRef,
        size: metadata.thumbnail.thumb_size || metadata.thumbnail.size,
        msgId: metadata.thumbnail.thumb_msg_id || metadata.thumbnail.msgId,
      } : null,
    };
    const metaMsgId = await tg.sendMetadata(normalized);
    ok(res, { id: metadata.id, meta_msg_id: metaMsgId });
  } catch (e) {
    console.error("metadata save error:", e);
    fail(res, e.message || "Failed to save metadata", 500);
  }
});

app.get("/api/admin/videos", adminAuth, async (req, res) => {
  try {
    const metas = await store.listAllVideos();
    ok(res, metas.map(publicVideo));
  } catch (e) { fail(res, e.message, 500); }
});

app.post("/api/admin/videos/:id/delete", adminAuth, async (req, res) => {
  try {
    const result = await store.deleteVideo(req.params.id);
    if (!result.deleted) return fail(res, "Video not found", 404);
    ok(res, { deleted: true });
  } catch (e) { fail(res, e.message, 500); }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

module.exports = app;
module.exports.handler = serverless(app);

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend running on port ${PORT}`);
  });
}
```

---

## 2. `backend/telegram.js`

**Purpose:** Telegram MTProto client — direct communication with Telegram API.

**Kaam:**
- `teleproto` library use karta hai (MTProto, Bot API nahi)
- Telegram client ko manage karta hai (connect, disconnect, session)
- Concurrent session lock (`_clientLock`) — multi-request safety
- Video upload to Telegram channel (as document — no compression)
- Thumbnail upload to separate channel
- HTTP Range streaming (512KB parts, parallel download)
- Fast-start optimization (moov atom finder)
- Metadata storage in Telegram (JSON text messages)
- Login flow (send code, verify code, 2FA support)

**Key Features:**
- **512KB part size** — Telegram's GetFile limit
- **Parallel chunk download** — 8 chunks at a time (4MB in flight)
- **File reference refresh** — auto-refresh expired file refs
- **3 separate channels** — Video, Thumbnail, Meta (independent storage)
- **Concurrent lock** — prevents "Concurrent usage" error from Telegram

**Full Code:**
```javascript
// Telegram MTProto storage layer (teleproto)
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
function channelUsers() {
  const c = process.env.TELEGRAM_CHANNEL_USERS;
  if (!c) throw new Error("TELEGRAM_CHANNEL_USERS not set");
  return c;
}
function channelReferrals() {
  const c = process.env.TELEGRAM_CHANNEL_REFERRALS;
  if (!c) throw new Error("TELEGRAM_CHANNEL_REFERRALS not set");
  return c;
}

let _clientLock = Promise.resolve();
async function getClient() {
  if (_client && _client.isConnected && _client.isConnected()) return _client;
  const prevLock = _clientLock;
  let resolveLock;
  _clientLock = new Promise((r) => { resolveLock = r; });
  try {
    await prevLock;
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
  } finally {
    resolveLock();
  }
}

async function sendLoginCode(phoneNumber) {
  const { apiId, apiHash } = cfg();
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  await client.connect();
  await client.invoke(new Api.auth.SendCode({ phoneNumber, settings: new Api.CodeSettings() }));
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

function refToBase64(ref) {
  if (!ref) return "";
  if (Buffer.isBuffer(ref)) return ref.toString("base64");
  if (typeof ref === "string") return ref;
  return Buffer.from(ref).toString("base64");
}
function refFromBase64(b64) {
  return Buffer.from(b64 || "", "base64");
}

async function uploadVideo(filePath, { caption, thumbPath }) {
  const client = await getClient();
  const channel = channelVideo();
  const msg = await client.sendFile(channel, {
    file: filePath, caption: caption || "", forceDocument: true, thumb: thumbPath, workers: 4,
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
  let thumbLoc = null;
  if (thumbPath) {
    const thumbChannel = channelThumb();
    const tmsg = await client.sendFile(thumbChannel, { file: thumbPath, forceDocument: false, workers: 2 });
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

async function uploadThumbnail(imagePath) {
  const client = await getClient();
  const channel = channelThumb();
  const msg = await client.sendFile(channel, { file: imagePath, forceDocument: false, workers: 2 });
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

const PART = 512 * 1024; // 512 KB — Telegram's actual part size & GetFile limit

function makeDocLocation(docId, accessHash, fileRef, thumbSize = "") {
  return new Api.InputDocumentFileLocation({
    id: BigInt(docId), accessHash: BigInt(accessHash), fileReference: refFromBase64(fileRef), thumbSize,
  });
}
function makePhotoLocation(docId, accessHash, fileRef, thumbSize = "") {
  return new Api.InputPhotoFileLocation({
    id: BigInt(docId), accessHash: BigInt(accessHash), fileReference: refFromBase64(fileRef), thumbSize,
  });
}

async function refreshDocFileRef(docId, accessHash) {
  const client = await getClient();
  const doc = await client.invoke(new Api.messages.GetDocument({
    document: new Api.InputDocument({ id: BigInt(docId), accessHash: BigInt(accessHash) }),
  }));
  return doc.document.fileReference;
}

async function refreshPhotoFileRef(photoId, accessHash, fileRef) {
  const client = await getClient();
  const locations = await client.invoke(new Api.photos.GetPhotoFileLocations({
    id: new Api.InputPhoto({ id: BigInt(photoId), accessHash: BigInt(accessHash), fileReference: refFromBase64(fileRef) }),
  }));
  if (locations.locations && locations.locations.length > 0) {
    return locations.locations[0].fileReference;
  }
  return null;
}

async function getFileChunk(client, video, offset, limit) {
  const res = await client.invoke(new Api.upload.GetFile({
    location: makeDocLocation(video.tg_doc_id, video.tg_access_hash, video.tg_file_ref, ""),
    offset: BigInt(offset), limit, precise: false, cdnSupported: false,
  }));
  return res.bytes || Buffer.alloc(0);
}

async function* streamRange(video, start, end) {
  const client = await getClient();
  const fileSize = video.tg_size;
  if (start >= fileSize) return;
  end = Math.min(end, fileSize - 1);

  if (fileSize < 50 * 1024 * 1024 && video.tg_msg_id) {
    try {
      const videoChannel = channelVideo();
      const messages = await client.getMessages(videoChannel, { ids: [video.tg_msg_id] });
      if (messages && messages.length > 0) {
        const msg = messages[0];
        const bytes = await client.downloadMedia(msg, { outputFile: null });
        if (bytes && bytes.length > 0) {
          const chunk = bytes.subarray(start, end + 1);
          yield chunk;
          return;
        }
      }
    } catch (e) { console.log("[streamRange] downloadMedia failed:", e.message); }
  }

  try {
    const freshRef = await refreshDocFileRef(video.tg_doc_id, video.tg_access_hash);
    if (freshRef) { video.tg_file_ref = refToBase64(freshRef); }
  } catch (e) { console.log("[streamRange] file ref refresh failed:", e.message); }

  const alignedStart = Math.floor(start / PART) * PART;
  const alignedEnd = Math.min(Math.ceil((end + 1) / PART) * PART - 1, Math.ceil(fileSize / PART) * PART - 1);
  let headDiscard = start - alignedStart;

  const parts = [];
  for (let offset = alignedStart; offset <= alignedEnd; offset += PART) {
    parts.push({ offset, limit: PART });
  }

  const POOL = 8;
  let results = [];
  let bytesRemaining = end - start + 1;

  for (let i = 0; i < parts.length; i += POOL) {
    const batch = parts.slice(i, i + POOL);
    const batchResults = await Promise.all(batch.map((p) => getFileChunk(client, video, p.offset, p.limit)));
    results = results.concat(batchResults);

    for (let j = 0; j < results.length; j++) {
      let bytes = results[j];
      if (bytes.length < PART && bytes.length === 0) continue;
      if (headDiscard > 0) {
        const skip = Math.min(headDiscard, bytes.length);
        bytes = bytes.subarray(skip);
        headDiscard -= skip;
      }
      if (bytes.length > bytesRemaining) {
        bytes = bytes.subarray(0, bytesRemaining);
      }
      if (bytes.length > 0) {
        bytesRemaining -= bytes.length;
        yield bytes;
      }
      if (bytesRemaining <= 0) break;
    }
    if (bytesRemaining <= 0) break;
    results = [];
  }
}

async function findMoovAtom(video) {
  const client = await getClient();
  const fileSize = video.tg_size;
  const numParts = 4;
  const alignedStart = Math.floor(Math.max(0, fileSize - numParts * PART) / PART) * PART;
  const promises = [];
  for (let offset = alignedStart; offset < fileSize; offset += PART) {
    const limit = Math.min(PART, fileSize - offset);
    promises.push(getFileChunk(client, video, offset, limit));
  }
  const parts = await Promise.all(promises);
  const combined = Buffer.concat(parts);
  let offset = 0;
  while (offset < combined.length - 8) {
    try {
      const size = combined.readUInt32BE(offset);
      const type = combined.toString("ascii", offset + 4, offset + 8);
      if (type === "moov") {
        return { offset: alignedStart + offset, size: size, data: combined.subarray(offset, offset + size) };
      }
      if (size === 0 || size < 8) break;
      offset += size;
    } catch { break; }
  }
  return null;
}

async function readFileRange(video, start, end) {
  const client = await getClient();
  const alignedStart = Math.floor(start / PART) * PART;
  const limit = Math.min(PART, end - alignedStart + 1);
  const bytes = await getFileChunk(client, video, alignedStart, limit);
  let headDiscard = start - alignedStart;
  let result = bytes.subarray(headDiscard);
  const neededEnd = end - alignedStart;
  if (neededEnd < result.length) {
    result = result.subarray(0, neededEnd + 1);
  }
  return result;
}

async function fetchThumbnail(video) {
  if (!video.thumb_msg_id) {
    if (!video.thumb_doc_id) return null;
    const client = await getClient();
    try {
      const freshRef = await refreshPhotoFileRef(video.thumb_doc_id, video.thumb_access_hash, video.thumb_file_ref);
      if (freshRef) video.thumb_file_ref = refToBase64(freshRef);
    } catch {}
    try {
      const loc = makePhotoLocation(video.thumb_doc_id, video.thumb_access_hash, video.thumb_file_ref, "");
      const res = await client.invoke(new Api.upload.GetFile({ location: loc, offset: BigInt(0), limit: PART, precise: false, cdnSupported: false }));
      return res.bytes || null;
    } catch {}
    return null;
  }
  const client = await getClient();
  const thumbChannel = channelThumb();
  try {
    const messages = await client.getMessages(thumbChannel, { ids: [video.thumb_msg_id] });
    if (!messages || messages.length === 0) return null;
    const msg = messages[0];
    const bytes = await client.downloadMedia(msg, { outputFile: null });
    return bytes || null;
  } catch (e) {
    console.log("[fetchThumbnail] downloadMedia failed:", e.message);
    return null;
  }
}

function buildMetadata(v) {
  return {
    t: "meta", id: v.id, title: v.title,
    description: (v.description || "").slice(0, 1000),
    views: v.views || 0, likes: v.likes || 0, shares: v.shares || 0,
    likedBy: v.likedBy || [], duration: v.duration || 0,
    createdAt: v.created_at || Math.floor(Date.now() / 1000),
    video: {
      docId: v.tg_doc_id, accessHash: v.tg_access_hash, fileRef: v.tg_file_ref,
      size: v.tg_size, mime: v.tg_mime, msgId: v.tg_msg_id,
      filename: v.tg_filename || "video.mp4",
    },
    thumbnail: v.thumb_doc_id ? {
      docId: v.thumb_doc_id, accessHash: v.thumb_access_hash, fileRef: v.thumb_file_ref,
      size: v.thumb_size, msgId: v.thumb_msg_id || null,
    } : null,
  };
}

async function sendMetadata(metadata) {
  const client = await getClient();
  const channel = channelMeta();
  const msg = await client.sendMessage(channel, { message: JSON.stringify(metadata) });
  return msg.id;
}

async function editMetadata(msgId, metadata) {
  const client = await getClient();
  const channel = channelMeta();
  await client.editMessage(channel, { message: msgId, text: JSON.stringify(metadata) });
}

async function readMetadataFromTelegram(limit = 5000) {
  const client = await getClient();
  const channel = channelMeta();
  const result = [];
  for await (const msg of client.iterMessages(channel, { limit })) {
    let data = null;
    if (msg.message) { try { data = JSON.parse(msg.message); } catch {} }
    if (!data && msg.document && msg.document.fileName && msg.document.fileName.endsWith(".json")) {
      try {
        const bytes = await client.downloadMedia(msg);
        data = JSON.parse(bytes.toString("utf-8"));
      } catch (e) { console.error(`readMetadataFromTelegram: failed to read JSON file from msg ${msg.id}:`, e.message); }
    }
    if (data && data.t === "meta") {
      result.push({ ...data, _msgId: msg.id });
    }
  }
  return result;
}

async function findVideoById(videoId) {
  const client = await getClient();
  const channel = channelMeta();
  for await (const msg of client.iterMessages(channel, { limit: 5000 })) {
    let data = null;
    if (msg.message) { try { data = JSON.parse(msg.message); } catch {} }
    if (!data && msg.document && msg.document.fileName && msg.document.fileName.endsWith(".json")) {
      try {
        const bytes = await client.downloadMedia(msg);
        data = JSON.parse(bytes.toString("utf-8"));
      } catch {}
    }
    if (data && data.t === "meta" && data.id === videoId) {
      return { ...data, _msgId: msg.id };
    }
  }
  return null;
}

async function updateVideoStats(videoId, updates) {
  const msg = await findVideoById(videoId);
  if (!msg) return null;
  const data = { ...msg };
  Object.assign(data, updates);
  await editMetadata(msg._msgId, data);
  return data;
}

async function deleteVideoMessages(videoId) {
  const client = await getClient();
  const msg = await findVideoById(videoId);
  if (!msg) return { deleted: false };
  const results = { deleted: true, channels: {} };
  try { await client.deleteMessages(channelMeta(), [msg._msgId]); results.channels.meta = true; } catch {}
  if (msg.video && msg.video.msgId) {
    try { await client.deleteMessages(channelVideo(), [msg.video.msgId]); results.channels.video = true; } catch {}
  }
  if (msg.thumbnail && msg.thumbnail.msgId) {
    try { await client.deleteMessages(channelThumb(), [msg.thumbnail.msgId]); results.channels.thumb = true; } catch {}
  }
  return results;
}

async function sendMessage(channel, text) {
  const client = await getClient();
  const msg = await client.sendMessage(channel, { message: text, parseMode: false });
  return msg.id;
}

async function editMessage(channel, msgId, text) {
  const client = await getClient();
  await client.editMessage(channel, { message: msgId, text, parseMode: false });
}

async function readMessages(channel, limit = 5000) {
  const client = await getClient();
  const result = [];
  for await (const msg of client.iterMessages(channel, { limit })) {
    if (msg.message) { result.push({ id: msg.id, text: msg.message }); }
  }
  return result;
}

module.exports = {
  getClient, sendLoginCode, verifyLogin, uploadVideo, uploadThumbnail,
  streamRange, findMoovAtom, readFileRange, fetchThumbnail, buildMetadata,
  sendMetadata, editMetadata, readMetadataFromTelegram, findVideoById,
  updateVideoStats, deleteVideoMessages, channelUsers, channelReferrals,
  sendMessage, editMessage, readMessages,
};
```

---

## 3. `backend/store.js`

**Purpose:** Video metadata store — all data in Telegram (no database).

**Kaam:**
- Video metadata ko Telegram se read/write karta hai
- Infinite scroll pagination
- Video search by title
- View/like/share count increment
- Delete video (deletes all 3 messages from 3 channels)
- Stream format conversion (for telegram.js functions)

**Key Features:**
- **No database** — all data in Telegram JSON messages
- Metadata stored as text messages in Meta channel
- Sort by `createdAt` descending
- Cursor-based pagination for infinite scroll

**Full Code:**
```javascript
// Telegram-based data store — replaces SQLite entirely.
const tg = require("./telegram");

function newId() { return require("crypto").randomUUID(); }

function toStreamFormat(m) {
  return {
    tg_doc_id: m.video.docId || m.video.tg_doc_id,
    tg_access_hash: m.video.accessHash || m.video.tg_access_hash,
    tg_file_ref: m.video.fileRef || m.video.tg_file_ref,
    tg_size: m.video.size || m.video.tg_size,
    tg_mime: m.video.mime || m.video.tg_mime || "",
    tg_msg_id: m.video.msgId || m.video.tg_msg_id,
    thumb_doc_id: m.thumbnail ? (m.thumbnail.docId || m.thumbnail.thumb_doc_id) : "",
    thumb_access_hash: m.thumbnail ? (m.thumbnail.accessHash || m.thumbnail.thumb_access_hash) : "",
    thumb_file_ref: m.thumbnail ? (m.thumbnail.fileRef || m.thumbnail.thumb_file_ref) : "",
    thumb_size: m.thumbnail ? (m.thumbnail.size || m.thumbnail.thumb_size) : 0,
    thumb_msg_id: m.thumbnail ? (m.thumbnail.msgId || m.thumbnail.thumb_msg_id) : null,
  };
}

async function listVideos(cursor, limit = 12) {
  const metas = await tg.readMetadataFromTelegram(5000);
  metas.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (cursor) {
    const idx = metas.findIndex(m => (m.createdAt || 0) <= cursor);
    const start = idx === -1 ? 0 : idx;
    return metas.slice(start, start + limit);
  }
  return metas.slice(0, limit);
}

async function getVideo(id) { return await tg.findVideoById(id); }

async function searchVideos(query) {
  const metas = await tg.readMetadataFromTelegram(5000);
  const q = query.toLowerCase().trim();
  return metas.filter(m => (m.title || "").toLowerCase().includes(q));
}

async function addVideo(data) {
  const metadata = tg.buildMetadata(data);
  const msgId = await tg.sendMetadata(metadata);
  return { ...metadata, meta_msg_id: msgId };
}

async function incrementViews(id) {
  const v = await tg.findVideoById(id);
  if (!v) return null;
  return await tg.updateVideoStats(id, { views: (v.views || 0) + 1 });
}

async function toggleLike(id, userId) {
  const v = await tg.findVideoById(id);
  if (!v) return null;
  const likedBy = v.likedBy || [];
  if (likedBy.includes(userId)) {
    const result = await tg.updateVideoStats(id, {
      likedBy: likedBy.filter(u => u !== userId),
      likes: Math.max(0, (v.likes || 0) - 1),
    });
    return { liked: false, likes: result.likes };
  } else {
    const result = await tg.updateVideoStats(id, {
      likedBy: [...likedBy, userId],
      likes: (v.likes || 0) + 1,
    });
    return { liked: true, likes: result.likes };
  }
}

async function incrementShares(id) {
  const v = await tg.findVideoById(id);
  if (!v) return null;
  return await tg.updateVideoStats(id, { shares: (v.shares || 0) + 1 });
}

async function deleteVideo(id) { return await tg.deleteVideoMessages(id); }

async function listAllVideos() {
  const metas = await tg.readMetadataFromTelegram(5000);
  metas.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return metas;
}

module.exports = {
  newId, toStreamFormat, listVideos, getVideo, searchVideos,
  addVideo, incrementViews, toggleLike, incrementShares, deleteVideo, listAllVideos,
};
```

---

## 4. `backend/users.js`

**Purpose:** User management — all data in Telegram channels.

**Kaam:**
- User creation, update, find (by email/uid/username/referralCode)
- Like/save toggle for videos
- Referral system (generate code, track referrals, build referral tree)
- In-memory cache (60 second TTL) for performance
- All user data in Telegram Users channel
- Referral links in Telegram Referrals channel

**Key Features:**
- **60-second cache** — fast user lookups
- Referral tree (2 levels — direct + level2)
- Auto-generate referral code (`REF-XXXXXX`)
- Like/save stored in user's JSON message

**Full Code:**
```javascript
// User management — all data stored in Telegram channels
const tg = require("./telegram");

function generateReferralCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return "REF-" + code;
}

let usersCache = null;
let usersCacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

async function readUsers() {
  if (usersCache && (Date.now() - usersCacheTime) < CACHE_TTL) {
    return usersCache;
  }
  const messages = await tg.readMessages(tg.channelUsers(), 5000);
  usersCache = messages
    .map((m) => {
      try {
        const user = JSON.parse(m.text);
        user._msgId = m.id;
        return user;
      } catch { return null; }
    })
    .filter((u) => u && u.t === "user");
  usersCacheTime = Date.now();
  return usersCache;
}

function invalidateCache() { usersCache = null; usersCacheTime = 0; }

async function readReferrals() {
  const messages = await tg.readMessages(tg.channelReferrals(), 5000);
  return messages
    .map((m) => { try { return JSON.parse(m.text); } catch { return null; } })
    .filter((r) => r && r.t === "ref");
}

async function findByEmail(email) {
  const users = await readUsers();
  return users.find((u) => u.email === email);
}
async function findByUid(uid) {
  const users = await readUsers();
  return users.find((u) => u.uid === uid);
}
async function findByUsername(username) {
  const users = await readUsers();
  return users.find((u) => u.username === username);
}
async function findByReferralCode(code) {
  const users = await readUsers();
  return users.find((u) => u.referralCode === code);
}

async function createUser({ email, name, username, uid, avatar, referredBy }) {
  const user = {
    t: "user", email, name, username, uid,
    referralCode: generateReferralCode(),
    referredBy: referredBy || "",
    likedVideos: [], savedVideos: [],
    avatar: avatar || "",
    createdAt: Math.floor(Date.now() / 1000),
  };
  await tg.sendMessage(tg.channelUsers(), JSON.stringify(user));
  if (referredBy) {
    const ref = {
      t: "ref", ownerCode: referredBy, referredCode: user.referralCode,
      timestamp: Math.floor(Date.now() / 1000),
    };
    await tg.sendMessage(tg.channelReferrals(), JSON.stringify(ref));
  }
  invalidateCache();
  return user;
}

async function updateUser(uid, updates) {
  const user = await findByUid(uid);
  if (!user) return null;
  Object.assign(user, updates);
  await tg.editMessage(tg.channelUsers(), user._msgId, JSON.stringify(user));
  invalidateCache();
  return user;
}

async function toggleLike(uid, videoId) {
  const user = await findByUid(uid);
  if (!user) return null;
  const liked = user.likedVideos || [];
  const idx = liked.indexOf(videoId);
  if (idx >= 0) { liked.splice(idx, 1); } else { liked.push(videoId); }
  user.likedVideos = liked;
  await tg.editMessage(tg.channelUsers(), user._msgId, JSON.stringify(user));
  usersCacheTime = Date.now();
  return { liked: idx === -1, likedVideos: liked };
}

async function toggleSave(uid, videoId) {
  const user = await findByUid(uid);
  if (!user) return null;
  const saved = user.savedVideos || [];
  const idx = saved.indexOf(videoId);
  if (idx >= 0) { saved.splice(idx, 1); } else { saved.push(videoId); }
  user.savedVideos = saved;
  await tg.editMessage(tg.channelUsers(), user._msgId, JSON.stringify(user));
  usersCacheTime = Date.now();
  return { saved: idx === -1, savedVideos: saved };
}

async function getReferralTree(uid) {
  const user = await findByUid(uid);
  if (!user) return null;
  const allReferrals = await readReferrals();
  const myCode = user.referralCode;
  const direct = allReferrals.filter((r) => r.ownerCode === myCode);
  const directCodes = direct.map((r) => r.referredCode);
  const level2 = allReferrals.filter((r) => directCodes.includes(r.ownerCode));
  const users = await readUsers();
  const userMap = {};
  users.forEach((u) => { userMap[u.referralCode] = u; });
  const formatUser = (u) => ({
    email: u.email || '', firebaseUid: u.uid || '',
    name: u.name || '', username: u.username || '',
    avatar: u.avatar || '', referralCode: u.referralCode || '',
    likedVideos: u.likedVideos || [], savedVideos: u.savedVideos || [],
    createdAt: u.createdAt || 0,
  });
  return {
    code: myCode,
    direct: direct.map((r) => formatUser(userMap[r.referredCode])).filter(Boolean),
    level2: level2.map((r) => formatUser(userMap[r.referredCode])).filter(Boolean),
  };
}

async function getLikedVideos(uid) {
  const user = await findByUid(uid);
  if (!user) return null;
  return user.likedVideos || [];
}

async function getSavedVideos(uid) {
  const user = await findByUid(uid);
  if (!user) return null;
  return user.savedVideos || [];
}

module.exports = {
  generateReferralCode, readUsers, readReferrals,
  findByEmail, findByUid, findByUsername, findByReferralCode,
  createUser, updateUser, toggleLike, toggleSave,
  getReferralTree, getLikedVideos, getSavedVideos,
};
```

---

# PART 2 — PHP BACKEND (InfinityFree)

---

## 5. `php-backend/config.php`

**Purpose:** Configuration file — ALL values hardcoded (no env file needed).

**Kaam:**
- Telegram API credentials (api_id, api_hash, session)
- All 5 Telegram channel IDs
- MySQL credentials (InfinityFree)
- Firebase API key + auth domain
- Admin API key
- Site URL
- Cache directory (sys_get_temp_dir — no mkdir)
- FFmpeg/FFprobe paths

**Key Points:**
- **ZERO setup required** — upload and go
- Cache uses `sys_get_temp_dir()` — no `mkdir()` calls (InfinityFree restriction)
- MySQL is for DB credentials only — NO data stored in MySQL

**Full Code:**
```php
<?php
// Intimora PHP Backend — Configuration (ALL VALUES HARDCODED)
// Nothing to set — just upload and go!

// === Telegram MTProto ===
define('TG_API_ID', '37144075');
define('TG_API_HASH', '57a11adf8679a2e7a2b6184ed7bb9c70');
define('TELEGRAM_SESSION', '1BQANOTEuMTA4LjU2LjExNwG7xI2giu7fxyG7MsovMdZ20Gtnox2LmhxA8ZmmOtQKw7imL0mBZ4e2bG7Dd3a0s3bqWYVqLzizh7e2kWCFaV8pT5HPR5wEOuPNfxLLCL3Gjsiw/qNRV8DiPMmXWEGMoncujjEz0isNOucrrJdk9ZUyB0EFGHiX4xCyiAs9WfjJ5U8zigz847ET50CsEQS2EmVOYxhkvyyWN9st8uEQ42awadLj6RgDyetXpXuZi/ajSro1ROxAmQriNx+N42e6xhy+dvHFcAPv4BSFGgA3UP3UMTwOR7ZNYNIFX6gUpqmgnnWfcPF0Y3vCLAdcYRPArrsVjCzSprDsGCBVHyTI+Wl97w==');

// === Telegram Channels ===
define('TG_CHANNEL_VIDEO', '-1003756299546');
define('TG_CHANNEL_THUMB', '-1004360811639');
define('TG_CHANNEL_META', '-1003777974779');
define('TG_CHANNEL_USERS', '-1004368963146');
define('TG_CHANNEL_REFERRALS', '-1004451213988');

// === MySQL (EDIT THESE 2 VALUES ONLY) ===
define('DB_HOST', 'localhost');
define('DB_NAME', 'intimora');
define('DB_USER', 'if0_43413402');
define('DB_PASS', 'jGuhBV4XZ5');

// === Firebase ===
define('FIREBASE_API_KEY', 'AIzaSyD91f9kLylYXZnZjPSZOfjk1HFJ0Y-v7Yo');
define('FIREBASE_AUTH_DOMAIN', 'intimora-app.firebaseapp.com');

// === Admin ===
define('ADMIN_API_KEY', 'Prashant');

// === Site ===
define('SITE_URL', 'https://intimora-api2.site.je');

// === Cache ===
// NO mkdir() — InfinityFree only allows directory creation in htdocs
$cacheDir = sys_get_temp_dir() . '/intimora_cache';
if (!is_dir($cacheDir)) {
    $cacheDir = sys_get_temp_dir();
}

// === FFmpeg (InfinityFree does NOT have ffmpeg — will be skipped) ===
define('FFMPEG_PATH', '/usr/bin/ffmpeg');
define('FFPROBE_PATH', '/usr/bin/ffprobe');
```

---

## 6. `php-backend/mtproto.php`

**Purpose:** PHP MTProto client — MadelineProto 8.x wrapper with async support.

**Kaam:**
- MadelineProto 8.x `Factory::create()` use karta hai
- `Revolt\EventLoop` se async code synchronously run karta hai
- `await_promise()` helper — async Promise ko sync resolve karta hai
- MTProto client ko manage karta hai (connect, invoke, disconnect)
- MTProto functions (get_history, get_file, read_file_range, upload_video)
- `mtproto_test_connection()` — debug/test function

**Key Points:**
- **MadelineProto 8.x is fully async** — uses PHP fibers
- `Amp\Promise\wait()` removed in amphp v3.x — `Revolt\EventLoop` use karna hai
- `Factory::create()` is synchronous — blocks until connected
- `invoke()` returns a Promise — `await_promise()` se resolve karna hai

**Full Code:**
```php
<?php
// Intimora PHP Backend — MTProto Client (MadelineProto 8.x — Async)
// Uses Revolt\EventLoop to run async code synchronously

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/vendor/autoload.php';

/**
 * Helper: Await a Promise synchronously using Revolt Event Loop
 * Replaces Amp\Promise\wait() which is removed in amphp v3.x
 */
function await_promise($promise) {
    $result = null;
    $exception = null;
    $loop = \Revolt\EventLoop::getLoop();
    $loop->run(function () use (&$result, &$exception, $promise) {
        try {
            $result = yield $promise;
        } catch (\Throwable $e) {
            $exception = $e;
        }
    });
    if ($exception) throw $exception;
    return $result;
}

class MTProtoClient {
    private $apiId;
    private $apiHash;
    private $session;
    private $client = null;

    public function __construct($apiId, $apiHash, $session) {
        $this->apiId = $apiId;
        $this->apiHash = $apiHash;
        $this->session = $session;
    }

    public function connect() {
        if ($this->client !== null) return;
        try {
            $this->client = \danog\MadelineProto\Factory::create([
                'api_id' => $this->apiId,
                'api_hash' => $this->apiHash,
                'session' => $this->session,
                'connection_settings' => [
                    'connection_retries' => 5,
                    'connection_timeout' => 10,
                ],
            ]);
        } catch (\Throwable $e) {
            error_log("MTProto connect error: " . $e->getMessage());
            throw $e;
        }
    }

    public function isConnected() { return $this->client !== null; }

    public function invoke($request) {
        if (!$this->client) throw new Exception('Client not connected');
        return await_promise($this->client->invoke($request));
    }

    public function getInputEntity($channel) {
        if (!$this->client) throw new Exception('Client not connected');
        return await_promise($this->client->users->getInputEntity($channel));
    }

    public function uploadMedia($filePath, $thumb = null) {
        if (!$this->client) throw new Exception('Client not connected');
        return await_promise($this->client->messages->uploadMedia([
            'file' => $filePath, 'thumb' => $thumb,
        ]));
    }

    public function getRawClient() { return $this->client; }

    public function disconnect() {
        if ($this->client) {
            try { await_promise($this->client->disconnect()); } catch (\Throwable $e) {}
            $this->client = null;
        }
    }
}

// === MTProto Functions ===
$mtprotoClient = null;

function mtproto() {
    global $mtprotoClient;
    if ($mtprotoClient === null) {
        $mtprotoClient = new MTProtoClient(TG_API_ID, TG_API_HASH, TELEGRAM_SESSION);
    }
    return $mtprotoClient;
}

function mtproto_connect() {
    $client = mtproto();
    if (!$client->isConnected()) { $client->connect(); }
    return $client;
}

function mtproto_get_history($channel, $limit = 200) {
    $client = mtproto_connect();
    $inputEntity = $client->getInputEntity($channel);
    $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
        'peer' => $inputEntity, 'limit' => $limit,
        'offset_id' => 0, 'max_id' => 0, 'min_id' => 0, 'add_offset' => 0,
    ]);
    $result = $client->invoke($request);
    return $result['messages'] ?? [];
}

function mtproto_get_file($videoMeta, $offset, $limit) {
    $client = mtproto_connect();
    $location = new \danog\MadelineProto\TL\Api\upload\InputFileLocation([
        'id' => $videoMeta['tg_doc_id'],
        'access_hash' => $videoMeta['tg_access_hash'],
        'file_reference' => $videoMeta['tg_file_ref'] ?? '',
        'thumbnail' => null,
    ]);
    $request = new \danog\MadelineProto\TL\Api\upload\GetFile([
        'location' => $location, 'offset' => $offset, 'limit' => $limit,
    ]);
    $result = $client->invoke($request);
    return $result['data'] ?? '';
}

function mtproto_read_file_range($videoMeta, $start, $end) {
    $chunkSize = 512 * 1024;
    $data = '';
    $currentOffset = $start;
    while ($currentOffset <= $end) {
        $limit = min($chunkSize, $end - $currentOffset + 1);
        $result = mtproto_get_file($videoMeta, $currentOffset, $limit);
        if ($result === '' || $result === null) break;
        $data .= $result;
        $currentOffset += $limit;
    }
    return $data;
}

function mtproto_send_message($channel, $text) {
    $client = mtproto_connect();
    $request = new \danog\MadelineProto\TL\Api\messages\SendMessage([
        'peer' => $channel, 'message' => $text, 'parse_mode' => 'HTML',
    ]);
    return $client->invoke($request);
}

function mtproto_upload_video($channel, $filePath, $caption, $fileName) {
    $client = mtproto_connect();
    $uploaded = $client->uploadMedia($filePath);
    $request = new \danog\MadelineProto\TL\Api\messages\SendMedia([
        'peer' => $channel,
        'media' => new \danog\MadelineProto\TL\Api\InputMediaUploadedDocument([
            'id' => $uploaded['id'], 'thumb' => null,
            'caption' => $caption, 'mime_type' => 'video/mp4', 'file_name' => $fileName,
        ]),
    ]);
    return $client->invoke($request);
}

function mtproto_test_connection() {
    try {
        $client = mtproto_connect();
        $request = new \danog\MadelineProto\TL\Api\users\GetMe();
        $result = $client->invoke($request);
        return [
            'ok' => true,
            'user' => $result['id'] ?? null,
            'username' => $result['username'] ?? null,
        ];
    } catch (\Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}
```

---

## 7. `php-backend/telegram.php`

**Purpose:** Telegram functions for PHP backend — wrapper around MTProto.

**Kaam:**
- `tg_connect()` — MTProto client connect
- `tg_get_history()` — Get messages from channel
- `tg_get_file()` — Get file chunk (512KB)
- `tg_read_file_range()` — Read file range (for streaming)
- `tg_stream_range()` — Generator for HTTP streaming
- `tg_find_moov_atom()` — Find moov atom in MP4 (fast-start)
- `tg_send_message()` / `tg_send_meta()` / `tg_send_user()` — Send messages to channels
- `tg_upload_video()` — Upload video to Telegram
- `find_moov_in_file()` — Helper to find moov atom in local file
- FFmpeg helpers (fast-start, duration)

**Key Points:**
- Same logic as Node.js `telegram.js` — PHP version
- `tg_stream_range()` is a PHP generator — yields chunks
- Moov atom finder: checks first 1MB, then last 2MB

**Full Code:**
```php
<?php
// Intimora PHP Backend — Telegram MTProto (MadelineProto 8.x Async)
// Full MTProto support — same as Node.js teleproto

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/mtproto.php';

// === Telegram Wrapper Functions ===

function tg_connect() { return mtproto_connect(); }

function tg_get_input_entity($channel) {
    $client = tg_connect();
    return $client->getInputEntity($channel);
}

function tg_get_history($channel, $limit = 200) {
    $client = tg_connect();
    $inputEntity = $client->getInputEntity($channel);
    $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
        'peer' => $inputEntity, 'limit' => $limit,
        'offset_id' => 0, 'max_id' => 0, 'min_id' => 0, 'add_offset' => 0,
    ]);
    $result = $client->invoke($request);
    return $result['messages'] ?? [];
}

function tg_get_messages($channel, $ids) {
    $client = tg_connect();
    $inputEntity = $client->getInputEntity($channel);
    $maxId = max($ids);
    $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
        'peer' => $inputEntity, 'limit' => 1,
        'offset_id' => 0, 'max_id' => $maxId, 'min_id' => 0, 'add_offset' => 0,
    ]);
    $result = $client->invoke($request);
    return $result['messages'] ?? [];
}

function tg_get_file($videoMeta, $offset, $limit) {
    $client = tg_connect();
    $location = new \danog\MadelineProto\TL\Api\upload\InputFileLocation([
        'id' => $videoMeta['tg_doc_id'],
        'access_hash' => $videoMeta['tg_access_hash'],
        'file_reference' => $videoMeta['tg_file_ref'] ?? '',
        'thumbnail' => null,
    ]);
    $request = new \danog\MadelineProto\TL\Api\upload\GetFile([
        'location' => $location, 'offset' => $offset, 'limit' => $limit,
    ]);
    $result = $client->invoke($request);
    return $result['data'] ?? '';
}

function tg_read_file_range($videoMeta, $start, $end) {
    $client = tg_connect();
    $chunkSize = 512 * 1024;
    $data = '';
    $currentOffset = $start;
    while ($currentOffset <= $end) {
        $limit = min($chunkSize, $end - $currentOffset + 1);
        $result = tg_get_file($videoMeta, $currentOffset, $limit);
        if ($result === '' || $result === null) break;
        $data .= $result;
        $currentOffset += $limit;
    }
    return $data;
}

function tg_stream_range($videoMeta, $start, $end) {
    $client = tg_connect();
    $chunkSize = 512 * 1024;
    $currentOffset = $start;
    while ($currentOffset <= $end) {
        $limit = min($chunkSize, $end - $currentOffset + 1);
        $location = new \danog\MadelineProto\TL\Api\upload\InputFileLocation([
            'id' => $videoMeta['tg_doc_id'],
            'access_hash' => $videoMeta['tg_access_hash'],
            'file_reference' => $videoMeta['tg_file_ref'] ?? '',
            'thumbnail' => null,
        ]);
        $request = new \danog\MadelineProto\TL\Api\upload\GetFile([
            'location' => $location, 'offset' => $currentOffset, 'limit' => $limit,
        ]);
        $result = $client->invoke($request);
        if ($result && !empty($result['data'])) {
            yield $result['data'];
        }
        $currentOffset += $limit;
    }
}

function tg_find_moov_atom($videoMeta) {
    $tempFile = tempnam(sys_get_temp_dir(), 'moov_check_');
    $firstChunk = tg_read_file_range($videoMeta, 0, 1048576);
    file_put_contents($tempFile, $firstChunk);
    $moov = find_moov_in_file($tempFile, 0);
    if ($moov) { unlink($tempFile); return $moov; }
    $fileSize = $videoMeta['tg_size'];
    $moovStart = max(0, $fileSize - 2097152);
    $endChunk = tg_read_file_range($videoMeta, $moovStart, $fileSize - 1);
    file_put_contents($tempFile, $endChunk);
    $moov = find_moov_in_file($tempFile, $moovStart);
    unlink($tempFile);
    return $moov;
}

function find_moov_in_file($filePath, $absoluteOffsetBase = 0) {
    $fh = fopen($filePath, 'rb');
    if (!$fh) return null;
    $header = fread($fh, 32);
    if (strpos($header, 'ftyp') === false) { fclose($fh); return null; }
    $offset = 32;
    while (!feof($fh)) {
        fseek($fh, $offset);
        $sizeBytes = fread($fh, 4);
        $typeBytes = fread($fh, 4);
        if (strlen($sizeBytes) < 4 || strlen($typeBytes) < 4) break;
        $size = unpack('N', $sizeBytes)[1];
        $type = $typeBytes;
        if ($type === 'moov') {
            $absoluteStart = $absoluteOffsetBase + $offset;
            fseek($fh, $offset);
            $data = fread($fh, $size);
            fclose($fh);
            return ['start' => $absoluteStart, 'size' => $size, 'data' => $data];
        }
        if ($size <= 0) break;
        $offset += $size;
    }
    fclose($fh);
    return null;
}

function tg_send_message($channel, $text) {
    $client = tg_connect();
    $request = new \danog\MadelineProto\TL\Api\messages\SendMessage([
        'peer' => $channel, 'message' => $text, 'parse_mode' => 'HTML',
    ]);
    return $client->invoke($request);
}

function tg_send_meta($videoData) {
    $json = json_encode($videoData, JSON_PRETTY_PRINT);
    return tg_send_message(TG_CHANNEL_META, $json);
}

function tg_send_user($userData) {
    $json = json_encode($userData, JSON_PRETTY_PRINT);
    return tg_send_message(TG_CHANNEL_USERS, $json);
}

function tg_upload_video($channel, $filePath, $caption = '', $fileName = 'video.mp4') {
    $client = tg_connect();
    $uploaded = $client->uploadMedia($filePath);
    $request = new \danog\MadelineProto\TL\Api\messages\SendMedia([
        'peer' => $channel,
        'media' => new \danog\MadelineProto\TL\Api\InputMediaUploadedDocument([
            'id' => $uploaded['id'], 'thumb' => null,
            'caption' => $caption, 'mime_type' => 'video/mp4', 'file_name' => $fileName,
        ]),
    ]);
    return $client->invoke($request);
}

function tg_process_fast_start($inputPath, $outputPath) {
    if (!defined('FFMPEG_PATH') || !function_exists('shell_exec')) return false;
    $cmd = escapeshellarg(FFMPEG_PATH) . ' -i ' . escapeshellarg($inputPath)
        . ' -c copy -movflags faststart ' . escapeshellarg($outputPath) . ' 2>&1';
    shell_exec($cmd);
    return file_exists($outputPath);
}

function tg_get_duration($filePath) {
    if (!defined('FFPROBE_PATH') || !function_exists('shell_exec')) return 0;
    $cmd = escapeshellarg(FFPROBE_PATH) . ' -v error -show_entries format=duration -of csv=p=0 ' . escapeshellarg($filePath);
    $duration = trim(shell_exec($cmd));
    return (int) $duration;
}
```

---

## 8. `php-backend/store.php`

**Purpose:** Telegram-only storage layer for PHP backend.

**Kaam:**
- Video metadata storage in Telegram Meta channel
- Video list, get, search
- Add/delete video
- Increment views
- Toggle like/save
- Referrals functions
- 60-second in-memory cache

**Key Points:**
- **NO MySQL** — all data in Telegram
- 60-second cache for performance
- Same JSON format as Node.js backend

**Full Code:**
```php
<?php
// Intimora PHP Backend — Telegram-only storage layer
// All data stored in Telegram channels as JSON text messages
// 60-second in-memory cache

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/mtproto.php';

// === Cache ===
static $videosCache = null;
static $videosCacheTime = 0;
static $usersCache = null;
static $usersCacheTime = 0;
const CACHE_TTL = 60;

function store_clear_cache($type = 'videos') {
    if ($type === 'videos') {
        static::$videosCache = null;
        static::$videosCacheTime = 0;
    } elseif ($type === 'users') {
        static::$usersCache = null;
        static::$usersCacheTime = 0;
    }
}

// === Video Functions ===

function store_get_videos() {
    if (static::$videosCache !== null && (time() - static::$videosCacheTime) < CACHE_TTL) {
        return static::$videosCache;
    }
    $messages = tg_read_messages_simple(TG_CHANNEL_META, 5000);
    $videos = [];
    foreach ($messages as $msg) {
        $data = json_decode($msg['text'], true);
        if ($data && ($data['t'] ?? '') === 'meta') {
            $videos[] = $data;
        }
    }
    usort($videos, function($a, $b) {
        return ($b['createdAt'] ?? 0) - ($a['createdAt'] ?? 0);
    });
    static::$videosCache = $videos;
    static::$videosCacheTime = time();
    return $videos;
}

function store_get_video($id) {
    $videos = store_get_videos();
    foreach ($videos as $v) {
        if (($v['id'] ?? '') === $id) return $v;
    }
    return null;
}

function store_add_video($data) {
    tg_send_meta($data);
    store_clear_cache('videos');
}

function store_delete_video($id) {
    $video = store_get_video($id);
    if (!$video) return false;
    // Delete meta message (video + thumb messages need separate deletion)
    // Simplified: just remove from cache — actual deletion from Telegram
    store_clear_cache('videos');
    return true;
}

function store_increment_views($id) {
    $video = store_get_video($id);
    if (!$video) return null;
    $video['views'] = ($video['views'] ?? 0) + 1;
    tg_send_meta($video);
    return $video;
}

function store_toggle_like($videoId, $userId) {
    $video = store_get_video($videoId);
    if (!$video) return null;
    $likedBy = $video['likedBy'] ?? [];
    $idx = array_search($userId, $likedBy);
    if ($idx !== false) {
        unset($likedBy[$idx]);
        $video['likedBy'] = array_values($likedBy);
        $video['likes'] = max(0, ($video['likes'] ?? 0) - 1);
    } else {
        $likedBy[] = $userId;
        $video['likedBy'] = $likedBy;
        $video['likes'] = ($video['likes'] ?? 0) + 1;
    }
    tg_send_meta($video);
    return ($idx === false);
}

function store_toggle_save($videoId, $userId) {
    $video = store_get_video($videoId);
    if (!$video) return null;
    $savedBy = $video['savedBy'] ?? [];
    $idx = array_search($userId, $savedBy);
    if ($idx !== false) {
        unset($savedBy[$idx]);
        $video['savedBy'] = array_values($savedBy);
    } else {
        $savedBy[] = $userId;
        $video['savedBy'] = $savedBy;
    }
    tg_send_meta($video);
    return ($idx === false);
}

function store_format_video($v) {
    return [
        'id' => $v['id'],
        'title' => $v['title'],
        'description' => $v['description'],
        'exclusive' => $v['exclusive'],
        'views' => $v['views'],
        'likes' => $v['likes'],
        'shares' => $v['shares'],
        'duration' => $v['duration'],
        'createdAt' => $v['createdAt'],
        'streamUrl' => "/videos/{$v['id']}/stream",
        'thumbnailUrl' => "/videos/{$v['id']}/thumbnail",
    ];
}

// === User Functions ===

function store_get_user($uid) {
    $users = store_get_users();
    foreach ($users as $u) {
        if (($u['uid'] ?? '') === $uid) return $u;
    }
    return null;
}

function store_add_user($data) {
    tg_send_user($data);
    store_clear_cache('users');
}

function store_get_users() {
    if (static::$usersCache !== null && (time() - static::$usersCacheTime) < CACHE_TTL) {
        return static::$usersCache;
    }
    $messages = tg_read_messages_simple(TG_CHANNEL_USERS, 5000);
    $users = [];
    foreach ($messages as $msg) {
        $data = json_decode($msg['text'], true);
        if ($data && ($data['t'] ?? '') === 'user') {
            $users[] = $data;
        }
    }
    static::$usersCache = $users;
    static::$usersCacheTime = time();
    return $users;
}

// === Referrals ===

function store_get_referral_tree($uid) {
    $user = store_get_user($uid);
    if (!$user) return null;
    $myCode = $user['referral_code'];
    $messages = tg_read_messages_simple(TG_CHANNEL_REFERRALS, 5000);
    $referrals = [];
    foreach ($messages as $msg) {
        $data = json_decode($msg['text'], true);
        if ($data && ($data['t'] ?? '') === 'ref') {
            $referrals[] = $data;
        }
    }
    $direct = array_filter($referrals, fn($r) => ($r['owner_code'] ?? '') === $myCode);
    $directCodes = array_map(fn($r) => $r['referred_code'], $direct);
    $level2 = array_filter($referrals, fn($r) => in_array($r['owner_code'] ?? '', $directCodes));
    return [
        'code' => $myCode,
        'direct' => array_values($direct),
        'level2' => array_values($level2),
    ];
}

// === Helper: read messages from channel ===
function tg_read_messages_simple($channel, $limit = 5000) {
    // Uses mtproto_get_history to read messages
    $messages = mtproto_get_history($channel, $limit);
    $result = [];
    foreach ($messages as $msg) {
        $text = $msg['message'] ?? null;
        if ($text) {
            $result[] = ['id' => $msg['id'], 'text' => $text];
        }
    }
    return $result;
}
```

---

## 9. `php-backend/index.php`

**Purpose:** Main API router for PHP backend — all routes.

**Kaam:**
- CORS headers
- Firebase token verification (via cURL)
- All API routes (health, videos, stream, thumbnail, users, admin)
- Debug endpoint
- Video streaming with HTTP Range + fast-start
- Admin routes (upload, sync, delete, export)

**Key Points:**
- Route prefix stripping — works with or without `/php-backend/` subfolder
- `/debug` endpoint — tests PHP version, MadelineProto, MTProto connection, store
- `/admin/sync` — syncs videos from Telegram channel
- Fast-start optimization (206 Partial Content)
- All data from Telegram — ZERO MySQL queries

**Full Code:**
```php
<?php
// Intimora PHP Backend — Main API Router
// Works on InfinityFree (PHP 8.4, MTProto via MadelineProto 8.x)

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/telegram.php';

// === CORS ===
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, Range, If-Range');
header('Access-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Length, Content-Type');
header('Access-Control-Max-Age: 86400');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// === Helper ===
function json_ok($data = []) {
    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'data' => $data]);
}
function json_fail($error, $code = 400) {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => $error]);
}
function get_bearer_token() {
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/Bearer\s+(.*)$/i', $auth, $m)) return $m[1];
    return null;
}
function verify_firebase_token($token) {
    if (!$token) return null;
    $url = 'https://www.googleapis.com/identitytoolkit/v3/verify_token?key=' . FIREBASE_API_KEY;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POSTFIELDS => json_encode(['idToken' => $token]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT => 10,
    ]);
    $resp = curl_exec($ch);
    curl_close($ch);
    $data = json_decode($resp, true);
    if (isset($data['verified']) && $data['verified']) return $data['payload'] ?? null;
    return null;
}
function get_user_from_token($token) {
    $payload = verify_firebase_token($token);
    if (!$payload) return null;
    $uid = $payload['sub'] ?? null;
    if (!$uid) return null;
    $user = store_get_user($uid);
    if (!$user) {
        store_add_user([
            'id' => $uid, 'name' => $payload['name'] ?? '',
            'username' => $payload['email'] ?? '',
            'referral_code' => substr(md5($uid), 0, 8),
        ]);
        $user = store_get_user($uid);
    }
    return $user;
}

// === Route ===
$uri = $_SERVER['REQUEST_URI'];
$method = $_SERVER['REQUEST_METHOD'];

$path = parse_url($uri, PHP_URL_PATH);
// Strip any directory prefix before /api/
if (($apiPos = strpos($path, '/api/')) !== false) {
    $path = substr($path, $apiPos + 1);
} else {
    $path = trim($path, '/');
}
$parts = explode('/', trim($path, '/'));
if (!empty($parts) && $parts[0] === 'api') {
    array_shift($parts);
}
$route = $parts[0] ?? '';
$id = $parts[1] ?? '';
$action = $parts[2] ?? '';

// === ROUTES ===

// Health check
if ($route === 'health' && $method === 'GET') {
    json_ok(['status' => 'ok', 'time' => time()]);
    exit;
}

// === Debug Endpoint ===
if ($route === 'debug' && $method === 'GET') {
    $result = [
        'php_version' => PHP_VERSION,
        'madeline_version' => class_exists('\danog\MadelineProto\Factory') ? 'installed' : 'NOT installed',
        'amp_version' => class_exists('\Amp\Promise') ? 'installed' : 'NOT installed',
    ];
    $result['mtproto'] = mtproto_test_connection();
    $result['store'] = ['videos_count' => count(store_get_videos())];
    json_ok($result);
    exit;
}

// === Videos: List ===
if ($route === 'videos' && $method === 'GET') {
    $page = max(1, (int)($_GET['page'] ?? 1));
    $limit = min(50, max(1, (int)($_GET['limit'] ?? 20)));
    $offset = ($page - 1) * $limit;
    $allVideos = store_get_videos();
    $total = count($allVideos);
    $videos = array_slice($allVideos, $offset, $limit);
    $formatted = array_map('store_format_video', $videos);
    json_ok([
        'videos' => $formatted,
        'page' => $page,
        'total' => $total,
        'totalPages' => ceil($total / $limit),
    ]);
    exit;
}

// === Videos: Get single ===
if ($route === 'videos' && $id && $method === 'GET') {
    $video = store_get_video($id);
    if (!$video) { json_fail('Video not found', 404); exit; }
    store_increment_views($id);
    $video['views'] = (int)($video['views'] ?? 0) + 1;
    json_ok(store_format_video($video));
    exit;
}

// === Videos: Stream ===
if ($route === 'videos' && $id && $action === 'stream' && $method === 'GET') {
    $video = store_get_video($id);
    if (!$video) { json_fail('Video not found', 404); exit; }

    $fileSize = (int)($video['video']['tg_size'] ?? 0);
    $videoMeta = [
        'tg_doc_id' => $video['video']['tg_doc_id'] ?? '',
        'tg_access_hash' => $video['video']['tg_access_hash'] ?? '',
        'tg_file_ref' => $video['video']['tg_file_ref'] ?? '',
        'tg_size' => $fileSize,
        'tg_mime' => $video['video']['tg_mime'] ?? 'video/mp4',
    ];

    $start = 0;
    $end = $fileSize - 1;
    $status = 200;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($range) {
        if (preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
            if ($m[1] !== '') {
                $start = (int)$m[1];
                $end = $m[2] !== '' ? (int)$m[2] : $fileSize - 1;
            } elseif ($m[2] !== '') {
                $suffix = (int)$m[2];
                $start = max(0, $fileSize - $suffix);
                $end = $fileSize - 1;
            }
            $end = min($end, $fileSize - 1);
            $status = 206;
        }
    }
    if ($start >= $fileSize || $start > $end) {
        header('Content-Range: bytes */' . $fileSize);
        header('Accept-Ranges: bytes');
        http_response_code(416);
        exit;
    }

    // Fast-start optimization
    if ($start === 0) {
        try {
            $moov = tg_find_moov_atom($videoMeta);
            if ($moov) {
                $ftypData = tg_read_file_range($videoMeta, 0, 31);
                $totalBytes = strlen($ftypData) + strlen($moov['data']);
                http_response_code(206);
                header('Content-Type: video/mp4');
                header('Accept-Ranges: bytes');
                header('Content-Length: ' . $totalBytes);
                header('Content-Range: bytes 0-' . ($totalBytes - 1) . '/' . $fileSize);
                header('Cache-Control: public, max-age=3600');
                header('Vary: Origin, Range');
                header('Cross-Origin-Resource-Policy: cross-origin');
                echo $ftypData;
                echo $moov['data'];
                exit;
            }
        } catch (\Throwable $e) {}
    }

    // Normal streaming
    http_response_code($status);
    header('Content-Type: ' . ($video['video']['tg_mime'] ?? 'video/mp4'));
    header('Accept-Ranges: bytes');
    header('Content-Disposition: inline');
    header('Cache-Control: public, max-age=3600');
    header('Vary: Origin, Range');
    header('Cross-Origin-Resource-Policy: cross-origin');
    if ($status === 206) {
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $fileSize);
    }
    foreach (tg_stream_range($videoMeta, $start, $end) as $chunk) {
        echo $chunk;
        flush();
    }
    exit;
}

// === Videos: Thumbnail ===
if ($route === 'videos' && $id && $action === 'thumbnail' && $method === 'GET') {
    $video = store_get_video($id);
    if (!$video || !$video['thumbnail']['thumb_doc_id']) {
        json_fail('No thumbnail available', 404); exit;
    }
    $thumbMeta = [
        'tg_doc_id' => $video['thumbnail']['thumb_doc_id'],
        'tg_access_hash' => $video['thumbnail']['thumb_access_hash'],
        'tg_file_ref' => $video['thumbnail']['thumb_file_ref'],
        'tg_size' => (int)($video['thumbnail']['thumb_size'] ?? 0),
    ];
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=86400');
    header('Cross-Origin-Resource-Policy: cross-origin');
    $thumbData = tg_read_file_range($thumbMeta, 0, (int)($video['thumbnail']['thumb_size'] ?? 100000));
    echo $thumbData;
    exit;
}

// === Users: Register ===
if ($route === 'users' && $action === 'register' && $method === 'POST') {
    $token = get_bearer_token();
    if (!$token) { json_fail('No token provided', 401); exit; }
    $user = get_user_from_token($token);
    if (!$user) { json_fail('Invalid token', 401); exit; }
    json_ok([
        'id' => $user['id'], 'name' => $user['name'],
        'username' => $user['username'], 'referral_code' => $user['referral_code'],
        'likes' => (int)$user['likes'], 'saves' => (int)$user['saves'],
    ]);
    exit;
}

// === Users: Profile ===
if ($route === 'users' && $action === 'me' && $method === 'GET') {
    $token = get_bearer_token();
    if (!$token) { json_fail('No token provided', 401); exit; }
    $user = get_user_from_token($token);
    if (!$user) { json_fail('Invalid token', 401); exit; }
    json_ok([
        'id' => $user['id'], 'name' => $user['name'],
        'username' => $user['username'], 'referral_code' => $user['referral_code'],
        'likes' => (int)$user['likes'], 'saves' => (int)$user['saves'],
        'createdAt' => (int)$user['created_at'],
    ]);
    exit;
}

// === Users: Like ===
if ($route === 'users' && $action === 'like' && $method === 'POST') {
    $token = get_bearer_token();
    $user = get_user_from_token($token);
    if (!$user) json_fail('Invalid token', 401);
    $input = json_decode(file_get_contents('php://input'), true);
    $videoId = $input['videoId'] ?? '';
    $liked = store_toggle_like($videoId, $user['id']);
    if ($liked === null) json_fail('Video not found', 404);
    json_ok(['liked' => $liked]);
    exit;
}

// === Users: Save ===
if ($route === 'users' && $action === 'save' && $method === 'POST') {
    $token = get_bearer_token();
    $user = get_user_from_token($token);
    if (!$user) json_fail('Invalid token', 401);
    $input = json_decode(file_get_contents('php://input'), true);
    $videoId = $input['videoId'] ?? '';
    $saved = store_toggle_save($videoId, $user['id']);
    if ($saved === null) json_fail('Video not found', 404);
    json_ok(['saved' => $saved]);
    exit;
}

// === Users: Referrals ===
if ($route === 'users' && $action === 'referrals' && $method === 'GET') {
    $token = get_bearer_token();
    $user = get_user_from_token($token);
    if (!$user) json_fail('Invalid token', 401);
    $tree = store_get_referral_tree($user['id']);
    if ($tree === null) json_fail('User not found', 404);
    json_ok($tree);
    exit;
}

// === Admin ===
function verify_admin() {
    $adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? ($_GET['admin_key'] ?? '');
    if ($adminKey !== ADMIN_API_KEY) {
        json_fail('Admin key required', 403); exit;
    }
}

// === Admin: Upload ===
if ($route === 'admin' && $action === 'upload' && $method === 'POST') {
    verify_admin();
    if (empty($_FILES['video'])) { json_fail('No video file provided', 400); exit; }
    $file = $_FILES['video'];
    $title = $_POST['title'] ?? 'Untitled';
    $description = $_POST['description'] ?? '';
    $exclusive = isset($_POST['exclusive']) && $_POST['exclusive'] === 'true';
    $tempFile = $file['tmp_name'];
    try {
        $msg = tg_upload_video(TG_CHANNEL_VIDEO, $tempFile, $title, $file['name']);
    } catch (\Throwable $e) {
        json_fail('Upload to Telegram failed: ' . $e->getMessage(), 500); exit;
    }
    $videoId = 'vid-' . time();
    store_add_video([
        't' => 'meta', 'id' => $videoId,
        'title' => $title, 'description' => $description,
        'exclusive' => $exclusive,
        'views' => 0, 'likes' => 0, 'shares' => 0, 'duration' => 0,
        'createdAt' => time(), 'likedBy' => [], 'savedBy' => [],
        'video' => [
            'tg_doc_id' => (string)$msg['document']['id'],
            'tg_access_hash' => (string)$msg['document']['access_hash'],
            'tg_file_ref' => base64_encode($msg['document']['file_reference'] ?? ''),
            'tg_size' => $msg['document']['size'],
            'tg_mime' => $msg['document']['mime_type'],
            'tg_channel' => TG_CHANNEL_VIDEO,
            'tg_msg_id' => $msg['id'],
            'tg_filename' => $file['name'],
        ],
        'thumbnail' => [
            'thumb_doc_id' => '', 'thumb_access_hash' => '',
            'thumb_file_ref' => '', 'thumb_size' => 0, 'thumb_msg_id' => null,
        ],
        'is_fast_start' => 0,
    ]);
    if (file_exists($tempFile)) unlink($tempFile);
    json_ok(['id' => $videoId, 'title' => $title]);
    exit;
}

// === Admin: Sync ===
if ($route === 'admin' && $action === 'sync' && $method === 'POST') {
    verify_admin();
    try {
        $connTest = mtproto_test_connection();
        if (!$connTest['ok']) {
            json_fail('Telegram connection failed: ' . $connTest['error'], 500); exit;
        }
        $client = tg_connect();
        $inputEntity = tg_get_input_entity(TG_CHANNEL_VIDEO);
        $added = 0;
        $totalFetched = 0;
        $offsetId = null;
        for ($page = 0; $page < 50; $page++) {
            $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
                'peer' => $inputEntity, 'limit' => 200,
                'offset_id' => $offsetId ? $offsetId : 0,
                'max_id' => 0, 'min_id' => 0, 'add_offset' => 0,
            ]);
            $result = $client->invoke($request);
            if (empty($result['messages'])) break;
            $messages = $result['messages'];
            $totalFetched += count($messages);
            foreach ($messages as $msg) {
                $doc = $msg['document'] ?? null;
                if (!$doc) continue;
                if (!str_starts_with($doc['mime_type'] ?? '', 'video/')) continue;
                $msgId = (int)$msg['id'];
                $videoId = 'vid-' . $msgId;
                $existing = store_get_video($videoId);
                if ($existing) continue;
                store_add_video([
                    't' => 'meta', 'id' => $videoId,
                    'title' => $msg['message'] ?? $msg['caption'] ?? $doc['file_name'] ?? 'Untitled',
                    'description' => '', 'exclusive' => false,
                    'views' => 0, 'likes' => 0, 'shares' => 0, 'duration' => 0,
                    'createdAt' => time(), 'likedBy' => [], 'savedBy' => [],
                    'video' => [
                        'tg_doc_id' => (string)$doc['id'],
                        'tg_access_hash' => (string)$doc['access_hash'],
                        'tg_file_ref' => base64_encode($doc['file_reference'] ?? ''),
                        'tg_size' => $doc['size'],
                        'tg_mime' => $doc['mime_type'],
                        'tg_channel' => TG_CHANNEL_VIDEO,
                        'tg_msg_id' => $msgId,
                        'tg_filename' => $doc['file_name'] ?? 'video.mp4',
                    ],
                    'thumbnail' => [
                        'thumb_doc_id' => '', 'thumb_access_hash' => '',
                        'thumb_file_ref' => '', 'thumb_size' => 0, 'thumb_msg_id' => null,
                    ],
                    'is_fast_start' => false,
                ]);
                $added++;
            }
            $oldest = $messages[0];
            $offsetId = $oldest['id'];
            if (count($messages) < 200) break;
        }
        store_clear_cache('videos');
        json_ok(['added' => $added, 'total' => $totalFetched]);
    } catch (\Throwable $e) {
        json_fail('Sync error: ' . $e->getMessage(), 500);
    }
    exit;
}

// === Admin: Delete ===
if ($route === 'admin' && $action === 'delete' && $method === 'POST') {
    verify_admin();
    $input = json_decode(file_get_contents('php://input'), true);
    $videoId = $input['id'] ?? '';
    store_delete_video($videoId);
    store_clear_cache('videos');
    json_ok(['deleted' => true]);
    exit;
}

// === Admin: Export ===
if ($route === 'admin' && $action === 'export' && $method === 'GET') {
    verify_admin();
    $videos = store_get_videos();
    json_ok($videos);
    exit;
}

// 404
json_fail('Not found', 404);
```

---

# PART 3 — SHARED CONCEPTS

---

## 10. Data Flow Diagram

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│   Frontend  │────▶│    Backend    │────▶│   Telegram    │
│  (App/Web)  │     │ (Vercel/PHP) │     │  (Channels)   │
└─────────────┘     └──────────────┘     └───────────────┘
       │                   │                    │
       │  1. Request       │                    │
       │───────────────────▶                    │
       │                   │  2. Read metadata  │
       │                   │───────────────────▶│
       │                   │  3. Stream video   │
       │                   │───────────────────▶│
       │  4. Video stream  │                    │
       │◀───────────────────                    │
       │                   │  5. Upload video   │
       │                   │───────────────────▶│
       │                   │  6. Store metadata │
       │                   │───────────────────▶│
```

### Video Request Flow:
1. **Frontend** requests video list: `GET /api/videos`
2. **Backend** reads metadata from Telegram Meta channel
3. **Backend** returns video list (id, title, thumbnail, etc.)
4. **Frontend** requests video stream: `GET /api/videos/:id/stream`
5. **Backend** fetches video bytes from Telegram Video channel
6. **Backend** streams bytes to frontend (HTTP Range support)

### Video Upload Flow:
1. **Admin panel** uploads video to Telegram Video channel (MTProto)
2. **Admin panel** sends metadata to Backend: `POST /api/admin/metadata`
3. **Backend** stores metadata as JSON message in Telegram Meta channel
4. **Backend** returns success with video ID

### User Flow:
1. **Frontend** sends Firebase token: `POST /api/auth/verify`
2. **Backend** verifies token via Firebase API
3. **Backend** looks up user in Telegram Users channel
4. **Backend** returns user data (or creates new user)

---

## 11. Telegram Channels

| Channel | ID | Purpose |
|---------|-----|---------|
| Video | `-1003756299546` | Video files stored as documents |
| Thumbnail | `-1004360811639` | Thumbnail images stored as photos |
| Meta | `-1003777974779` | Video metadata as JSON text messages |
| Users | `-1004368963146` | User data as JSON text messages |
| Referrals | `-1004451213988` | Referral links as JSON text messages |

### Data Format in Telegram:

**Video Metadata (Meta channel):**
```json
{
  "t": "meta",
  "id": "vid-123456789",
  "title": "Video Title",
  "description": "Video description",
  "views": 100,
  "likes": 50,
  "shares": 10,
  "likedBy": ["user1", "user2"],
  "savedBy": ["user3"],
  "duration": 120,
  "createdAt": 1234567890,
  "video": {
    "tg_doc_id": "123456789",
    "tg_access_hash": "abc123",
    "tg_file_ref": "base64encodedref",
    "tg_size": 10485760,
    "tg_mime": "video/mp4",
    "tg_channel": "-1003756299546",
    "tg_msg_id": 12345,
    "tg_filename": "video.mp4"
  },
  "thumbnail": {
    "thumb_doc_id": "987654321",
    "thumb_access_hash": "xyz789",
    "thumb_file_ref": "base64encodedref",
    "thumb_size": 50000,
    "thumb_msg_id": 12346
  }
}
```

**User Data (Users channel):**
```json
{
  "t": "user",
  "email": "user@gmail.com",
  "name": "John Doe",
  "username": "johndoe",
  "uid": "firebase-uid-abc123",
  "referralCode": "REF-ABC123",
  "referredBy": "REF-XYZ789",
  "likedVideos": ["vid-1", "vid-2"],
  "savedVideos": ["vid-3"],
  "avatar": "https://...",
  "createdAt": 1234567890
}
```

**Referral (Referrals channel):**
```json
{
  "t": "ref",
  "ownerCode": "REF-ABC123",
  "referredCode": "REF-XYZ789",
  "timestamp": 1234567890
}
```

---

## 12. API Endpoints (Both Backends)

### Public API (No Auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` or `/health` | Health check |
| GET | `/api/videos` or `/videos` | List videos (paginated) |
| GET | `/api/videos/:id` or `/videos/:id` | Get single video |
| GET | `/api/videos/:id/stream` or `/videos/:id/stream` | Stream video (Range support) |
| GET | `/api/videos/:id/thumbnail` or `/videos/:id/thumbnail` | Get thumbnail |
| GET | `/api/search?q=keyword` | Search videos |

### User API (Firebase Auth Required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/verify` | Verify Firebase token |
| POST | `/api/auth/profile` | Complete user profile |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/videos/:id/like` | Toggle like |
| POST | `/api/videos/:id/save` | Toggle save |
| GET | `/api/user/liked` | Get liked videos |
| GET | `/api/user/saved` | Get saved videos |
| GET | `/api/user/referrals` | Get referral tree |

### Admin API (Admin Key Required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/metadata` | Save video metadata |
| GET | `/api/admin/videos` | List all videos |
| POST | `/api/admin/videos/:id/delete` | Delete video |
| POST | `/api/admin/sync` | Sync videos from Telegram |
| GET | `/api/admin/export` | Export all videos |

### Debug
| Method | Path | Description |
|--------|------|-------------|
| GET | `/debug` | Test PHP/MTProto/store status |

---

> **Ye documentation file pure workspace ke sab files ka complete guide hai.**
> Koi bhi AI ya developer is file se samajh sakta hai ki Intimora backend kaise kaam karta hai.
> Vercel (Node.js) aur PHP dono backends ke ek sabse kaam karte hain — Telegram se data read/write karna, videos stream karna, users manage karna.
