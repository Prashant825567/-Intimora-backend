// Frontend logic: infinite scroll, search, video player, like/share.
const grid = document.getElementById("grid");
const sentinel = document.getElementById("sentinel");
const endOfList = document.getElementById("endOfList");

const PAGE = 12;
let cursor = 0;
let loading = false;
let searchMode = false;

// stable anonymous user id for likes (localStorage)
const userId = (localStorage.getItem("uid") || (localStorage.setItem("uid", crypto.randomUUID()), localStorage.getItem("uid"))).slice(0, 64);

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return "" + n;
}
function fmtTime(s) { if (!s) return ""; const m = Math.floor(s / 60), x = s % 60; return m + ":" + String(x).padStart(2, "0"); }

function cardEl(v) {
  const c = document.createElement("div");
  c.className = "card";
  c.innerHTML = `
    <div class="thumb">
      <img src="${v.thumbnailUrl}" alt="" loading="lazy"
           onerror="this.parentNode.innerHTML='<div class=\\'ph\\'>🎬</div>'" />
      ${v.duration ? `<span class="dur">${fmtTime(v.duration)}</span>` : ""}
    </div>
    <div class="info">
      <div class="title">${escapeHtml(v.title)}</div>
      <div class="stats">▶ ${fmt(v.views)} · ❤ ${fmt(v.likes)} · ↗ ${fmt(v.shares)}</div>
    </div>`;
  c.addEventListener("click", () => openPlayer(v.id));
  return c;
}
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function loadMore() {
  if (loading) return;
  loading = true;
  sentinel.hidden = false;
  endOfList.hidden = true;
  try {
    if (searchMode) return; // search doesn't paginate
    const url = `/api/videos?cursor=${cursor}&limit=${PAGE}`;
    const r = await fetch(url);
    const j = await r.json();
    const videos = j.data.videos;
    if (!videos.length) { endOfList.hidden = false; return; }
    videos.forEach((v) => grid.appendChild(cardEl(v)));
    cursor = j.data.nextCursor || cursor;
    if (!j.data.nextCursor) { endOfList.hidden = false; }
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
    sentinel.hidden = true;
  }
}

// infinite scroll via IntersectionObserver
const io = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) loadMore();
}, { rootMargin: "400px" });
io.observe(sentinel);

// search
document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});
document.getElementById("clearSearch").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  resetList();
});

async function runSearch() {
  const q = document.getElementById("searchInput").value.trim();
  grid.innerHTML = "";
  if (!q) { resetList(); return; }
  searchMode = true;
  sentinel.hidden = true;
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j.data.videos.length) { grid.innerHTML = "<p style='color:var(--muted);padding:20px'>No results.</p>"; return; }
    j.data.videos.forEach((v) => grid.appendChild(cardEl(v)));
  } catch (e) { console.error(e); }
}

function resetList() {
  searchMode = false;
  grid.innerHTML = "";
  cursor = 0;
  loadMore();
}

// ===== player modal =====
const player = document.getElementById("player");
const video = document.getElementById("video");
const likeBtn = document.getElementById("likeBtn");
const likeCount = document.getElementById("likeCount");
const likeIcon = document.getElementById("likeIcon");
const shareCount = document.getElementById("shareCount");
const copyLink = document.getElementById("copyLink");

let currentVideo = null;
let currentLiked = false;

async function openPlayer(id) {
  player.hidden = false;
  document.body.style.overflow = "hidden";
  const r = await fetch(`/api/videos/${id}`);
  const j = await r.json();
  if (!j.ok) return;
  currentVideo = j.data;
  currentLiked = localStorage.getItem("liked:" + id) === "1";

  document.getElementById("vTitle").textContent = currentVideo.title;
  document.getElementById("vMeta").textContent =
    `▶ ${fmt(currentVideo.views)} views · ❤ ${fmt(currentVideo.likes)} likes · ↗ ${fmt(currentVideo.shares)} shares`;
  document.getElementById("vDesc").textContent = currentVideo.description || "";
  likeCount.textContent = fmt(currentVideo.likes);
  shareCount.textContent = fmt(currentVideo.shares);
  updateLikeBtn();

  copyLink.href = `${location.origin}/?v=${id}`;

  video.src = currentVideo.streamUrl;
  video.load();
}

function closePlayer() {
  player.hidden = true;
  video.pause();
  video.removeAttribute("src");
  video.load();
  document.body.style.overflow = "";
}
document.getElementById("closePlayer").addEventListener("click", closePlayer);
player.addEventListener("click", (e) => { if (e.target === player) closePlayer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !player.hidden) closePlayer(); });

function updateLikeBtn() {
  if (currentLiked) { likeBtn.classList.add("liked"); likeIcon.textContent = "❤"; }
  else { likeBtn.classList.remove("liked"); likeIcon.textContent = "👍"; }
}

likeBtn.addEventListener("click", async () => {
  if (!currentVideo) return;
  const r = await fetch(`/api/videos/${currentVideo.id}/like`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const j = await r.json();
  if (!j.ok) return;
  currentLiked = j.data.liked;
  localStorage.setItem("liked:" + currentVideo.id, currentLiked ? "1" : "0");
  likeCount.textContent = fmt(j.data.likes);
  document.getElementById("vMeta").textContent =
    `▶ ${fmt(currentVideo.views)} views · ❤ ${fmt(j.data.likes)} likes · ↗ ${fmt(currentVideo.shares)} shares`;
  updateLikeBtn();
});

shareBtn.addEventListener("click", async () => {
  if (!currentVideo) return;
  const r = await fetch(`/api/videos/${currentVideo.id}/share`, { method: "POST" });
  const j = await r.json();
  if (j.ok) {
    shareCount.textContent = fmt(j.data.shares);
    // try native share on mobile
    if (navigator.share) {
      navigator.share({ title: currentVideo.title, url: copyLink.href }).catch(() => {});
    } else {
      navigator.clipboard.writeText(copyLink.href);
      alert("Link copied!");
    }
  }
});

copyLink.addEventListener("click", (e) => {
  e.preventDefault();
  navigator.clipboard.writeText(copyLink.href);
  alert("Link copied!");
});

// deep link ?v=id
const params = new URLSearchParams(location.search);
const vid = params.get("v");
if (vid) openPlayer(vid);

// initial load
loadMore();
