# Intimora Local Admin

Run on your PC, no cloud server needed. Upload videos directly to Telegram via MTProto.

## How to run:

```bash
# 1. Install dependencies
npm install

# 2. Run
npm start

# 3. Open browser
http://localhost:3000
```

## Features:
- ✅ Direct MTProto upload to Telegram (no bandwidth cost)
- ✅ Thumbnail compulsory
- ✅ Metadata saved locally (metadata.json)
- ✅ Metadata also sent to Telegram
- ✅ Video list with delete
- ✅ Export metadata as JSON
- ✅ Session pre-filled (no login needed)
- ✅ All channels pre-filled

## Files:
- `server.js` — Express server with MTProto upload
- `public/index.html` — Web UI
- `metadata.json` — Local metadata storage (auto-created)
- `package.json` — Dependencies

## Config (all pre-filled):
- API ID: 37144075
- API Hash: 57a11adf8679a2e7a2b6184ed7bb9c70
- Session: (pre-filled)
- Video Channel: -1003756299546
- Thumbnail Channel: -1004360811639
- Metadata Channel: -1003777974779
