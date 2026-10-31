/**
 * Cloudflare Worker — Least-Connections Load Balancer for Netlify serverless backends
 * ------------------------------------------------------------------------------------
 * Distributes incoming HTTP traffic across a pool of Netlify sites, routing every
 * request to whichever healthy backend has served the fewest requests so far.
 *
 * Persistent state lives in a Cloudflare KV namespace bound as `LB_KV`:
 *   - "request_count"   -> { "<serverUrl>": <number>, ... }
 *   - "server_health"   -> { "<serverUrl>": true|false, ... }
 *   - "health_fail_streak" -> { "<serverUrl>": <number>, ... }  (consecutive failed health checks)
 *
 * All KV writes use `expirationTtl: SEVEN_DAYS_SECONDS`, so the TTL is renewed
 * (reset back to 7 days) on every single write, as required.
 *
 * Required bindings (see wrangler.toml):
 *   - KV namespace: LB_KV
 *   - Env var:      SERVERS (comma-separated list, falls back to a default list)
 *   - Cron trigger: "*/2 * * * *" (every 2 minutes) -> scheduled() -> healthCheck()
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000; // 10 second timeout for all outbound fetches
const MAX_CONSECUTIVE_HEALTH_FAILS = 3; // mark dead after 3 consecutive bad health checks
const SUSPENDED_STATUS_CODES = new Set([404, 410, 503]);

const DEFAULT_SERVERS = [
  "https://a-intimora.netlify.app",
  "https://b-intimora.netlify.app",
  "https://c-intimora.netlify.app",
];

// Headers that must never be forwarded upstream (hop-by-hop / host-specific).
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "content-length", // recomputed automatically by fetch() from the body
]);

// Headers that are specific to the backend (Netlify) and shouldn't leak
// through to our clients. Everything else on the response is left as-is.
const STRIP_RESPONSE_HEADERS = new Set([
  "x-nf-request-id", // Netlify-specific request id
  "x-powered-by",    // Netlify-specific
]);

// In-memory fallback round-robin cursor. This is NOT persisted — it simply
// resets whenever the isolate restarts — but it's only used as a last-resort
// fallback when KV itself is unavailable, so that's acceptable.
let roundRobinCursor = 0;

// ---------------------------------------------------------------------------
// Helpers: config / KV access
// ---------------------------------------------------------------------------

/**
 * Reads the pool of backend servers from the SERVERS env var.
 * Accepts either a comma-separated string or a JSON array string.
 * Falls back to DEFAULT_SERVERS if SERVERS is missing or malformed.
 * @param {object} env
 * @returns {string[]}
 */
function getServers(env) {
  const raw = env && env.SERVERS;
  if (!raw || typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_SERVERS;
  }
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s) => String(s).replace(/\/+$/, ""));
      }
    }
    const list = trimmed
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    return list.length > 0 ? list : DEFAULT_SERVERS;
  } catch (err) {
    console.error("getServers: failed to parse SERVERS env var, using defaults", err);
    return DEFAULT_SERVERS;
  }
}

/**
 * Safely reads and JSON-parses a key from KV, returning `fallback` on any
 * missing key / parse error / KV outage. Never throws.
 * @param {KVNamespace} kv
 * @param {string} key
 * @param {object} fallback
 * @returns {Promise<object>}
 */
async function readJSON(kv, key, fallback) {
  try {
    const value = await kv.get(key, "json");
    return value && typeof value === "object" ? value : { ...fallback };
  } catch (err) {
    console.error(`readJSON: failed to read KV key "${key}"`, err);
    throw err; // bubble up so callers can trigger the KV-unavailable fallback path
  }
}

/**
 * Writes a JSON object to KV with the 7-day TTL, renewing it every call.
 * @param {KVNamespace} kv
 * @param {string} key
 * @param {object} value
 */
async function writeJSON(kv, key, value) {
  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: SEVEN_DAYS_SECONDS,
    });
  } catch (err) {
    console.error(`writeJSON: failed to write KV key "${key}"`, err);
  }
}

// ---------------------------------------------------------------------------
// Request-count tracking
// ---------------------------------------------------------------------------

async function updateServerCount(env, serverUrl) {
  try {
    const counts = await readJSON(env.LB_KV, "request_count", {});
    counts[serverUrl] = (counts[serverUrl] || 0) + 1;
    await writeJSON(env.LB_KV, "request_count", counts);
  } catch (err) {
    console.error("updateServerCount: KV unavailable, skipping count update", err);
  }
}

// ---------------------------------------------------------------------------
// Health-state tracking
// ---------------------------------------------------------------------------

async function markServerDead(env, serverUrl) {
  try {
    const health = await readJSON(env.LB_KV, "server_health", {});
    health[serverUrl] = false;
    await writeJSON(env.LB_KV, "server_health", health);
    console.log(`markServerDead: ${serverUrl} marked DEAD`);
  } catch (err) {
    console.error(`markServerDead: failed to mark ${serverUrl} dead`, err);
  }
}

async function markServerAlive(env, serverUrl) {
  try {
    const health = await readJSON(env.LB_KV, "server_health", {});
    health[serverUrl] = true;
    await writeJSON(env.LB_KV, "server_health", health);

    const streaks = await readJSON(env.LB_KV, "health_fail_streak", {});
    if (streaks[serverUrl]) {
      streaks[serverUrl] = 0;
      await writeJSON(env.LB_KV, "health_fail_streak", streaks);
    }
    console.log(`markServerAlive: ${serverUrl} marked ALIVE`);
  } catch (err) {
    console.error(`markServerAlive: failed to mark ${serverUrl} alive`, err);
  }
}

async function isServerAlive(env, serverUrl) {
  try {
    const health = await readJSON(env.LB_KV, "server_health", {});
    return health[serverUrl] !== false;
  } catch (err) {
    console.error(`isServerAlive: KV unavailable, assuming ${serverUrl} alive`, err);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Server selection
// ---------------------------------------------------------------------------

async function getLeastUsedServer(env, servers, excludeSet) {
  try {
    const [counts, health] = await Promise.all([
      readJSON(env.LB_KV, "request_count", {}),
      readJSON(env.LB_KV, "server_health", {}),
    ]);

    const candidates = servers.filter(
      (s) => !excludeSet.has(s) && health[s] !== false
    );

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => (counts[a] || 0) - (counts[b] || 0));
    return candidates[0];
  } catch (err) {
    console.error("getLeastUsedServer: KV unavailable, using round-robin fallback", err);
    return getRoundRobinServer(servers, excludeSet);
  }
}

function getRoundRobinServer(servers, excludeSet) {
  const candidates = servers.filter((s) => !excludeSet.has(s));
  if (candidates.length === 0) return null;
  roundRobinCursor = (roundRobinCursor + 1) % candidates.length;
  return candidates[roundRobinCursor % candidates.length];
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

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
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const hasBody = bodyBuffer !== null && bodyBuffer !== undefined;
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: buildForwardHeaders(request),
      body: hasBody ? bodyBuffer : undefined,
      redirect: "manual",
      signal: controller.signal,
    });

    return sanitizeResponseHeaders(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Health checking (cron)
// ---------------------------------------------------------------------------

async function isHealthResponseOk(response) {
  if (!response || response.status !== 200) return false;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) return false;
  try {
    const text = await response.text();
    const data = JSON.parse(text);
    return Boolean(data);
  } catch (err) {
    return false;
  }
}

async function checkOneServerHealth(serverUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverUrl}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return await isHealthResponseOk(response);
  } catch (err) {
    console.error(`checkOneServerHealth: ${serverUrl} fetch failed`, err);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function healthCheck(env) {
  const servers = getServers(env);
  console.log(`healthCheck: starting check for ${servers.length} server(s)`);

  let streaks;
  try {
    streaks = await readJSON(env.LB_KV, "health_fail_streak", {});
  } catch (err) {
    console.error("healthCheck: could not read fail-streak map, starting fresh", err);
    streaks = {};
  }

  const results = await Promise.allSettled(
    servers.map(async (serverUrl) => {
      const alive = await checkOneServerHealth(serverUrl);
      return { serverUrl, alive };
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled") {
      console.error("healthCheck: unexpected failure evaluating a server", result.reason);
      continue;
    }
    const { serverUrl, alive } = result.value;
    try {
      if (alive) {
        streaks[serverUrl] = 0;
        await markServerAlive(env, serverUrl);
      } else {
        const currentStreak = (streaks[serverUrl] || 0) + 1;
        streaks[serverUrl] = currentStreak;
        console.log(
          `healthCheck: ${serverUrl} failed check (${currentStreak}/${MAX_CONSECUTIVE_HEALTH_FAILS})`
        );
        if (currentStreak >= MAX_CONSECUTIVE_HEALTH_FAILS) {
          await markServerDead(env, serverUrl);
        }
      }
    } catch (err) {
      console.error(`healthCheck: error updating state for ${serverUrl}`, err);
    }
  }

  try {
    await writeJSON(env.LB_KV, "health_fail_streak", streaks);
  } catch (err) {
    console.error("healthCheck: failed to persist fail-streak map", err);
  }

  console.log("healthCheck: completed cycle");
}

// ---------------------------------------------------------------------------
// Main request-handling / routing loop
// ---------------------------------------------------------------------------

async function readBodyIfPresent(request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  try {
    const buf = await request.arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch (err) {
    console.error("readBodyIfPresent: failed to read request body", err);
    return null;
  }
}

async function routeRequest(request, env, ctx) {
  const servers = getServers(env);
  const excluded = new Set();
  const bodyBuffer = await readBodyIfPresent(request);

  for (let attempt = 0; attempt < servers.length; attempt++) {
    let serverUrl;
    try {
      serverUrl = await getLeastUsedServer(env, servers, excluded);
    } catch (err) {
      console.error("routeRequest: getLeastUsedServer threw unexpectedly", err);
      serverUrl = getRoundRobinServer(servers, excluded);
    }

    if (!serverUrl) break;

    ctx.waitUntil(updateServerCount(env, serverUrl));

    try {
      const response = await forwardRequest(request, serverUrl, bodyBuffer);

      if (SUSPENDED_STATUS_CODES.has(response.status)) {
        console.warn(`routeRequest: ${serverUrl} returned ${response.status} -> marking dead`);
        excluded.add(serverUrl);
        ctx.waitUntil(markServerDead(env, serverUrl));
        continue;
      }

      return response;
    } catch (err) {
      console.error(`routeRequest: fetch to ${serverUrl} threw`, err);
      excluded.add(serverUrl);
      ctx.waitUntil(markServerDead(env, serverUrl));
      continue;
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: "All servers unavailable" }),
    {
      status: 503,
      headers: { "content-type": "application/json" },
    }
  );
}

// ---------------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.LB_KV) {
        console.error("fetch: LB_KV binding missing, falling back to round-robin only");
      }
      return await routeRequest(request, env, ctx);
    } catch (err) {
      console.error("fetch: unhandled error in request routing", err);
      return new Response(
        JSON.stringify({ ok: false, error: "Internal load balancer error" }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      healthCheck(env).catch((err) =>
        console.error("scheduled: healthCheck crashed", err)
      )
    );
  },
};
