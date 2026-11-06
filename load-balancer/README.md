# Intimora Cloudflare Load Balancer

**No KV, no env vars, no config — just paste and deploy!**

## Servers (hardcoded):
1. `https://api-intimora.vercel.app`
2. `https://intimora-api1.vercel.app`

---

## Setup (2 minutes):

### 1. Cloudflare Dashboard kholo
https://dash.cloudflare.com

### 2. Workers & Pages → Create → Create Worker
### 3. Code editor me pura code paste karo
(`src/index.js` ka pura content)

### 4. Deploy karo
**Deploy** button pe click karo.

**Done! No KV, no env vars, no bindings!**

### 5. Test karo
```
https://intimora-load-balancer.xxx.workers.dev/api/health
```
Should return: `{"ok":true,"data":{"status":"up"}}`

---

## Adding More Servers:
`src/index.js` me `SERVERS` array me URL add karo:
```javascript
const SERVERS = [
  "https://api-intimora.vercel.app",
  "https://intimora-api1.vercel.app",
  "https://third-intimora.vercel.app",
];
```
Phir redeploy karo.

## How It Works:
- Round-robin: requests alternate between servers
- Health check every 2 minutes
- Dead servers (3 failed checks) suspended for 5 min
- Auto-recovers when server comes back
- No KV needed — all state in memory
