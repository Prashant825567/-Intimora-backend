# Intimora Backend — Telegram MTProto Video Platform

Backend-only Express API. Reads data from Telegram, streams videos. Admin panel uploads directly via MTProto in browser. No frontend, no database.

## Architecture

```
Admin Panel (Browser)          Backend (Netlify)              Telegram
┌──────────────────┐          ┌──────────────────┐          ┌──────────────┐
│ @mtcute/web       │          │ Express API      │          │ 3 Channels   │
│ MTProto direct   │────────▶│                  │          │              │
│ upload           │ metadata │ Read/Stream/     │────────▶│ Video        │
│                  │          │ Search/List      │ MTProto  │ Thumbnail    │
│                  │          │                  │          │ Metadata     │
└──────────────────┘          └──────────────────┘          └──────────────┘
```

- **Admin panel** (`/admin`): Browser-based, uploads directly to Telegram via MTProto WebSocket
- **Backend** (`/api/*`): Express serverless function, reads/writes metadata in Telegram, streams videos
- **No frontend**: Removed entirely — backend only
- **No SQLite**: All data stored as JSON messages in Telegram
- **No file storage**: Files live in Telegram, backend streams chunks on demand

## Setup

### 1. Get Telegram API credentials
Visit https://my.telegram.org/apps and create an app to get `api_id` and `api_hash`.

### 2. Create 3 Telegram channels
1. **Video channel** — receives uploaded videos (can be public for CDN redirect)
2. **Thumbnail channel** — receives uploaded thumbnails
3. **Metadata channel** — stores JSON metadata messages

### 3. Get the session string
Run `npm run login` locally, enter your phone number, verify code, enter 2FA password if enabled. Copy the session string output.

### 4. Configure environment variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_API_ID` | Telegram API ID from my.telegram.org | `1234567` |
| `TELEGRAM_API_HASH` | Telegram API hash from my.telegram.org | `abcdef123456` |
| `TELEGRAM_SESSION` | MTProto session string | `123456...` |
| `TELEGRAM_CHANNEL_VIDEO` | Video channel ID or @username | `-1001234567890` |
| `TELEGRAM_CHANNEL_THUMB` | Thumbnail channel ID | `-1009876543210` |
| `TELEGRAM_CHANNEL_META` | Metadata channel ID | `-1001122334455` |
| `ADMIN_API_KEY` | Admin API key for authenticating admin requests | `your-secret-key` |

### 5. Deploy on Netlify
1. Push to GitHub
2. Connect repo in Netlify
3. Set environment variables in Netlify dashboard
4. Deploy

## API Endpoints

### Public API (no auth needed)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/videos` | GET | List videos (cursor-based pagination: `?cursor=&limit=`) |
| `/api/search` | GET | Search videos (`?q=keyword`) |
| `/api/videos/:id` | GET | Video detail (increments views) |
| `/api/videos/:id/stream` | GET | Stream video (HTTP Range supported) |
| `/api/videos/:id/thumbnail` | GET | Serve thumbnail image |
| `/api/videos/:id/like` | POST | Toggle like (`{userId}`) |
| `/api/videos/:id/share` | POST | Record a share |

### Admin API (X-API-Key header required)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/metadata` | POST | Receive metadata from admin panel upload |
| `/api/admin/videos` | GET | List all videos |
| `/api/admin/videos/:id/delete` | POST | Delete video (removes from all 3 channels) |

## Admin Panel Usage

1. Visit `/admin` on your deployed site
2. Enter configuration (API ID, API Hash, channel IDs, admin key)
3. Click "Save Config"
4. Enter phone number → "Send Code"
5. Enter code → "Verify"
6. Enter 2FA password if enabled → "Confirm"
7. Select video + thumbnail → Enter title/description → "Upload to Telegram"
8. Metadata is automatically sent to backend

## How Streaming Works

1. Browser `<video>` tag sends HTTP Range request to `/api/videos/:id/stream`
2. Backend reads metadata from Telegram (metadata channel)
3. Backend fetches 512KB chunks from Telegram via MTProto `upload.getFile`
4. Chunks are streamed back to browser as HTTP 206 Partial Content
5. Browser plays video progressively

## Project Structure

```
content-site/
├── functions/
│   ├── api/index.js          # Netlify function entry point
│   ├── server.js             # Express API (read/stream/search/list/delete)
│   ├── store.js              # Telegram data store (list, search, views, likes, delete)
│   └── telegram.js           # 3-channel Telegram wrapper (MTProto)
├── public/
│   └── admin.html            # Admin panel (MTProto direct upload via @mtcute/web)
├── netlify.toml              # Netlify config (functions dir + /api/* redirect)
├── package.json
├── .env.example
└── README.md
```

## Local Development

```bash
npm install
npm run login    # Get session string
npm run dev      # Start server on port 10000
```

Then visit:
- `http://localhost:10000/admin` — Admin panel
- `http://localhost:10000/api/health` — Health check
