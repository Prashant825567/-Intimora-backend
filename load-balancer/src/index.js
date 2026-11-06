/**
 * Cloudflare Worker — Simple Load Balancer for Vercel Backends
 * ------------------------------------------------------------------------------------
 * Round-robin load balancing across Vercel backends. No KV needed.
 *
 * Servers are hardcoded below — edit to add/remove.
 *
 * How it works:
 * - Alternates requests between servers (round-robin)
 * - Health checks every 2 minutes
 * - Dead servers (3 failed checks) skipped for 5 minutes
 * - Auto-recovers when server comes back
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

// === Get next server (round-robin) ===
function getNextServer() {
  const now = Date.now();
  const available = SERVERS.filter((s) => {
    // Skip suspended servers
    if (suspendedUntil[s] && suspendedUntil[s] > now) return false;
    // Skip dead servers
    if (serverHealth[s] === false) return false;
    return true;
  });

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
      // Server is alive — reset streak, mark healthy
      failStreaks[url] = 0;
      serverHealth[url] = true;
      delete suspendedUntil[url];
      console.log(`${url} ✅ ALIVE`);
    } else {
      // Server failed — increment streak
      failStreaks[url] = (failStreaks[url] || 0) + 1;
      console.log(`${url} ❌ failed (${failStreaks[url]}/3)`);

      if (failStreaks[url] >= 3) {
        serverHealth[url] = false;
        suspendedUntil[url] = Date.now() + 5 * 60 * 1000; // suspend for 5 min
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

function sanitizeResponseHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of STRIP_RESPONSE_HEADERS) {
    headers.delete(name);
  }
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
    // (don't mark dead for non-API routes like /favicon.ico)
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && [404, 410, 503].includes(response.status)) {
      console.warn(`${serverUrl} returned ${response.status} on ${url.pathname} — marking dead`);
      serverHealth[serverUrl] = false;
      suspendedUntil[serverUrl] = Date.now() + 5 * 60 * 1000;
    }

    return sanitizeResponseHeaders(response);
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

async function routeRequest(request) {
  const bodyBuffer = await readBodyIfPresent(request);

  // Try up to SERVERS.length times
  for (let attempt = 0; attempt < SERVERS.length; attempt++) {
    const serverUrl = getNextServer();

    try {
      const response = await forwardRequest(request, serverUrl, bodyBuffer);

      // Check if suspended response on API route
      const reqUrl = new URL(request.url);
      if (reqUrl.pathname.startsWith("/api/") && [404, 410, 503].includes(response.status)) {
        continue; // try next server
      }

      return response;
    } catch (err) {
      console.error(`Request to ${serverUrl} failed:`, err.message);
      // Mark server as dead
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
