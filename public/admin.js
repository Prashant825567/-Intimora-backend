// Admin panel logic — upload, list, delete videos

const $ = (id) => document.getElementById(id);
let apiKey = localStorage.getItem("adminKey") || "";

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

// ---- File name display ----
$("videoFile").addEventListener("change", (e) => {
  $("fileName").textContent = e.target.files[0] ? "Selected: " + e.target.files[0].name : "";
});

// ---- Upload ----
async function uploadVideo() {
  if (!apiKey) return setStatus("uploadStatus", "Pehle API key save karo!", "err");
  const title = $("title").value.trim();
  const description = $("description").value.trim();
  const file = $("videoFile").files[0];
  if (!title) return setStatus("uploadStatus", "Title dalo!", "err");
  if (!file) return setStatus("uploadStatus", "Video file select karo!", "err");

  const btn = $("uploadBtn");
  btn.disabled = true;
  btn.textContent = "Uploading...";
  $("progress").style.display = "block";
  $("progressBar").style.width = "10%";
  setStatus("uploadStatus", "Upload shuru hua... Telegram pe bhej rahe hain (video size ke hisaab se time lagega)", "info");

  const formData = new FormData();
  formData.append("video", file);
  formData.append("title", title);
  formData.append("description", description);

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
    $("progressBar").style.width = "100%";
    setStatus("uploadStatus",
      "✅ Video upload hogya! — " + j.data.title + " (id: " + j.data.id + ")", "ok");
    // reset form
    $("title").value = "";
    $("description").value = "";
    $("videoFile").value = "";
    $("fileName").textContent = "";
    setTimeout(loadVideos, 500);
  } catch (e) {
    setStatus("uploadStatus", "❌ " + e.message, "err");
  } finally {
    $("progress").style.display = "none";
    $("progressBar").style.width = "0%";
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
    if (j.ok) {
      await loadVideos();
    } else {
      alert("Delete failed: " + (j.error || "unknown"));
    }
  } catch (e) {
    alert("Delete error: " + e.message);
  }
}

// init
initKey();
loadVideos();
