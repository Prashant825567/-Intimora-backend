// Express server — backend only. Reads data from Telegram, streams videos.
// Admin panel uploads directly via MTProto (browser), sends metadata here.
// Compatible with Netlify (serverless-http) and local (node functions/server.js).
const express = require("express");
const path = require("path");
const serverless = require("serverless-http");

const store = require("./store");
const tg = require("./telegram");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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
    res.send(img);
  } catch (e) {
    fail(res, e.message, 500);
  }
});

// Stream video — server-side MTProto streaming with HTTP Range support
// Each browser range request → backend fetches 512KB chunks from Telegram → streams back
app.get("/api/videos/:id/stream", async (req, res) => {
  try {
    const v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);

    const streamFormat = store.toStreamFormat(v);
    let start = 0, end = streamFormat.tg_size - 1, status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        start = m[1] ? parseInt(m[1], 10) : 0;
        end = m[2] ? parseInt(m[2], 10) : streamFormat.tg_size - 1;
        status = 206;
      }
    }
    if (start >= streamFormat.tg_size) return fail(res, "Range not satisfiable", 416);

    res.status(status);
    res.set({
      "Content-Type": streamFormat.tg_mime || "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (status === 206) res.set("Content-Range", `bytes ${start}-${end}/${streamFormat.tg_size}`);

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

// Like / unlike (toggle) — edits Telegram metadata message directly
app.post("/api/videos/:id/like", async (req, res) => {
  try {
    const userId = (req.body.userId || "anon").slice(0, 64);
    const result = await store.toggleLike(req.params.id, userId);
    if (!result) return fail(res, "Video not found", 404);
    ok(res, result);
  } catch (e) { fail(res, e.message, 500); }
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

// ---- Netlify serverless handler + local listen ----
exports.handler = serverless(app);

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend running on port ${PORT}`);
    console.log(`Video channel:     ${process.env.TELEGRAM_CHANNEL_VIDEO || "(not set)"}`);
    console.log(`Thumbnail channel: ${process.env.TELEGRAM_CHANNEL_THUMB || "(not set)"}`);
    console.log(`Metadata channel:  ${process.env.TELEGRAM_CHANNEL_META || "(not set)"}`);
  });
}
