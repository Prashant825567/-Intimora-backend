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
// Allow specific frontend origins to call APIs directly from browser
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
  // Handle OPTIONS preflight — empty 204, no HTML
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---- Path normalization for Netlify serverless ----
// When Netlify routes to this function, the path may be:
//   /api/health          (correct — from redirect rule)
//   /.netlify/functions/api/health  (when accessed directly)
// Normalize both to /api/* so Express routes match.
app.use((req, res, next) => {
  // Only normalize paths that are actually API calls
  if (req.url.startsWith('/.netlify/functions/api')) {
    req.url = req.url.replace(/^\/\.netlify\/functions\/api/, '/api');
  } else if (req.url.startsWith('/api')) {
    // already correct
  } else {
    // non-API path (e.g. /admin) — leave as-is
    return next();
  }
  next();
});

const PORT = parseInt(process.env.PORT, 10) || 10000;

// ---- helpers ----
function ok(res, data) { return res.json({ ok: true, data }); }
function fail(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

// serialize video metadata for the public API
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

// ---- admin auth ----
function adminAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) return fail(res, "Unauthorized", 401);
  next();
}

// ============================================================
// PUBLIC API (no API key needed)
// ============================================================

app.get("/api/health", (req, res) => ok(res, { status: "up", time: Date.now() }));

// Infinite scroll — cursor-based pagination
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

// Search
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return ok(res, { videos: [], nextCursor: null });
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
    const metas = await store.searchVideos(q);
    ok(res, { videos: metas.slice(0, limit).map(publicVideo), nextCursor: null });
  } catch (e) { fail(res, e.message, 500); }
});

// Video detail (counts a view — directly edits Telegram metadata message)
app.get("/api/videos/:id", async (req, res) => {
  try {
    let v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    v = await store.incrementViews(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    ok(res, publicVideo(v));
  } catch (e) { fail(res, e.message, 500); }
});

// Thumbnail — fetch from Telegram, serve as image
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
  } catch (e) {
    fail(res, e.message, 500);
  }
});

// Stream video — server-side MTProto streaming with HTTP Range support
// Handles: bytes=0-1023, bytes=1024-, bytes=-1024 (suffix), clamps to fileSize
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
          // bytes=start-end or bytes=start-
          start = parseInt(m[1], 10);
          end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
        } else if (m[2]) {
          // bytes=-suffix → last N bytes
          const suffix = parseInt(m[2], 10);
          start = Math.max(0, fileSize - suffix);
          end = fileSize - 1;
        }
        // Clamp end to fileSize
        end = Math.min(end, fileSize - 1);
        status = 206;
      }
    }
    if (start >= fileSize) return fail(res, "Range not satisfiable", 416);

    // ---- Fast-start optimization ----
    // If browser requests from offset 0 and moov is at the END of the file,
    // send ftyp + moov first so browser can start playing immediately.
    // If moov is already at the beginning, findMoovAtom returns null → normal streaming.
    if (start === 0) {
      try {
        const moov = await tg.findMoovAtom(streamFormat);
        if (moov) {
          // moov is at the end — send ftyp + moov as 200 response
          const ftypData = await tg.readFileRange(streamFormat, 0, 31);
          const totalBytes = ftypData.length + moov.data.length;

          res.status(200);
          res.set({
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": totalBytes,
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

// Record a share — edits Telegram metadata message directly
app.post("/api/videos/:id/share", async (req, res) => {
  try {
    const v = await store.incrementShares(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    ok(res, { shares: v.shares });
  } catch (e) { fail(res, e.message, 500); }
});

// ============================================================
// USER SYSTEM — Firebase Auth + Telegram storage
// ============================================================

// Verify Firebase token — returns user if exists
app.post("/api/auth/verify", auth, async (req, res) => {
  try {
    const user = await users.findByUid(req.userId);
    if (!user) {
      return ok(res, { exists: false, email: req.userEmail, uid: req.userId });
    }
    ok(res, { exists: true, user });
  } catch (e) { fail(res, e.message, 500); }
});

// Complete profile — new user only
app.post("/api/auth/profile", auth, async (req, res) => {
  try {
    const { name, username, referralCode, avatar } = req.body;
    if (!name || !username) return fail(res, "Name and username required", 400);

    // Check if user already exists
    const existing = await users.findByUid(req.userId);
    if (existing) return fail(res, "User already exists", 400);

    // Check username availability
    const usernameTaken = await users.findByUsername(username);
    if (usernameTaken) return fail(res, "Username already exists", 400);

    // Validate referral code if provided
    let referredBy = "";
    if (referralCode && referralCode.trim()) {
      const referrer = await users.findByReferralCode(referralCode.trim());
      if (!referrer) return fail(res, "Invalid referral code", 400);
      referredBy = referrer.referralCode;
    }

    const user = await users.createUser({
      email: req.userEmail,
      name,
      username,
      uid: req.userId,
      avatar: avatar || "",
      referredBy,
    });

    ok(res, { user: { id: user.id, name: user.name, username: user.username, referralCode: user.referralCode } });
  } catch (e) { fail(res, e.message, 500); }
});

// Get current user
app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const user = await users.findByUid(req.userId);
    if (!user) return fail(res, "User not found", 404);
    ok(res, { user });
  } catch (e) { fail(res, e.message, 500); }
});

// Like / unlike video (authenticated)
app.post("/api/videos/:id/like", auth, async (req, res) => {
  try {
    const result = await users.toggleLike(req.userId, req.params.id);
    if (!result) return fail(res, "User not found", 404);
    ok(res, result);
  } catch (e) { fail(res, e.message, 500); }
});

// Save / unsave video (authenticated)
app.post("/api/videos/:id/save", auth, async (req, res) => {
  try {
    const result = await users.toggleSave(req.userId, req.params.id);
    if (!result) return fail(res, "User not found", 404);
    ok(res, result);
  } catch (e) { fail(res, e.message, 500); }
});

// Get user's liked videos
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

// Get user's saved videos
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

// Get referral tree
app.get("/api/user/referrals", auth, async (req, res) => {
  try {
    const tree = await users.getReferralTree(req.userId);
    if (!tree) return fail(res, "User not found", 404);
    ok(res, { tree });
  } catch (e) { fail(res, e.message, 500); }
});

// ============================================================
// ADMIN API (x-api-key required)
// ============================================================

// Receive metadata from admin panel (admin uploads directly via MTProto in browser)
// Stores metadata as JSON message in Telegram metadata channel
app.post("/api/admin/metadata", adminAuth, async (req, res) => {
  try {
    const metadata = req.body;
    if (!metadata || !metadata.id || !metadata.video) {
      return fail(res, "Missing required fields (id, video)");
    }

    // Normalize field names from admin panel format (tg_doc_id → docId etc.)
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

// Admin: list all videos
app.get("/api/admin/videos", adminAuth, async (req, res) => {
  try {
    const metas = await store.listAllVideos();
    ok(res, metas.map(publicVideo));
  } catch (e) { fail(res, e.message, 500); }
});

// Admin: delete video (deletes all 3 messages from Telegram)
app.post("/api/admin/videos/:id/delete", adminAuth, async (req, res) => {
  try {
    const result = await store.deleteVideo(req.params.id);
    if (!result.deleted) return fail(res, "Video not found", 404);
    ok(res, { deleted: true });
  } catch (e) { fail(res, e.message, 500); }
});

// ============================================================
// STATIC — Admin panel only (no frontend)
// ============================================================
// JSON error handler
app.use((err, req, res, next) => {
  if (err) return fail(res, err.message || "Internal error", 400);
  next();
});

// Admin panel at /admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

// ---- Serverless handler + local listen ----
module.exports = app;
module.exports.handler = serverless(app); // Netlify compatibility

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend running on port ${PORT}`);
    console.log(`Video channel:     ${process.env.TELEGRAM_CHANNEL_VIDEO || "(not set)"}`);
    console.log(`Thumbnail channel: ${process.env.TELEGRAM_CHANNEL_THUMB || "(not set)"}`);
    console.log(`Metadata channel:  ${process.env.TELEGRAM_CHANNEL_META || "(not set)"}`);
  });
}
