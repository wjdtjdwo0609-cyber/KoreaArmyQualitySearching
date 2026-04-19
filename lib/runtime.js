/**
 * Pure runtime helpers — no Express, no Playwright. Lives here so tests can
 * exercise it under `node --test` without spinning up the whole server.
 *
 * Exports:
 *   cacheKey(params)              — canonical, order-independent params key
 *   createCache({ ttlMs, max })   — TTL + LRU cache instance
 *   createSerialQueue()           — concurrency-1 promise chain
 *   withTimeout(promise, ms, lbl) — race a promise against a wall-clock timeout
 *   isTransient(msg)              — pattern match for retryable errors
 *   expandHeaderCells(cells)      — flatten colspan'd th descriptors into 1:1 column names
 */

function cacheKey(params) {
  const keys = Object.keys(params || {}).sort();
  return keys.map((k) => `${k}=${params[k]}`).join("&");
}

function createCache({ ttlMs = 60_000, max = 64 } = {}) {
  const store = new Map();
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      // LRU touch — re-insert so this key becomes the newest
      store.delete(key);
      store.set(key, e);
      return e.data;
    },
    set(key, data) {
      if (store.has(key)) store.delete(key);
      store.set(key, { data, expiresAt: Date.now() + ttlMs });
      while (store.size > max) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },
    delete(key) { store.delete(key); },
    clear() { store.clear(); },
    get size() { return store.size; },
    get ttlMs() { return ttlMs; },
    get max() { return max; },
  };
}

function createSerialQueue() {
  let chain = Promise.resolve();
  return function runSerial(fn) {
    const next = chain.then(fn, fn);
    // Absorb rejection so a failing task doesn't stall every later task.
    chain = next.catch(() => {});
    return next;
  };
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function isTransient(msg) {
  return /timeout|navigation|disconnect|net::|Target closed|frame.*detached|has been closed/i.test(
    String(msg || "")
  );
}

// KDSIS w2grid thead wraps group headers in th[colspan=N]. td cells remain
// one-per-column, so we must expand "group name" into name(1)/name(2)/... to
// keep td index → column name 1:1. cells: [{ name, colspan }]
function expandHeaderCells(cells) {
  const out = [];
  for (const { name, colspan } of cells || []) {
    const label = (name || "").trim();
    const n = Number.isFinite(colspan) && colspan > 0 ? Math.floor(colspan) : 1;
    if (n > 1) {
      for (let i = 0; i < n; i++) out.push(`${label}(${i + 1})`);
    } else {
      out.push(label);
    }
  }
  return out;
}

module.exports = {
  cacheKey,
  createCache,
  createSerialQueue,
  withTimeout,
  isTransient,
  expandHeaderCells,
};
