# 🎬 Content Site — Telegram MTProto Storage on Render

A video content site where videos are stored in a **Telegram private channel** (via MTProto),
served through your own backend. Features: infinite-scroll home, search, video playback
(streaming, no direct download), thumbnails, likes & shares.

```
Browser ──▶ Render (Express)
                │
                ├──▶ SQLite (fast cache: metadata + stats)
                │
                └──▶ Telegram MTProto ──▶ private channel
                                          ├── video documents (file bytes)
                                          ├── thumbnail photos
                                          └── metadata JSON messages (source of truth)
```

> **Metadata kahan raheta hai?** Har video ka metadata (title, description, views, likes, shares, file locations) **Telegram me bhi** store hota hai — ek JSON text message ke roop me channel me. SQLite ek fast cache hai. Stats change pe Telegram message update hota hai (debounce se). DB lost ho toh `/api/admin/sync` se Telegram se rebuild kar sakte ho.

---

## ⭐ Tumhara sawal: Telegram me kitne channels banau?

**Answer: Abhi sirf 1 private channel kafi hai.**

- Telegram me channel storage ka koi limit nahi hai (sirf per-file limit hai: free me **2 GB**, premium me 4 GB).
- Ek private channel me hazaaron videos rakh sakte ho — ek channel sufficient hai start ke liye.
- Channel **private** rakho (join link disable), sirf tumhara account admin ho.
- Channel me videos **document** ke roop me save hote hain (original bytes, no compression) — isliye quality barbaad nahi hoti.
- Ek video ke liye channel me **3 messages** hote hain: 1 video document, 1 thumbnail photo, 1 metadata JSON text. Teeno ek hi channel me — alag channel ki jarurat nahi.

**Jab alag channels banana chahige:**
- Agar content category-wise organize karna chahte ho (jaise comedy ek channel, tech ek channel) — optional.
- Agar ek account se bahut zyada upload kar rahe ho aur Telegram rate-limit de raha ho — tab 2nd channel.
- Situstion me: **1 channel se start karo**, jab zaroorat pade tab badhao.

> Note: Ye ek **user account (userbot)** session hai, bot nahi. Isliye `api_id` + `api_hash` + phone login chahiye. Bot API se 50 MB limit hoti hai, MTProto se 2 GB.

---

## 📋 Prerequisites

1. **Node.js 18+** locally (for one-time login).
2. **Telegram account** + **api_id & api_hash**:
   - Go to <https://my.telegram.org> → "API development tools" → create app.
   - Note down `api_id` (number) and `api_hash` (string).
3. Ek **private Telegram channel** banao (Telegram app se), aur apne account ko admin banao.

---

## 🚀 Local setup

```bash
cd content-site
npm install
cp .env.example .env
# .env me apna api_id, api_hash, channel dalo:
# TELEGRAM_API_ID=123456
# TELEGRAM_API_HASH=xxxxxxxx
# TELEGRAM_CHANNEL=@your_private_channel   (ya channel numeric id -100123...)
# ADMIN_API_KEY=koi_long_random_string
```

### Telegram login (ek baar)

```bash
npm run login
```

- Phone number dalo → Telegram SMS pe code sending karega → code dalo.
- Agar 2FA enabled hai to password bhi dalo.
- Script ek **session string** print karega.

Us session string ko `.env` me `TELEGRAM_SESSION=` ke aage paste karo (ya Render env var me dalo).

### Run locally

```bash
npm start
# http://localhost:10000
```

---

## ☁️ Render pe deploy karna

1. Render me "New → Web Service", repo connect karo.
2. `render.yaml` already hai — runtime auto-detect hogi.
3. **Environment variables** dalo (Render dashboard → Settings → Environment):
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `TELEGRAM_SESSION` (woh session string jo `npm run login` se mila)
   - `TELEGRAM_CHANNEL` (jaise `@your_channel`)
   - `ADMIN_API_KEY`
4. Deploy karo. Health check `/api/health` succeed hogi.

> Free tier me Render 15 min baad sleep kar deta hai → pehla request thoda slow ho sakta hai.
> Production ke liye "Always On" (paid) plan recommend hai.

---

## 🔐 Admin use (video upload)

Videos upload karne ke liye admin API use karo (browser ya curl):

```bash
curl -X POST https://YOUR-APP.onrender.com/api/admin/videos \
  -H "x-api-key: YOUR_ADMIN_API_KEY" \
  -F "title=My Video Title" \
  -F "description=Short description..." \
  -F "video=@/path/to/video.mp4"
```

(Admin login web endpoint bhi hai `/api/admin/login/code` + `/verify`, lekin 2FA ke liye `npm run login` easier hai.)

---

## 📚 API

### Public
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/videos?cursor=&limit=` | Infinite-scroll list (cursor pagination) |
| GET | `/api/videos/:id` | Video detail (counts a view) |
| GET | `/api/videos/:id/stream` | **Stream video (HTTP Range, plays in browser)** |
| GET | `/api/videos/:id/thumbnail` | Thumbnail image |
| GET | `/api/search?q=` | Search by title/description |
| POST | `/api/videos/:id/like` | Toggle like (body: `{userId}`) |
| POST | `/api/videos/:id/share` | Record a share |

### Admin (header `x-api-key`)
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/admin/videos` | Upload video (multipart: `video`, `title`, `description`) |
| GET | `/api/admin/videos` | List all |
| POST | `/api/admin/videos/:id/delete` | Delete |
| POST | `/api/admin/login/code` | Send SMS code |
| POST | `/api/admin/login/verify` | Verify code → session string |
| GET | `/api/admin/sync` | **Rebuild SQLite cache from Telegram** (restore after DB loss) |

---

## 🔧 Technical notes

- **Videos play but can't be directly downloaded:** videos stream through `/api/videos/:id/stream` with HTTP Range support. Telegram file links/IDs are never exposed to the browser. (True DRM — e.g. encrypted segments / signed tokens — aage add karna padega; basic "no direct download" ek streaming proxy se achieve hota hai.)
- **Storage:** videos uploaded as **documents** (`forceDocument`) → Telegram stores exact bytes, no transcoding.
- **Metadata in Telegram:** har video ka metadata (title, description, views, likes, shares, file locations) Telegram channel me ek **JSON text message** ke roop me store hota hai. SQLite ek fast cache hai. Stats (view/like/share) change pe Telegram message debounce se update hota hai. DB khoya ho toh `/api/admin/sync` se Telegram se rebuild karo.
- **Metadata message format:** `{"t":"meta","id":"...","title":"...","description":"...","views":N,"likes":N,"shares":N,"duration":N,"createdAt":N,"video":{...},"thumbnail":{...}}`
- **Thumbnails:** generated locally with ffmpeg at upload time, uploaded to Telegram as a separate photo (durable, independently streamable).
- **Seeking:** uploads are faststart-remuxed (moov atom at front) so browser seeking works smoothly.
- **Infinite scroll:** cursor-based pagination on an auto-increment `seq` column — no skipped/duplicate items when new videos are added.
- **Likes:** anonymous via a client-side UUID (localStorage). For real accounts, add an auth provider.

---

## 📁 Structure

```
content-site/
├── package.json
├── render.yaml
├── .env.example
├── scripts/login.js        # one-time Telegram login → session string
├── src/
│   ├── server.js           # Express app + all routes
│   ├── db.js               # SQLite schema + queries
│   ├── telegram.js         # MTProto upload + range streaming
│   └── ffmpeg.js           # thumbnail + duration + faststart
└── public/
    ├── index.html          # infinite-scroll grid + player modal
    ├── style.css
    └── app.js
```
