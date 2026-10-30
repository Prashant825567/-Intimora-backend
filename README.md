# Intimora Backend — Video Content Site on Netlify + Telegram

A video content site where videos **play in-browser** (not downloadable), with **likes**, **shares**, **thumbnails**, **search**, and **unlimited scrolling**.

- **Backend**: Express (Netlify Serverless Functions)
- **Storage**: Telegram (via MTProto/teleproto) — videos + metadata + thumbnails
- **Database**: Telegram JSON messages (no SQLite, no external DB)
- **Deployment**: Netlify (free tier)

## Architecture

```
Frontend (static HTML/CSS/JS)  →  Netlify CDN
API (/api/*)                   →  Netlify Functions (Express)
Database                       →  Telegram (JSON text messages)
Videos                         →  Telegram (MTProto upload)
Thumbnails                     →  Client-side generated (HTML5 video + canvas)
```

**No SQLite, no ffmpeg, no external database.** All data is stored as JSON text messages in Telegram. Works on any serverless platform.

## Data Flow

Each video has **3 messages** in the Telegram channel:
1. **Video** — video document (exact bytes, no compression)
2. **Thumbnail** — photo (client-generated, uploaded with video)
3. **Metadata** — JSON text message with title, description, views, likes, shares, file locations

When stats change (views/likes/shares), the metadata message is **edited in place** in Telegram.

## Quick Start (Local)

```bash
npm install
npm run login   # Enter phone → get code → paste code → copy session string
```

Create `.env` from `.env.example` and fill in Telegram credentials.

```bash
npm start       # Server runs on port 10000
```

## Deploy on Netlify

### 1. Create Telegram bot/account & channel
- Go to [my.telegram.org](https://my.telegram.org) → API tools → create app → copy `api_id` + `api_hash`
- Run `npm run login` locally → enter phone → get code → paste code → copy session string
- Create a **private** Telegram channel (or public for CDN streaming)

### 2. Connect to Netlify
1. Push code to GitHub
2. Netlify → **Add new site** → Connect GitHub → select repo
3. Build settings:
   - Build command: `npm install`
   - Publish directory: `public`
4. Deploy

### 3. Set environment variables
In Netlify dashboard → Site settings → Environment variables:

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | From my.telegram.org |
| `TELEGRAM_API_HASH` | From my.telegram.org |
| `TELEGRAM_SESSION` | From `npm run login` |
| `TELEGRAM_CHANNEL` | Your channel (e.g. `@your_channel`) |
| `TELEGRAM_CHANNEL_PUBLIC` | Public username for CDN redirect (optional) |
| `ADMIN_API_KEY` | Your admin key |

### 4. Test
- Visit `https://your-site.netlify.app/api/health` → `{"ok":true,"data":{"status":"up"}}`
- Visit `https://your-site.netlify.app/admin` → upload a video

## Admin Panel

Visit `/admin` to:
- **Upload videos** (title + video file → thumbnail auto-generated client-side)
- **List all videos** with stats
- **Delete videos** (removes from Telegram)

Thumbnails are **compulsory** — generated automatically in the browser when you select a video file.

## API Reference

### Public API (no key needed)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/videos?cursor=N&limit=M` | Infinite scroll list |
| GET | `/api/videos/:id` | Video detail (increments views) |
| GET | `/api/videos/:id/stream` | Stream video (Range support / CDN redirect) |
| GET | `/api/videos/:id/thumbnail` | Thumbnail image |
| GET | `/api/search?q=QUERY` | Search videos |
| POST | `/api/videos/:id/like` | Like/unlike (body: `{userId}`) |
| POST | `/api/videos/:id/share` | Record share |

### Admin API (x-api-key required)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/admin/videos` | Upload (video + thumbnail + title required) |
| GET | `/api/admin/videos` | List all videos |
| POST | `/api/admin/videos/:id/delete` | Delete video |
| POST | `/api/admin/videos/:id/thumbnail` | Replace thumbnail |

## Video Streaming

Two modes:

**CDN Redirect (recommended for Netlify):**
- Set `TELEGRAM_CHANNEL_PUBLIC` to your channel's public username
- Server redirects to `https://t.me/{username}/{msg_id}/{filename}`
- Zero server bandwidth — Telegram CDN serves the video

**Server Streaming (fallback):**
- Server fetches bytes from Telegram and streams to browser
- Uses server bandwidth (not ideal for serverless)

## Key Features

- **Infinite scroll** — cursor-based pagination
- **Search** — filter by title
- **Like/Unlike** — per-user (localStorage UUID)
- **Share** — copy link + record share count
- **View-only** — videos play in browser, no direct download link
- **Thumbnails** — client-side generated, compulsory on upload

## Project Structure

```
├── public/              # Frontend (static)
│   ├── index.html       # Home page
│   ├── admin.html       # Admin panel
│   ├── app.js           # Frontend logic
│   ├── admin.js         # Admin panel logic
│   └── style.css        # Styles
├── src/
│   ├── server.js        # Express app + Netlify handler
│   ├── store.js         # Telegram data store (replaces SQLite)
│   └── telegram.js      # MTProto wrapper (upload, stream, metadata)
├── functions/
│   └── api.js           # Netlify function entry point
├── scripts/
│   └── login.js         # Telegram login (get session string)
├── netlify.toml         # Netlify configuration
├── .env.example         # Environment variables template
└── package.json
```

## Notes

- **Free tier limits**: Netlify 100GB bandwidth, 100K function calls/month, 26s function execution
- **Telegram free**: 2GB per file, unlimited files
- **Session expiry**: Session string expires if account is deleted
- **Channel**: Keep private unless using CDN redirect mode
