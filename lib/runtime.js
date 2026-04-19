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
 *   auditResults(data)            — drop empty/duplicate rows, surface shape/count warnings
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

// Post-parse backend audit. Drops garbage rows (all-empty, exact duplicates —
// WebSquare virtual scroll occasionally re-emits rows from the top when the
// viewport rewinds) and reports structural problems that normally indicate
// a scraper bug, not bad data: row key count ≠ column count (colspan misalign),
// totalCount ≠ cleaned.length (scroll budget exhausted too early or overshoot).
// Returns { rows, columns, totalCount, warnings }. Callers log warnings;
// the UI only ever sees cleaned rows.
function auditResults(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const columns = Array.isArray(data?.columns) ? data.columns : [];
  const totalCount = Number(data?.totalCount || 0);
  const warnings = [];

  const cleaned = [];
  const seen = new Set();
  let droppedEmpty = 0;
  let droppedDup = 0;

  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const values = Object.values(r);
    const isEmpty =
      values.length === 0 ||
      values.every((v) => v === null || v === undefined || String(v).trim() === "");
    if (isEmpty) { droppedEmpty++; continue; }
    const key = JSON.stringify(r);
    if (seen.has(key)) { droppedDup++; continue; }
    seen.add(key);
    cleaned.push(r);
  }

  if (droppedEmpty > 0) warnings.push({ code: "EMPTY_ROWS_DROPPED", count: droppedEmpty });
  if (droppedDup > 0) warnings.push({ code: "DUPLICATE_ROWS_DROPPED", count: droppedDup });

  if (columns.length > 0) {
    const mismatches = cleaned.filter((r) => Object.keys(r).length !== columns.length).length;
    if (mismatches > 0) {
      warnings.push({
        code: "COLUMN_SHAPE_MISMATCH",
        count: mismatches,
        expected: columns.length,
      });
    }
  }

  if (totalCount > 0 && cleaned.length > 0 && totalCount !== cleaned.length) {
    warnings.push({
      code: totalCount > cleaned.length ? "SCROLL_INCOMPLETE" : "OVERSHOT_TOTALCOUNT",
      totalCount,
      rendered: cleaned.length,
    });
  }

  return { rows: cleaned, columns, totalCount, warnings };
}

module.exports = {
  cacheKey,
  createCache,
  createSerialQueue,
  withTimeout,
  isTransient,
  expandHeaderCells,
  auditResults,
};
