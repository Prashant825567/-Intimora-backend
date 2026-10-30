// Admin panel logic — upload (with client-side thumbnail), list, delete videos

const $ = (id) => document.getElementById(id);
let apiKey = localStorage.getItem("adminKey") || "";
let thumbnailFile = null;
let videoDuration = 0;

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return "" + n;
}
function fmtTime(s) { if (!s) return ""; const m = Math.floor(s / 60), x = s % 60; return m + ":" + String(x).padStart(2, "0"); }

function setStatus(id, msg, type) {
  const el = $(id);
  if (!msg) { el.style.display = "none"; return; }
  el.className = "status " + (type || "info");
  el.textContent = msg;
  el.style.display = "block";
}

// ---- API Key ----
function initKey() {
  if (apiKey) $("apiKey").value = apiKey;
}
function saveKey() {
  const key = $("apiKey").value.trim();
  if (!key) return setStatus("keyStatus", "Key dalo!", "err");
  apiKey = key;
  localStorage.setItem("adminKey", key);
  setStatus("keyStatus", "Key save hogya! ✅", "ok");
  loadVideos();
}

// ---- Client-side thumbnail generation ----
// Loads video in <video> element, seeks to 1s, draws to canvas, returns JPEG Blob.
function generateThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(file);

    video.addEventListener("loadedmetadata", () => {
      videoDuration = video.duration || 0;
      // seek to 1s, or middle if very short
      video.currentTime = Math.min(1, (video.duration || 2) / 2);
    });

    video.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        const w = 640;
        const h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, w, h);
        fetch(canvas.toDataURL("image/jpeg", 0.8))
          .then(r => r.blob())
          .then(blob => {
            URL.revokeObjectURL(video.src);
            resolve(blob);
          });
      } catch (e) {
        URL.revokeObjectURL(video.src);
        reject(new Error("Thumbnail generation failed: " + e.message));
      }
    });

    video.addEventListener("error", () => {
      URL.revokeObjectURL(video.src);
      reject(new Error("Yeh video se thumbnail nahi ban rahi hai. MP4/WebM format try karo."));
    });
  });
}

// ---- File selection ----
$("videoFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  $("fileName").textContent = file ? "Selected: " + file.name : "";
  $("thumbPreview").innerHTML = "";
  thumbnailFile = null;
  videoDuration = 0;

  if (!file) return;

  // thumbnail is compulsory — generate it now
  $("thumbStatus").textContent = "Thumbnail generate ho rahi hai...";
  $("thumbStatus").className = "status info";
  $("thumbStatus").style.display = "block";

  try {
    const blob = await generateThumbnail(file);
    thumbnailFile = new File([blob], "thumbnail.jpg", { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    $("thumbPreview").innerHTML = `<img src="${url}" style="width:200px;border-radius:8px;border:1px solid #333" />`;
    $("thumbStatus").textContent = "✅ Thumbnail ready! " + (videoDuration ? "Duration: " + fmtTime(videoDuration) : "");
    $("thumbStatus").className = "status ok";
  } catch (err) {
    $("thumbStatus").textContent = "❌ " + err.message;
    $("thumbStatus").className = "status err";
  }
});

// ---- Upload ----
async function uploadVideo() {
  if (!apiKey) return setStatus("uploadStatus", "Pehle API key save karo!", "err");
  const title = $("title").value.trim();
  const description = $("description").value.trim();
  const file = $("videoFile").files[0];

  if (!title) return setStatus("uploadStatus", "Title dalo!", "err");
  if (!file) return setStatus("uploadStatus", "Video file select karo!", "err");
  if (!thumbnailFile) return setStatus("uploadStatus", "Thumbnail zaroori hai — video select karo (auto-generate hogi)", "err");

  const btn = $("uploadBtn");
  btn.disabled = true;
  btn.textContent = "Uploading...";
  setStatus("uploadStatus", "Upload shuru hua... Telegram pe bhej rahe hain", "info");

  const formData = new FormData();
  formData.append("video", file);
  formData.append("thumbnail", thumbnailFile);
  formData.append("title", title);
  formData.append("description", description);
  formData.append("duration", videoDuration);

  try {
    const res = await fetch("/api/admin/videos", {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: formData,
    });

    if (!res.ok) {
      const j = await res.json();
      throw new Error(j.error || "Upload failed");
    }

    const j = await res.json();
    setStatus("uploadStatus", "✅ Video upload hogya! — " + j.data.title + " (id: " + j.data.id + ")", "ok");
    $("title").value = "";
    $("description").value = "";
    $("videoFile").value = "";
    $("fileName").textContent = "";
    $("thumbPreview").innerHTML = "";
    thumbnailFile = null;
    videoDuration = 0;
    setTimeout(loadVideos, 500);
  } catch (e) {
    setStatus("uploadStatus", "❌ " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload to Telegram";
  }
}

// ---- List ----
async function loadVideos() {
  if (!apiKey) { $("videoList").innerHTML = "<p class='empty'>Pehle API key save karo.</p>"; return; }
  const list = $("videoList");
  list.innerHTML = "<p class='empty'>Loading...</p>";
  try {
    const res = await fetch("/api/admin/videos", { headers: { "x-api-key": apiKey } });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "Failed");
    const videos = j.data;
    $("count").textContent = videos.length;
    if (!videos.length) {
      list.innerHTML = "<p class='empty'>Koi video nahi hai. Pehla upload karo! ⬆️</p>";
      return;
    }
    list.innerHTML = videos.map(v => `
      <div class="video-item">
        <img class="v-thumb" src="${v.thumbnailUrl}" alt=""
             onerror="this.style.display='none'" loading="lazy" />
        <div class="v-info">
          <div class="v-title">${escapeHtml(v.title)} <span class="tag">${fmtTime(v.duration)}</span></div>
          <div class="v-stats">▶ ${fmt(v.views)} · ❤ ${fmt(v.likes)} · ↗ ${fmt(v.shares)} · ${(v.size/1048576).toFixed(1)}MB</div>
          <div class="v-id">id: ${v.id}</div>
        </div>
        <button class="btn-danger" onclick="deleteVideo('${v.id}')">Delete</button>
      </div>
    `).join("");
  } catch (e) {
    list.innerHTML = "<p class='empty'>❌ " + escapeHtml(e.message) + "</p>";
  }
}

function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- Delete ----
async function deleteVideo(id) {
  if (!confirm("Delete karna hai? Ye video Telegram se bhi hat jayega.")) return;
  try {
    const res = await fetch("/api/admin/videos/" + id + "/delete", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await res.json();
    if (j.ok) await loadVideos();
    else alert("Delete failed: " + (j.error || "unknown"));
  } catch (e) {
    alert("Delete error: " + e.message);
  }
}

// init
initKey();
loadVideos();
