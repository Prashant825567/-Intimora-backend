# Intimora Load Balancer

Cloudflare Worker that distributes traffic across multiple Netlify backend instances.

## Features

- **Least-connections routing** — sends requests to the server with the fewest requests
- **Automatic health checks** — every 2 minutes, checks `/api/health` on each server
- **Suspended server detection** — when Netlify credits run out, the server is auto-skipped
- **KV-based state** — request counts and health status persist in Cloudflare KV
- **Fallback round-robin** — if KV is unavailable, falls back to round-robin
- **Video streaming support** — preserves Range headers for video playback

## Setup

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Create KV Namespace

In Cloudflare dashboard:
- Go to **Workers & Pages**
- Click **KV** → **Create namespace**
- Name: `intimora-lb`
- Copy the namespace ID

### 3. Edit wrangler.toml

Replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with your actual KV namespace ID.

Update the `SERVERS` variable with your Netlify deployment URLs:
```toml
SERVERS = "https://a-intimora.netlify.app,https://b-intimora.netlify.app,https://c-intimora.netlify.app"
```

### 4. Deploy

```bash
cd load-balancer
wrangler deploy
```

### 5. Test

```bash
curl https://YOUR_WORKER_NAME.workers.dev/api/health
```

Should return: `{"ok":true,"data":{"status":"up",...}}`

## How it works

```
User → Cloudflare Worker → Server A (least used, healthy)
                ↓
         If Server A suspended (404/410/503)
                ↓
         Try Server B → Server C → ...
```

## Files

- `src/index.js` — Worker code
- `wrangler.toml` — Deployment config
- `README.md` — This file
