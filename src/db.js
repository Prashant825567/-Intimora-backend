// SQLite database layer (better-sqlite3 — fast, synchronous, works on Render)
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "content.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---- schema ----
db.exec(`
CREATE TABLE IF NOT EXISTS videos (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT    NOT NULL UNIQUE,           -- public id (uuid)
  title            TEXT    NOT NULL,
  description      TEXT    DEFAULT '',
  -- Telegram document location (video stored as a document = exact bytes)
  tg_doc_id        TEXT    NOT NULL,                  -- BigInt as string
  tg_access_hash   TEXT    NOT NULL,                  -- BigInt as string
  tg_file_ref      TEXT    NOT NULL,                  -- base64
  tg_size          INTEGER NOT NULL,
  tg_mime          TEXT    DEFAULT '',
  tg_channel       TEXT    NOT NULL,
  tg_msg_id        INTEGER NOT NULL,
  -- metadata message id in Telegram (JSON text message in the channel)
  meta_msg_id      INTEGER DEFAULT 0,
  -- thumbnail (uploaded as a separate photo on Telegram)
  thumb_doc_id     TEXT,
  thumb_access_hash TEXT,
  thumb_file_ref   TEXT,
  thumb_size       INTEGER DEFAULT 0,
  -- stats
  views            INTEGER DEFAULT 0,
  likes            INTEGER DEFAULT 0,
  shares          INTEGER DEFAULT 0,
  duration         INTEGER DEFAULT 0,                 -- seconds (from ffmpeg)
  -- timestamps
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS likes (
  video_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,                             -- client localStorage uuid
  created_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_seq       ON videos(seq DESC);
CREATE INDEX IF NOT EXISTS idx_videos_created   ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_title     ON videos(title);
CREATE INDEX IF NOT EXISTS idx_likes_video      ON likes(video_id);
`);

// migration: add meta_msg_id to existing DBs
{
  const cols = db.prepare("PRAGMA table_info(videos)").all().map((c) => c.name);
  if (!cols.includes("meta_msg_id")) {
    db.exec("ALTER TABLE videos ADD COLUMN meta_msg_id INTEGER DEFAULT 0");
  }
}

const now = () => Math.floor(Date.now() / 1000);

// ---- public id ----
const { randomUUID } = require("crypto");
function newId() {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

// ---- insert ----
const insertVideo = db.prepare(`
INSERT INTO videos (
  id, title, description,
  tg_doc_id, tg_access_hash, tg_file_ref, tg_size, tg_mime, tg_channel, tg_msg_id,
  meta_msg_id,
  thumb_doc_id, thumb_access_hash, thumb_file_ref, thumb_size,
  duration, created_at, updated_at
) VALUES (
  @id, @title, @description,
  @tg_doc_id, @tg_access_hash, @tg_file_ref, @tg_size, @tg_mime, @tg_channel, @tg_msg_id,
  @meta_msg_id,
  @thumb_doc_id, @thumb_access_hash, @thumb_file_ref, @thumb_size,
  @duration, @created_at, @updated_at
)
`);

function addVideo(v) {
  const id = v.id || newId();
  const t = now();
  insertVideo.run({
    id,
    title: v.title,
    description: v.description || "",
    tg_doc_id: String(v.tg_doc_id),
    tg_access_hash: String(v.tg_access_hash),
    tg_file_ref: v.tg_file_ref,
    tg_size: v.tg_size,
    tg_mime: v.tg_mime || "",
    tg_channel: v.tg_channel,
    tg_msg_id: v.tg_msg_id,
    meta_msg_id: v.meta_msg_id || 0,
    thumb_doc_id: v.thumb_doc_id ? String(v.thumb_doc_id) : null,
    thumb_access_hash: v.thumb_access_hash ? String(v.thumb_access_hash) : null,
    thumb_file_ref: v.thumb_file_ref || null,
    thumb_size: v.thumb_size || 0,
    duration: v.duration || 0,
    created_at: t,
    updated_at: t,
  });
  return getVideo(id);
}

// ---- get ----
const getVideoStmt = db.prepare("SELECT * FROM videos WHERE id = ?");
function getVideo(id) {
  return getVideoStmt.get(id);
}

// ---- update meta_msg_id (when metadata message is created after insert) ----
const updateMetaMsgId = db.prepare("UPDATE videos SET meta_msg_id = ?, updated_at = ? WHERE id = ?");
function setMetaMsgId(videoId, metaMsgId) {
  updateMetaMsgId.run(metaMsgId, now(), videoId);
}

// ---- upsert a video from Telegram metadata (sync / rebuild from Telegram) ----
// `meta` is the parsed metadata object from a Telegram JSON message.
// If the video already exists (by id), stats are preserved; only file/desc/meta_msg_id update.
const existingVideo = db.prepare("SELECT id FROM videos WHERE id = ?");
const insertFromMeta = db.prepare(`
INSERT INTO videos (
  id, title, description,
  tg_doc_id, tg_access_hash, tg_file_ref, tg_size, tg_mime, tg_channel, tg_msg_id,
  meta_msg_id,
  thumb_doc_id, thumb_access_hash, thumb_file_ref, thumb_size,
  duration, created_at, updated_at
) VALUES (
  @id, @title, @description,
  @tg_doc_id, @tg_access_hash, @tg_file_ref, @tg_size, @tg_mime, @tg_channel, @tg_msg_id,
  @meta_msg_id,
  @thumb_doc_id, @thumb_access_hash, @thumb_file_ref, @thumb_size,
  @duration, @created_at, @updated_at
)
`);
const updateMetaFields = db.prepare(`
UPDATE videos SET
  title=@title, description=@description,
  tg_doc_id=@tg_doc_id, tg_access_hash=@tg_access_hash, tg_file_ref=@tg_file_ref,
  tg_size=@tg_size, tg_mime=@tg_mime, tg_msg_id=@tg_msg_id, meta_msg_id=@meta_msg_id,
  thumb_doc_id=@thumb_doc_id, thumb_access_hash=@thumb_access_hash,
  thumb_file_ref=@thumb_file_ref, thumb_size=@thumb_size,
  duration=@duration, updated_at=@updated_at
WHERE id=@id
`);

function upsertVideoFromMeta(meta) {
  const v = meta.video || {};
  const th = meta.thumbnail || {};
  const t = now();
  const row = {
    id: meta.id,
    title: meta.title || "",
    description: meta.description || "",
    tg_doc_id: String(v.docId || ""),
    tg_access_hash: String(v.accessHash || ""),
    tg_file_ref: v.fileRef || "",
    tg_size: Number(v.size || 0),
    tg_mime: v.mime || "",
    tg_channel: process.env.TELEGRAM_CHANNEL || "",
    tg_msg_id: Number(v.msgId || 0),
    meta_msg_id: Number(meta._msgId || 0),
    thumb_doc_id: th.docId ? String(th.docId) : null,
    thumb_access_hash: th.accessHash ? String(th.accessHash) : null,
    thumb_file_ref: th.fileRef || null,
    thumb_size: Number(th.size || 0),
    duration: Number(meta.duration || 0),
    created_at: meta.createdAt || t,
    updated_at: t,
  };
  if (existingVideo.get(meta.id)) {
    updateMetaFields.run(row);
  } else {
    insertFromMeta.run(row);
  }
  return getVideo(meta.id);
}

// ---- list (cursor pagination for infinite scroll) ----
// cursor=0 => latest page (no upper filter); cursor>0 => seq < cursor
const listVideosStmt = db.prepare(`
SELECT seq, id, title, description, tg_size, tg_mime, thumb_size,
       views, likes, shares, duration, created_at
FROM videos
WHERE @cursor = 0 OR seq < @cursor
ORDER BY seq DESC
LIMIT @limit
`);
function listVideos(cursor = 0, limit = 12) {
  return listVideosStmt.all({ cursor: cursor || 0, limit: Math.min(limit, 50) });
}

// ---- search ----
const searchVideosStmt = db.prepare(`
SELECT id, title, description, tg_size, tg_mime, thumb_size,
       views, likes, shares, duration, created_at
FROM videos
WHERE title LIKE @q OR description LIKE @q
ORDER BY seq DESC
LIMIT @limit
`);
function searchVideos(q, limit = 12) {
  const like = `%${q}%`;
  return searchVideosStmt.all({ q: like, limit: Math.min(limit, 50) });
}

// ---- stats ----
const bumpView = db.prepare("UPDATE videos SET views = views + 1 WHERE id = ?");
const bumpShare = db.prepare("UPDATE videos SET shares = shares + 1 WHERE id = ?");

function incrementViews(id) { bumpView.run(id); }
function incrementShares(id) { bumpShare.run(id); }

// ---- likes (toggle) ----
const getLike = db.prepare("SELECT 1 FROM likes WHERE video_id = ? AND user_id = ?");
const addLike = db.prepare("INSERT OR IGNORE INTO likes (video_id, user_id, created_at) VALUES (?, ?, ?)");
const delLike = db.prepare("DELETE FROM likes WHERE video_id = ? AND user_id = ?");
const countLikes = db.prepare("SELECT COUNT(*) AS c FROM likes WHERE video_id = ?");

function toggleLike(videoId, userId) {
  if (getLike.get(videoId, userId)) {
    delLike.run(videoId, userId);
    db.prepare("UPDATE videos SET likes = likes - 1, updated_at = ? WHERE id = ? AND likes > 0")
      .run(now(), videoId);
    return { liked: false, likes: countLikes.get(videoId).c };
  }
  addLike.run(videoId, userId, now());
  db.prepare("UPDATE videos SET likes = likes + 1, updated_at = ? WHERE id = ?").run(now(), videoId);
  return { liked: true, likes: countLikes.get(videoId).c };
}

// ---- delete ----
const delVideo = db.prepare("DELETE FROM videos WHERE id = ?");
const delLikes = db.prepare("DELETE FROM likes WHERE video_id = ?");
function deleteVideo(id) {
  delLikes.run(id);
  delVideo.run(id);
}

module.exports = {
  db,
  addVideo,
  getVideo,
  listVideos,
  searchVideos,
  incrementViews,
  incrementShares,
  toggleLike,
  deleteVideo,
  setMetaMsgId,
  upsertVideoFromMeta,
  newId,
};
