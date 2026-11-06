/**
 * Cloudflare Worker — Load Balancer for Vercel Backends
 * ------------------------------------------------------------------------------------
 * Round-robin load balancing across Vercel backends. No KV needed.
 *
 * Features:
 * - Round-robin: requests alternate between servers
 * - Health check every 2 minutes
 * - Dead servers (3 failed checks) suspended for 5 min
 * - Auto-recovers when server comes back
 * - X-Direct-Server-URL header: tells frontend which server handled the request
 * - /api/servers endpoint: returns healthy server URLs
 * - /api/get-server endpoint: returns a single healthy server URL
 *
 * Servers are hardcoded below — edit to add/remove.
 */

// === Servers (edit here) ===
const SERVERS = [
  "https://api-intimora.vercel.app",
  "https://intimora-api1.vercel.app",
];

// === Health state (in-memory) ===
const serverHealth = {}; // { url: true/false }
const failStreaks = {}; // { url: number }
const suspendedUntil = {}; // { url: timestamp }

let roundRobinCursor = 0;

// === Headers to strip ===
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "content-length",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "x-vercel-id",
  "x-powered-by",
  "x-vercel-cache",
  "x-vercel-upstream",
]);

// === Get healthy servers ===
function getHealthyServers() {
  const now = Date.now();
  return SERVERS.filter((s) => {
    if (suspendedUntil[s] && suspendedUntil[s] > now) return false;
    if (serverHealth[s] === false) return false;
    return true;
  });
}

// === Get next server (round-robin) ===
function getNextServer() {
  const available = getHealthyServers();

  if (available.length === 0) {
    // All dead — return any server (let it fail naturally)
    return SERVERS[0];
  }

  const server = available[roundRobinCursor % available.length];
  roundRobinCursor++;
  return server;
}

// === Health check ===
async function checkServerHealth(serverUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${serverUrl}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 200) {
      const text = await response.text();
      try {
        const data = JSON.parse(text);
        return Boolean(data && data.ok);
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function healthCheck() {
  console.log(`Health check: ${SERVERS.length} servers`);

  const results = await Promise.allSettled(
    SERVERS.map(async (url) => {
      const alive = await checkServerHealth(url);
      return { url, alive };
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;

    const { url, alive } = result.value;

    if (alive) {
      failStreaks[url] = 0;
      serverHealth[url] = true;
      delete suspendedUntil[url];
      console.log(`${url} ✅ ALIVE`);
    } else {
      failStreaks[url] = (failStreaks[url] || 0) + 1;
      console.log(`${url} ❌ failed (${failStreaks[url]}/3)`);

      if (failStreaks[url] >= 3) {
        serverHealth[url] = false;
        suspendedUntil[url] = Date.now() + 5 * 60 * 1000;
        console.log(`${url} 🔴 SUSPENDED for 5 min`);
      }
    }
  }
}

// === Forward request ===
function buildForwardHeaders(request) {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return headers;
}

function sanitizeResponseHeaders(response, serverUrl) {
  const headers = new Headers(response.headers);
  for (const name of STRIP_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  // Add direct server URL header so frontend can use it for media requests
  headers.set("X-Direct-Server-URL", serverUrl);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function forwardRequest(request, serverUrl, bodyBuffer) {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, serverUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const hasBody = bodyBuffer !== null && bodyBuffer !== undefined;
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: buildForwardHeaders(request),
      body: hasBody ? bodyBuffer : undefined,
      redirect: "manual",
      signal: controller.signal,
    });

    // If server returns 404/410/503 on API routes, mark as dead
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && [404, 410, 503].includes(response.status)) {
      console.warn(`${serverUrl} returned ${response.status} on ${url.pathname} — marking dead`);
      serverHealth[serverUrl] = false;
      suspendedUntil[serverUrl] = Date.now() + 5 * 60 * 1000;
    }

    return sanitizeResponseHeaders(response, serverUrl);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readBodyIfPresent(request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  try {
    const buf = await request.arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

// === Special endpoints ===

// GET /api/servers — returns list of healthy server URLs
async function handleServersEndpoint() {
  const healthy = getHealthyServers();
  return new Response(
    JSON.stringify({ ok: true, data: { servers: healthy } }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// GET /api/get-server — returns a single healthy server URL
async function handleGetServerEndpoint() {
  const healthy = getHealthyServers();
  if (healthy.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "No servers available" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );
  }
  const server = healthy[roundRobinCursor % healthy.length];
  roundRobinCursor++;
  return new Response(
    JSON.stringify({ ok: true, data: { server: server } }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// === Main routing ===
async function routeRequest(request) {
  const url = new URL(request.url);

  // Special endpoints — handle directly, don't forward
  if (url.pathname === "/api/servers" && request.method === "GET") {
    return await handleServersEndpoint();
  }
  if (url.pathname === "/api/get-server" && request.method === "GET") {
    return await handleGetServerEndpoint();
  }

  const bodyBuffer = await readBodyIfPresent(request);

  // Try up to SERVERS.length times
  for (let attempt = 0; attempt < SERVERS.length; attempt++) {
    const serverUrl = getNextServer();

    try {
      const response = await forwardRequest(request, serverUrl, bodyBuffer);

      // Check if suspended response on API route
      if (url.pathname.startsWith("/api/") && [404, 410, 503].includes(response.status)) {
        continue; // try next server
      }

      return response;
    } catch (err) {
      console.error(`Request to ${serverUrl} failed:`, err.message);
      serverHealth[serverUrl] = false;
      suspendedUntil[serverUrl] = Date.now() + 5 * 60 * 1000;
      continue;
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: "All servers unavailable" }),
    { status: 503, headers: { "content-type": "application/json" } }
  );
}

// === Worker entry ===
export default {
  async fetch(request) {
    try {
      return await routeRequest(request);
    } catch (err) {
      console.error("Unhandled error:", err.message);
      return new Response(
        JSON.stringify({ ok: false, error: "Internal error" }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(healthCheck());
  },
};
