// Express server — public API + admin API + static frontend.
// Compatible with Netlify (serverless-http) and local (node src/server.js).
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const serverless = require("serverless-http");

const store = require("./store");
const tg = require("./telegram");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = parseInt(process.env.PORT, 10) || 10000;
const TMP_DIR = "/tmp"; // writable on Netlify + local

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
    console.error("thumb error:", e.message);
    fail(res, "Thumbnail unavailable", 500);
  }
});

// Stream video — redirects to Telegram CDN (serverless-friendly)
// Falls back to server streaming if TELEGRAM_CHANNEL_PUBLIC is not set
app.get("/api/videos/:id/stream", async (req, res) => {
  try {
    const v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);

    // Try Telegram CDN redirect (best for serverless platforms)
    const directUrl = tg.getDirectUrl(v);
    if (directUrl) {
      return res.redirect(302, directUrl);
    }

    // Fallback: server streaming (for local / Render)
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
    console.error("stream error:", e.message);
    try { res.end(); } catch {}
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

app.post("/api/admin/login/code", async (req, res) => {
  try { await tg.sendLoginCode(req.body.phoneNumber); ok(res, { sent: true }); }
  catch (e) { fail(res, e.message, 400); }
});

app.post("/api/admin/login/verify", async (req, res) => {
  try {
    const result = await tg.verifyLogin(req.body.phoneNumber, req.body.phoneCode);
    ok(res, result);
  } catch (e) { fail(res, e.message, 400); }
});

// Upload video + thumbnail (both required — thumbnail generated client-side)
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB (Telegram MTProto free limit)
});

app.post("/api/admin/videos", adminAuth, upload.fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const thumbFile = req.files?.thumbnail?.[0];
  if (!videoFile) return fail(res, "No video file uploaded");
  if (!thumbFile) return fail(res, "Thumbnail is required — generate it client-side");
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  if (!title) return fail(res, "Title required");

  const tmpFile = videoFile.path;
  const thumbPath = thumbFile.path;

  try {
    const videoId = store.newId();
    const duration = parseInt(req.body.duration, 10) || 0;

    // 1) upload video to Telegram (thumbnail attached to document)
    const tgLoc = await tg.uploadVideo(tmpFile, {
      caption: title,
      thumbPath,
    });

    // 2) build metadata + send to Telegram as JSON text message
    const videoObj = {
      id: videoId,
      title,
      description,
      views: 0, likes: 0, shares: 0, likedBy: [],
      duration,
      created_at: Math.floor(Date.now() / 1000),
      tg_doc_id: tgLoc.tg_doc_id,
      tg_access_hash: tgLoc.tg_access_hash,
      tg_file_ref: tgLoc.tg_file_ref,
      tg_size: tgLoc.tg_size,
      tg_mime: tgLoc.tg_mime,
      tg_msg_id: tgLoc.tg_msg_id,
      tg_filename: videoFile.originalname || "video.mp4",
      thumb_doc_id: tgLoc.thumb_doc_id,
      thumb_access_hash: tgLoc.thumb_access_hash,
      thumb_file_ref: tgLoc.thumb_file_ref,
      thumb_size: tgLoc.thumb_size,
      thumb_msg_id: tgLoc.thumb_msg_id,
    };
    const metadata = tg.buildMetadata(videoObj);
    const metaMsgId = await tg.sendMetadata(metadata);

    ok(res, publicVideo({ ...metadata, meta_msg_id: metaMsgId }));
  } catch (e) {
    console.error("upload error:", e);
    fail(res, e.message || "Upload failed", 500);
  } finally {
    for (const f of [tmpFile, thumbPath]) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
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

// Admin: upload custom thumbnail (replaces existing)
const thumbUpload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `custom-thumb-${Date.now()}.jpg`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("File must be an image (jpg/png/webp)"));
  },
});

app.post("/api/admin/videos/:id/thumbnail", adminAuth, thumbUpload.single("thumbnail"), async (req, res) => {
  const file = req.file;
  if (!file) return fail(res, "No thumbnail file uploaded");
  try {
    const thumbLoc = await tg.uploadThumbnail(file.path);
    const v = await store.getVideo(req.params.id);
    if (!v) return fail(res, "Video not found", 404);
    // update metadata in Telegram
    const updated = await tg.updateVideoStats(req.params.id, {
      thumbnail: {
        docId: thumbLoc.thumb_doc_id,
        accessHash: thumbLoc.thumb_access_hash,
        fileRef: thumbLoc.thumb_file_ref,
        size: thumbLoc.thumb_size,
        msgId: thumbLoc.thumb_msg_id,
      },
    });
    ok(res, publicVideo(updated));
  } catch (e) {
    fail(res, e.message, 500);
  } finally {
    try { fs.unlinkSync(file.path); } catch {}
  }
});

// ============================================================
// STATIC FRONTEND
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
    console.log(`Content site running on port ${PORT}`);
    console.log(`Telegram channel: ${process.env.TELEGRAM_CHANNEL || "(not set)"}`);
  });
}
