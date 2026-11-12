// Transport layer: HTTP/1.1 over TLS with per-host routing (direct / HTTP-proxy CONNECT),
// cookie jar, redirect following, chunked decoding. Zero dependencies. https:// only.
//
// Why not node:https.request? Reusing a pre-connected TLS socket via `createConnection`
// hangs on some Cloudflare-fronted hosts (observed on javbus through the local proxy),
// while a raw TLS write works. So the wire protocol is implemented here explicitly.
//
// Public API:
//   const http = createHttp(config.network)
//   await http.get(url, { headers, timeoutMs, retry, route })
//        -> { status, url, headers, buffer, text, route, ms }
//   await http.getFollow(url, opts)   // follows 3xx (max 5), keeps cookies
//   await http.json(url, opts)
//   await http.probe(url)             -> { ok, status, ms, route, error }
//   http.routeFor(url)                -> 'direct' | 'proxy'
//   http.jar                          -> simple cookie store (Map)
import {AsyncLocalStorage} from 'node:async_hooks';
import {exchange} from './transport-attempt.mjs';
import {throwIfAborted} from '../core/durable.mjs';
const signalScope=new AsyncLocalStorage();
export const withHttpSignal=(signal,fn)=>signalScope.run(signal,fn);

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseProxy(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.host) return { host: value.host, port: Number(value.port || 1080) };
  const m = String(value).match(/^(?:https?:\/\/|socks[45]:\/\/)?(?:[^@/]*@)?([^:/]+):(\d+)/i);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

function hostMatches(host, list = []) {
  const h = host.toLowerCase();
  return list.some((entry) => {
    const e = String(entry).toLowerCase().trim();
    return e && (h === e || h.endsWith('.' + e));
  });
}

// ---------------- cookie jar ----------------
function makeJar() {
  const store = new Map(); // `${host}|${name}` -> { value, expires }
  return {
    store,
    header(host) {
      const now = Date.now();
      const parts = [];
      for (const [k, v] of store) {
        const [h, name] = k.split('|');
        if (h !== host) continue;
        if (v.expires && v.expires < now) { store.delete(k); continue; }
        parts.push(`${name}=${v.value}`);
      }
      return parts.join('; ');
    },
    absorb(host, setCookieHeaders) {
      for (const raw of [].concat(setCookieHeaders || [])) {
        const first = String(raw).split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        const exp = /expires=([^;]+)/i.exec(raw);
        let expires = 0;
        if (exp) {
          const t = Date.parse(exp[1]);
          if (!Number.isNaN(t)) expires = t;
        }
        store.set(`${host}|${name}`, { value, expires });
      }
    },
  };
}

const RETRYABLE = /NET_ERR|PROXY_|TLS_|TIMEOUT|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EMPTY_RESPONSE|SOCK_ERR/;

export function createHttp(cfg = {}, factories = {}) {
  const base = {
    proxy: parseProxy(cfg.proxy),
    proxyHosts: cfg.proxyHosts || [],
    directHosts: cfg.directHosts || [],
    defaultRoute: cfg.defaultRoute || 'direct',
    timeoutMs: cfg.timeoutMs || 20000,
    retry: cfg.retry == null ? 3 : cfg.retry,
    minIntervalMs: cfg.minIntervalMs == null ? 1200 : cfg.minIntervalMs,
  };

  const lastCall = new Map();
  const hostHealth = new Map(); // host -> { route, until } sticky working route
  const stats = { requests: 0, retries: 0, fallbacks: 0, errors: 0, byRoute: { direct: 0, proxy: 0 } };
  const jar = makeJar();

  function routeFor(url) {
    const host = new URL(url).hostname;
    if (base.proxy && hostMatches(host, base.proxyHosts)) return 'proxy';
    if (hostMatches(host, base.directHosts)) return 'direct';
    return base.defaultRoute === 'proxy' && base.proxy ? 'proxy' : 'direct';
  }

  function candidatesFor(url, forced) {
    const host = new URL(url).hostname;
    const sticky = hostHealth.get(host);
    let preferred = forced || (sticky && sticky.until > Date.now() ? sticky.route : null) || routeFor(url);
    const list = [{ route: preferred, proxy: preferred === 'proxy' ? base.proxy : null }];
    if (forced) return list;
    const other = preferred === 'proxy' ? 'direct' : 'proxy';
    if (other === 'proxy' && !base.proxy) return list;
    list.push({ route: other, proxy: other === 'proxy' ? base.proxy : null });
    return list;
  }

  async function throttle(host) {
    const interval = Math.max(0, base.minIntervalMs);
    if (!interval) return;
    const prev = lastCall.get(host) || 0;
    const wait = prev + interval - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
  }

  async function get(url, opts = {}) {
    opts={...opts,signal:opts.signal||signalScope.getStore()};
    throwIfAborted(opts.signal);
    const timeoutMs = opts.timeoutMs || base.timeoutMs;
    const retries = opts.retry == null ? base.retry : opts.retry;
    const candidates = candidatesFor(url, opts.route);
    const host = new URL(url).hostname;
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let retryable = false;
      for (const cand of candidates) {
        const started = Date.now();
        try {
          await throttle(host);
          throwIfAborted(opts.signal);
          stats.requests++;
          stats.byRoute[cand.route]++;
          const res = await exchange({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body, proxy: cand.proxy, timeoutMs, jar, signal:opts.signal,ua:UA,maxBodyBytes:opts.maxBodyBytes },factories);
          // rate-limit / transient server errors: let the outer loop back off and retry
          if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            lastErr = Object.assign(new Error(`HTTP_${res.status}`), { status: res.status });
            retryable = true;
            stats.errors++;
            const retryAfter = Number(res.headers['retry-after']);
            if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 15000));
            break;
          }
          res.text = res.buffer.toString('utf8');
          res.route = cand.route;
          res.ms = Date.now() - started;
          hostHealth.set(host, { route: cand.route, until: Date.now() + 10 * 60 * 1000 });
          if (cand.route !== routeFor(url)) stats.fallbacks++;
          return res;
        } catch (e) {
          lastErr = e;
          stats.errors++;
          retryable = RETRYABLE.test(`${e.code || ''} ${e.message}`);
          if (retryable) continue;
          throw Object.assign(e, { route: cand.route, url });
        }
      }
      if (attempt < retries && retryable) {
        stats.retries++;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      break;
    }
    throw Object.assign(lastErr || new Error('REQUEST_FAILED'), { url, routesTried: candidates.map((c) => c.route) });
  }

  async function getFollow(url, opts = {}) {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      const res = await get(current, opts);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, current).href;
        continue;
      }
      res.url = current;
      return res;
    }
    throw Object.assign(new Error('TOO_MANY_REDIRECTS'), { url });
  }

  async function json(url, opts = {}) {
    const res = await getFollow(url, { ...opts, headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) } });
    if (res.status !== 200) throw Object.assign(new Error(`HTTP_${res.status}`), { status: res.status, url });
    try { return JSON.parse(res.text); } catch { throw Object.assign(new Error('BAD_JSON'), { url, sample: res.text.slice(0, 200) }); }
  }

  async function probe(url, timeoutMs = 10000) {
    const started = Date.now();
    try {
      const res = await get(url, { timeoutMs, retry: 0 });
      return { ok: res.status > 0 && res.status < 500, status: res.status, ms: Date.now() - started, route: res.route, error: null };
    } catch (e) {
      return { ok: false, status: 0, ms: Date.now() - started, route: routeFor(url), error: e.code || e.message };
    }
  }

  return { get, getFollow, json, probe, routeFor, stats, jar, config: base };
}

export default createHttp;
