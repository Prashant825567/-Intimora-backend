// Telegram-based data store — replaces SQLite entirely.
// All video metadata is stored as JSON text messages in Telegram.
// No database, no SQLite — works on any serverless platform (Netlify, Vercel, etc.)
const tg = require("./telegram");

// ---- UUID generator ----
function newId() {
  return require("crypto").randomUUID();
}

// ---- Convert Telegram metadata to stream format (for tg.streamRange / tg.fetchThumbnail) ----
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

// ---- List videos (infinite scroll) ----
// Fetches all metadata messages, sorts by createdAt desc, paginates by cursor.
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

// ---- Get single video by id ----
async function getVideo(id) {
  return await tg.findVideoById(id);
}

// ---- Search videos by title ----
async function searchVideos(query) {
  const metas = await tg.readMetadataFromTelegram(5000);
  const q = query.toLowerCase().trim();
  return metas.filter(m => (m.title || "").toLowerCase().includes(q));
}

// ---- Add video (send metadata to Telegram) ----
async function addVideo(data) {
  const metadata = tg.buildMetadata(data);
  const msgId = await tg.sendMetadata(metadata);
  return { ...metadata, meta_msg_id: msgId };
}

// ---- Increment views ----
async function incrementViews(id) {
  const v = await tg.findVideoById(id);
  if (!v) return null;
  return await tg.updateVideoStats(id, { views: (v.views || 0) + 1 });
}

// ---- Toggle like / unlike ----
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

// ---- Increment shares ----
async function incrementShares(id) {
  const v = await tg.findVideoById(id);
  if (!v) return null;
  return await tg.updateVideoStats(id, { shares: (v.shares || 0) + 1 });
}

// ---- Delete video (deletes all 3 messages from Telegram) ----
async function deleteVideo(id) {
  return await tg.deleteVideoMessages(id);
}

// ---- Get all videos (admin list) ----
async function listAllVideos() {
  const metas = await tg.readMetadataFromTelegram(5000);
  metas.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return metas;
}

module.exports = {
  newId,
  toStreamFormat,
  listVideos,
  getVideo,
  searchVideos,
  addVideo,
  incrementViews,
  toggleLike,
  incrementShares,
  deleteVideo,
  listAllVideos,
};
