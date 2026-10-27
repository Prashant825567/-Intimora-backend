// Express server — public API + admin API + static frontend.
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const db = require("./db");
const tg = require("./telegram");
const { generateThumbnail, getDuration, faststart, TMP_DIR } = require("./ffmpeg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = parseInt(process.env.PORT, 10) || 10000;

// ---- helpers ----
function ok(res, data) { return res.json({ ok: true, data }); }
function fail(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

// serialize a video row for the public API (no Telegram internals)
function publicVideo(v) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    size: v.tg_size,
    mime: v.tg_mime,
    thumbSize: v.thumb_size,
    duration: v.duration,
    views: v.views,
    likes: v.likes,
    shares: v.shares,
    createdAt: v.created_at,
    streamUrl: `/api/videos/${v.id}/stream`,
    thumbnailUrl: `/api/videos/${v.id}/thumbnail`,
  };
}

// ---- debounced metadata sync to Telegram ----
// SQLite is updated immediately (fast); Telegram metadata message is updated
// after a short debounce so rapid view/like spikes don't spam Telegram edits.
const syncTimers = new Map();
function scheduleMetaSync(videoId, delay = 5000) {
  if (syncTimers.has(videoId)) clearTimeout(syncTimers.get(videoId));
  syncTimers.set(videoId, setTimeout(async () => {
    syncTimers.delete(videoId);
    try {
      const v = db.getVideo(videoId);
      if (v && v.meta_msg_id) await tg.syncMetadataToTelegram(v);
    } catch (e) { console.error("meta sync error:", e.message); }
  }, delay));
}

// ---- admin auth ----
function adminAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) return fail(res, "Unauthorized", 401);
  next();
}

// ============================================================
// PUBLIC API
// ============================================================

app.get("/api/health", (req, res) => ok(res, { status: "up", time: Date.now() }));

// Infinite scroll: cursor-based pagination (oldest seq in page = next cursor)
app.get("/api/videos", (req, res) => {
  const cursor = parseInt(req.query.cursor, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
  const rows = db.listVideos(cursor, limit);
  const videos = rows.map(publicVideo);
  const nextCursor = videos.length ? rows[rows.length - 1].seq : null;
  ok(res, { videos, nextCursor });
});

// Search
app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return ok(res, { videos: [], nextCursor: null });
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
  const rows = db.searchVideos(q, limit);
  ok(res, { videos: rows.map(publicVideo), nextCursor: null });
});

// Video detail (counts a view)
app.get("/api/videos/:id", (req, res) => {
  const v = db.getVideo(req.params.id);
  if (!v) return fail(res, "Video not found", 404);
  db.incrementViews(v.id);
  scheduleMetaSync(v.id, 60000); // views sync with long debounce
  ok(res, publicVideo(db.getVideo(v.id)));
});

// Thumbnail (proxy from Telegram, cached-friendly)
app.get("/api/videos/:id/thumbnail", async (req, res) => {
  const v = db.getVideo(req.params.id);
  if (!v) return fail(res, "Video not found", 404);
  try {
    const img = await tg.fetchThumbnail(v);
    if (!img) return fail(res, "No thumbnail", 404);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(img);
  } catch (e) {
    console.error("thumb error:", e.message);
    fail(res, "Thumbnail unavailable", 500);
  }
});

// Stream video — HTTP Range support (plays in browser, no direct download link)
app.get("/api/videos/:id/stream", async (req, res) => {
  const v = db.getVideo(req.params.id);
  if (!v) return fail(res, "Video not found", 404);

  // parse Range: bytes=start-end
  let start = 0;
  let end = v.tg_size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? parseInt(m[2], 10) : v.tg_size - 1;
      status = 206;
    }
  }
  if (start >= v.tg_size) return fail(res, "Range not satisfiable", 416);

  res.status(status);
  res.set({
    "Content-Type": v.tg_mime || "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Disposition": "inline",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (status === 206) res.set("Content-Range", `bytes ${start}-${end}/${v.tg_size}`);

  try {
    for await (const chunk of tg.streamRange(v, start, end)) {
      if (!res.write(chunk)) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (e) {
    console.error("stream error:", e.message);
    res.end();
  }
});

// Like / unlike (toggle) — user id from client (localStorage uuid)
app.post("/api/videos/:id/like", (req, res) => {
  const v = db.getVideo(req.params.id);
  if (!v) return fail(res, "Video not found", 404);
  const userId = (req.body.userId || "anon").slice(0, 64);
  const result = db.toggleLike(v.id, userId);
  scheduleMetaSync(v.id, 5000);
  ok(res, result);
});

// Record a share
app.post("/api/videos/:id/share", (req, res) => {
  const v = db.getVideo(req.params.id);
  if (!v) return fail(res, "Video not found", 404);
  db.incrementShares(v.id);
  scheduleMetaSync(v.id, 5000);
  ok(res, { shares: v.shares + 1 });
});

// ============================================================
// ADMIN API
// ============================================================

// Two-step Telegram login (no 2FA). For 2FA use `npm run login`.
app.post("/api/admin/login/code", async (req, res) => {
  try {
    await tg.sendLoginCode(req.body.phoneNumber);
    ok(res, { sent: true });
  } catch (e) { fail(res, e.message, 400); }
});

app.post("/api/admin/login/verify", async (req, res) => {
  try {
    const result = await tg.verifyLogin(req.body.phoneNumber, req.body.phoneCode);
    ok(res, result);
  } catch (e) { fail(res, e.message, 400); }
});

// Upload a video (admin only)
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB (Telegram MTProto free limit)
});

app.post("/api/admin/videos", adminAuth, upload.single("video"), async (req, res) => {
  const file = req.file;
  if (!file) return fail(res, "No video file uploaded");
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  if (!title) return fail(res, "Title required");

  const tmpFile = file.path;
  const thumbPath = path.join(TMP_DIR, `thumb-${Date.now()}.jpg`);
  const optimizedPath = path.join(TMP_DIR, `opt-${Date.now()}.mp4`);

  try {
    // 1) generate thumbnail + read duration (best-effort)
    let duration = 0;
    try { duration = await getDuration(tmpFile); } catch {}
    try { await generateThumbnail(tmpFile, thumbPath); } catch (e) {
      console.error("thumbnail failed:", e.message);
    }

    // 2) optionally faststart-remux for smooth seeking (stream copy, no re-encode)
    let uploadFile = tmpFile;
    try {
      const okFast = await faststart(tmpFile, optimizedPath);
      if (okFast && fs.existsSync(optimizedPath)) uploadFile = optimizedPath;
    } catch (e) { console.error("faststart failed, using original:", e.message); }

    // 3) upload to Telegram channel
    const videoId = db.newId();
    const tgLoc = await tg.uploadVideo(uploadFile, {
      caption: title,
      thumbPath: fs.existsSync(thumbPath) ? thumbPath : null,
    });

    // 4) build metadata + send it to Telegram as a JSON text message
    const videoObj = {
      id: videoId,
      title,
      description,
      views: 0, likes: 0, shares: 0,
      duration,
      created_at: Math.floor(Date.now() / 1000),
      tg_doc_id: tgLoc.tg_doc_id,
      tg_access_hash: tgLoc.tg_access_hash,
      tg_file_ref: tgLoc.tg_file_ref,
      tg_size: tgLoc.tg_size,
      tg_mime: tgLoc.tg_mime,
      tg_msg_id: tgLoc.tg_msg_id,
      thumb_doc_id: tgLoc.thumb_doc_id,
      thumb_access_hash: tgLoc.thumb_access_hash,
      thumb_file_ref: tgLoc.thumb_file_ref,
      thumb_size: tgLoc.thumb_size,
    };
    const metadata = tg.buildMetadata(videoObj);
    const metaMsgId = await tg.sendMetadata(metadata);

    // 5) store in SQLite (cache) with the metadata message id
    const video = db.addVideo({
      id: videoId,
      title,
      description,
      tg_doc_id: tgLoc.tg_doc_id,
      tg_access_hash: tgLoc.tg_access_hash,
      tg_file_ref: tgLoc.tg_file_ref,
      tg_size: tgLoc.tg_size,
      tg_mime: tgLoc.tg_mime,
      tg_channel: tgLoc.tg_channel,
      tg_msg_id: tgLoc.tg_msg_id,
      meta_msg_id: metaMsgId,
      thumb_doc_id: tgLoc.thumb_doc_id,
      thumb_access_hash: tgLoc.thumb_access_hash,
      thumb_file_ref: tgLoc.thumb_file_ref,
      thumb_size: tgLoc.thumb_size,
      duration,
    });

    ok(res, publicVideo(video));
  } catch (e) {
    console.error("upload error:", e);
    fail(res, e.message || "Upload failed", 500);
  } finally {
    // cleanup temp files
    for (const f of [tmpFile, thumbPath, optimizedPath]) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
});

// List / delete videos (admin)
app.get("/api/admin/videos", adminAuth, (req, res) => {
  const rows = db.listVideos(0, 100);
  ok(res, rows.map(publicVideo));
});

app.post("/api/admin/videos/:id/delete", adminAuth, (req, res) => {
  const v = db.getVideo(req.params.id);
  if (!v) return fail(res, "Video not found", 404);
  db.deleteVideo(v.id);
  ok(res, { deleted: true });
});

// Rebuild SQLite cache from Telegram metadata (sync / restore after DB loss)
app.get("/api/admin/sync", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    const metas = await tg.readMetadataFromTelegram(limit);
    let restored = 0;
    for (const m of metas) {
      db.upsertVideoFromMeta(m);
      restored++;
    }
    ok(res, { restored, total: metas.length });
  } catch (e) {
    console.error("sync error:", e);
    fail(res, e.message || "Sync failed", 500);
  }
});

// ============================================================
// STATIC FRONTEND
// ============================================================
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Content site running on port ${PORT}`);
  console.log(`Telegram channel: ${process.env.TELEGRAM_CHANNEL || "(not set)"}`);
});
