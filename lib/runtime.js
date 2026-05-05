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
 *   createRateLimiter({windowMs,max}) — sliding-window per-key rate limiter
 *   createByteBoundedCache({...}) — TTL + LRU cache with total-bytes cap (for attachment bytes)
 *   createConcurrentQueue(n)      — at-most-n parallel task scheduler (download pool)
 *   buildKdsisDetailPopupUrl(...) — construct KDSIS standard detail popup URL
 *   extractKdsisDetailPopupUrl(...) — extract/construct the same URL from DOM/API snippets
 *   sanitizeFilename(name, fb)    — filesystem/ZIP-safe filename
 *   createZip(entries)           — tiny ZIP writer for downloaded KDSIS files
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

function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactMatchText(value) {
  return normalizeMatchText(value).replace(/[\s\-_/()[\]{}.,:;·ㆍ]/g, "");
}

function rowText(row) {
  return Object.entries(row || {})
    .map(([k, v]) => `${k} ${v}`)
    .join(" ");
}

const VERIFY_FIELD_ALIASES = {
  "규격번호": ["규격번호", "specNo", "standardNo"],
  "규격종류": ["규격종류", "specKind", "standardKind"],
  "규격서명": ["규격서명", "규격명", "제목", "품명", "title"],
  "재고번호": ["재고번호", "재고번호(NSN)", "NSN", "nsn"],
  "적용재고번호": ["적용재고번호", "적용 NSN", "NIIN"],
  "부품관리번호": ["부품관리번호", "partNo"],
  "제정기관": ["제정기관", "형상관리책임기관", "기관", "org"],
  "적용장비명": ["적용장비명", "적용장비", "장비명", "equipment"],
  "도면번호": ["도면번호", "drawingNo"],
  "규격상태": ["규격상태", "상태", "status"],
};

function valuesForParamField(row, field) {
  const aliases = [field, ...(VERIFY_FIELD_ALIASES[field] || [])];
  const out = [];
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, key)) out.push(row[key]);
  }
  return out.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
}

function valueMatchesExpected(value, expected, { exact = false } = {}) {
  const hay = normalizeMatchText(value);
  const needle = normalizeMatchText(expected);
  if (!needle) return true;
  if (!hay) return false;

  const hayCompact = compactMatchText(value);
  const needleCompact = compactMatchText(expected);
  if (exact) return hay === needle || hayCompact === needleCompact;
  return hay.includes(needle) || hayCompact.includes(needleCompact);
}

function verifyResultsByParams(params, data, opts = {}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const checkedParams = Object.entries(params || {})
    .filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== "");
  const sampleLimit = Math.max(1, Number(opts.sampleLimit || 50));
  const sampledRows = rows.slice(0, sampleLimit);

  if (rows.length === 0) {
    return {
      status: "empty",
      method: "rules",
      confidence: 0.7,
      summary: "KDSIS가 0건을 반환했습니다.",
      rowCount: 0,
      checkedCount: 0,
      warnings: checkedParams.length > 0 ? ["검색 조건에 맞는 결과가 없습니다."] : [],
      fieldChecks: [],
    };
  }

  if (checkedParams.length === 0) {
    return {
      status: "warn",
      method: "rules",
      confidence: 0.5,
      summary: "검색 조건이 비어 있어 결과 적합성을 제한적으로만 확인했습니다.",
      rowCount: rows.length,
      checkedCount: sampledRows.length,
      warnings: ["검색 조건이 비어 있습니다."],
      fieldChecks: [],
    };
  }

  const fieldChecks = checkedParams.map(([field, expected]) => {
    const exact = field === "규격상태";
    let matched = 0;
    let usedFallback = 0;

    for (const row of sampledRows) {
      const directValues = valuesForParamField(row, field);
      const targetValues = directValues.length > 0 ? directValues : [rowText(row)];
      if (directValues.length === 0) usedFallback++;
      if (targetValues.some((value) => valueMatchesExpected(value, expected, { exact }))) matched++;
    }

    return {
      field,
      expected: String(expected),
      checkedRows: sampledRows.length,
      matchedRows: matched,
      usedFallback,
    };
  });

  const warnings = [];
  for (const check of fieldChecks) {
    if (check.checkedRows === 0) continue;
    if (check.matchedRows === 0) {
      warnings.push(`${check.field}="${check.expected}" 조건과 일치하는 행을 찾지 못했습니다.`);
    } else if (check.matchedRows < check.checkedRows) {
      warnings.push(`${check.field}="${check.expected}" 조건과 일부 행만 일치합니다 (${check.matchedRows}/${check.checkedRows}).`);
    }
  }

  const hardFailures = fieldChecks.filter((c) => c.checkedRows > 0 && c.matchedRows === 0).length;
  const partials = fieldChecks.filter((c) => c.checkedRows > 0 && c.matchedRows > 0 && c.matchedRows < c.checkedRows).length;
  const status = hardFailures > 0 ? "fail" : partials > 0 ? "warn" : "pass";

  return {
    status,
    method: "rules",
    confidence: status === "pass" ? 0.86 : status === "warn" ? 0.62 : 0.35,
    summary:
      status === "pass"
        ? "검색 조건과 반환 행이 일치합니다."
        : status === "warn"
          ? "일부 결과는 검색 조건과 완전히 일치하지 않을 수 있습니다."
          : "검색 결과가 요청 조건과 맞지 않을 가능성이 큽니다.",
    rowCount: rows.length,
    checkedCount: sampledRows.length,
    warnings,
    fieldChecks,
  };
}

// Sliding-window rate limiter. Each check(key) records a timestamp; if the
// per-key count within windowMs exceeds max, returns { allowed: false,
// retryAfterMs: <ms until oldest hit falls off> }. Used for per-IP throttling
// on /api/detail and /api/attachment so a single client can't exhaust the
// Playwright download budget or trigger KDSIS IP blocks.
function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const arr = (hits.get(key) || []).filter((t) => t > cutoff);
      if (arr.length >= max) {
        const retryAfterMs = Math.max(0, arr[0] + windowMs - now);
        hits.set(key, arr);
        return { allowed: false, retryAfterMs, count: arr.length };
      }
      arr.push(now);
      hits.set(key, arr);
      return { allowed: true, retryAfterMs: 0, count: arr.length };
    },
    reset(key) { hits.delete(key); },
    clear() { hits.clear(); },
    get size() { return hits.size; },
    get windowMs() { return windowMs; },
    get max() { return max; },
  };
}

// Variant of createCache that tracks per-entry byte size and evicts LRU
// until both an entry-count cap (maxEntries) AND a total-bytes cap (maxBytes)
// are satisfied. An entry that itself exceeds maxBytes is not cached
// (set() returns false) — callers should just stream without caching.
function createByteBoundedCache({
  ttlMs = 300_000,
  maxEntries = 16,
  maxBytes = 50 * 1024 * 1024,
} = {}) {
  const store = new Map();
  let totalBytes = 0;

  function drop(key) {
    const e = store.get(key);
    if (!e) return;
    totalBytes -= e.bytes;
    store.delete(key);
  }

  return {
    get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt < Date.now()) { drop(key); return null; }
      // LRU touch
      store.delete(key);
      store.set(key, e);
      return e.data;
    },
    set(key, data, bytes) {
      const sz = Number(bytes);
      if (!Number.isFinite(sz) || sz < 0) return false;
      if (sz > maxBytes) return false;      // single entry too big — skip cache
      if (store.has(key)) drop(key);
      store.set(key, { data, bytes: sz, expiresAt: Date.now() + ttlMs });
      totalBytes += sz;
      while (store.size > maxEntries || totalBytes > maxBytes) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      return true;
    },
    delete(key) { drop(key); },
    clear() { store.clear(); totalBytes = 0; },
    get size() { return store.size; },
    get bytes() { return totalBytes; },
    get ttlMs() { return ttlMs; },
    get maxEntries() { return maxEntries; },
    get maxBytes() { return maxBytes; },
  };
}

// At-most-N parallel scheduler. createSerialQueue is concurrency 1 — for the
// download pool we want 2–3 so downloads don't block on each other, but not
// unbounded (Playwright contexts are expensive and KDSIS will block us if we
// pile on). Returns { run, active, queued } with .run(fn) → Promise<result>.
function createConcurrentQueue(n) {
  const limit = Math.max(1, Math.floor(Number(n) || 1));
  let active = 0;
  const waiters = [];
  function next() {
    while (active < limit && waiters.length > 0) {
      const { fn, resolve, reject } = waiters.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(
          (v) => { active--; resolve(v); next(); },
          (e) => { active--; reject(e); next(); }
        );
    }
  }
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waiters.push({ fn, resolve, reject });
        next();
      });
    },
    get active() { return active; },
    get queued() { return waiters.length; },
    get limit() { return limit; },
  };
}

// 검색 단계별 timeout 합이 총 wall-clock budget 안에 들어오는지 검증.
// dc2b004 회귀(SEARCH_TIMEOUT_MS=40s + sub-step 합계 60s+)를 빌드 타임에
// 잡기 위한 가드. Playwright 의존 없는 순수 함수라 단위 테스트 가능.
//   subBudgets: { stepName: ms, ... }   ms 는 각 step 의 worst-case 시간
//   totalBudget: 총 SEARCH_TIMEOUT_MS
// 반환: { ok, sum, totalBudget, overflow, subBudgets }
function validateSearchBudget({ subBudgets = {}, totalBudget = 0 } = {}) {
  const sum = Object.values(subBudgets).reduce(
    (a, b) => a + (Number(b) || 0),
    0
  );
  const total = Number(totalBudget) || 0;
  return {
    ok: sum <= total,
    sum,
    totalBudget: total,
    overflow: Math.max(0, sum - total),
    subBudgets,
  };
}

// 무한 스크롤 횟수 제한이 totalCount 를 커버할 수 있는지 사전 추정.
// 사후 auditResults 의 SCROLL_INCOMPLETE 경고 대신 startup 에서 잡고 싶을 때.
//   totalCount: 검색 결과 총 행 수 (알려진 경우)
//   maxScrolls: MAX_SCROLLS 환경변수 값
//   perScrollAvg: 한 번 스크롤 시 추가되는 평균 행 수 (KDSIS 관찰값 ~10)
//   initialBatch: 스크롤 전 첫 배치 크기 (~10)
// 반환: { projected, coverage(0..1), sufficient }
function projectScrollCoverage({
  totalCount = 0,
  maxScrolls = 0,
  perScrollAvg = 10,
  initialBatch = 10,
} = {}) {
  const tc = Number(totalCount) || 0;
  if (tc <= 0) {
    return { projected: 0, coverage: 1, sufficient: true };
  }
  const projected =
    Number(initialBatch) + Number(maxScrolls) * Number(perScrollAvg);
  return {
    projected,
    coverage: Math.min(1, projected / tc),
    sufficient: projected >= tc,
  };
}

function normalizeAttachmentName(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// DEXT5 renders file rows and action buttons as separate DOM nodes. Treating
// every matching node as a download target makes "filename" entries fail,
// because the actual download is "select filename, then click 다운로드".
function classifyAttachmentCandidate(candidate = {}) {
  const rawName = candidate.name || candidate.val || candidate.href || "";
  const name = normalizeAttachmentName(rawName);
  const href = String(candidate.href || "");
  const onclick = String(candidate.onclick || "");
  const matched = Array.isArray(candidate.matched) ? candidate.matched : [];
  const fileExtRe = /\.(pdf|hwp|hwpx|doc|docx|xls|xlsx|ppt|pptx|zip|txt|xml|jpg|jpeg|png|gif)\b/i;

  const directHref = href && !/^javascript:|^#$/i.test(href);
  const isBulk =
    /downloadAllFile/i.test(onclick) ||
    /^전체\s*다운로드$/.test(name);
  if (isBulk) {
    return {
      name: "전체 다운로드",
      kind: "dext-bulk",
      action: "download-all",
    };
  }

  const isButtonChrome =
    /openFile|downloadFile/i.test(onclick) ||
    /^(열기|다운로드)$/.test(name);
  if (isButtonChrome) return null;

  const looksLikeFile =
    fileExtRe.test(name) ||
    fileExtRe.test(href) ||
    fileExtRe.test(String(candidate.val || "")) ||
    matched.some((m) => /ext/i.test(String(m)));
  if (!looksLikeFile) return null;

  return {
    name,
    kind: directHref ? "direct" : "dext-file",
    action: directHref ? "direct" : "download-file",
  };
}

const KDSIS_ORIGIN = "https://kdsis.dapa.go.kr";
const KDSIS_DETAIL_POPUP_PATH = "/websquare/popup.do";
const KDSIS_DETAIL_DAPAUP = "/ui/sm/stdrdMgt/srch/opnSrch/viewTchdataOpenP.xml";
const KDSIS_DETAIL_POPUP_ID = "_SM_TCHDATA_VIEW_POPUP";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized !== "" && !/^(undefined|null)$/i.test(normalized)) return normalized;
    }
  }
  return "";
}

function buildKdsisDetailPopupUrl(fields = {}, origin = KDSIS_ORIGIN) {
  const tchdataHistryOid = firstNonEmpty(
    fields.tchdataHistryOid,
    fields.tchdataHistoryOid,
    fields.viewByTchdataHistryOidValue,
    fields.oid
  );
  if (!tchdataHistryOid) return "";

  const dtaDvsCd = firstNonEmpty(fields.dtaDvsCd, fields.dtaDvs, tchdataHistryOid[0]);
  const params = new URLSearchParams({
    dapaup: KDSIS_DETAIL_DAPAUP,
    popupFlag: "Y",
    viewByTchdataHistryOid: "Y",
    tchdataHistryOid,
    dtaDvsCd,
    specno: firstNonEmpty(fields.specno, fields.specNo),
    datano: firstNonEmpty(fields.datano, fields.dataNo),
    drwngno: firstNonEmpty(fields.drwngno, fields.drwgno, fields.drawingNo),
    cmpntsMasterOid: firstNonEmpty(fields.cmpntsMasterOid, fields.componentsMasterOid),
    popupID: firstNonEmpty(fields.popupID, KDSIS_DETAIL_POPUP_ID),
    w2xHome: "/ui/cm/popup/",
    w2xDocumentRoot: "",
  });
  const root = String(origin || KDSIS_ORIGIN).replace(/\/+$/, "");
  return `${root}${KDSIS_DETAIL_POPUP_PATH}?${params.toString().replace(/%2F/g, "/")}`;
}

function safeUrlFromMaybeRelative(raw, origin) {
  if (!raw) return "";
  const text = String(raw).replace(/&amp;/g, "&").trim();
  if (!text || /^javascript:/i.test(text) || text === "#") return "";
  try {
    return new URL(text, origin || KDSIS_ORIGIN).href;
  } catch {
    return "";
  }
}

function extractParam(text, key) {
  const s = String(text || "").replace(/&amp;/g, "&");
  const queryMatch = s.match(new RegExp(`[?&]${key}=([^&#'")\\s]+)`, "i"));
  if (queryMatch) {
    try {
      return firstNonEmpty(decodeURIComponent(queryMatch[1]));
    } catch {
      return firstNonEmpty(queryMatch[1]);
    }
  }
  const namedMatch = s.match(new RegExp(`${key}['"]?\\s*[:=,]\\s*['"]?([^'",)\\s&}]+)`, "i"));
  return namedMatch ? firstNonEmpty(namedMatch[1]) : "";
}

function extractKdsisDetailPopupUrl(sources, origin = KDSIS_ORIGIN) {
  const sourceList = Array.isArray(sources) ? sources : [sources];
  const text = sourceList
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join("\n")
    .replace(/&amp;/g, "&");

  const direct = text.match(
    /(?:https?:\/\/[^'")\s<>]+\/websquare\/popup\.do\?[^'")\s<>]+|\/websquare\/popup\.do\?[^'")\s<>]+)/i
  );
  if (direct) {
    const url = safeUrlFromMaybeRelative(direct[0], origin);
    if (url && /\/websquare\/popup\.do\?/i.test(url)) return url;
  }

  const tchdataHistryOid =
    extractParam(text, "tchdataHistryOid") ||
    extractParam(text, "tchdataHistoryOid") ||
    extractParam(text, "oid") ||
    (text.match(/\b[A-Z]\d{14,}\b/) || [])[0] ||
    "";
  if (!tchdataHistryOid) return "";

  return buildKdsisDetailPopupUrl(
    {
      tchdataHistryOid,
      dtaDvsCd: extractParam(text, "dtaDvsCd") || tchdataHistryOid[0],
      specno: extractParam(text, "specno"),
      datano: extractParam(text, "datano"),
      drwngno: extractParam(text, "drwngno") || extractParam(text, "drwgno"),
      cmpntsMasterOid: extractParam(text, "cmpntsMasterOid"),
      popupID: extractParam(text, "popupID"),
    },
    origin
  );
}

function sanitizeFilename(name, fallback = "download") {
  const raw = firstNonEmpty(name, fallback) || "download";
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/^\.+$/, "");
  return cleaned || fallback || "download";
}

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = _crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosDate, dosTime };
}

function writeU16(buf, value, offset) {
  buf.writeUInt16LE(value & 0xffff, offset);
}

function writeU32(buf, value, offset) {
  buf.writeUInt32LE(value >>> 0, offset);
}

function createZip(entries, date = new Date()) {
  const files = (entries || [])
    .map((entry, idx) => {
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
      return {
        name: sanitizeFilename(entry.name, `download-${idx + 1}.bin`),
        data,
        crc: crc32(data),
      };
    })
    .filter((entry) => entry.data.length > 0);

  const chunks = [];
  const central = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime(date);

  files.forEach((entry) => {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    writeU32(local, 0x04034b50, 0);
    writeU16(local, 20, 4);
    writeU16(local, 0x0800, 6);
    writeU16(local, 0, 8);
    writeU16(local, dosTime, 10);
    writeU16(local, dosDate, 12);
    writeU32(local, entry.crc, 14);
    writeU32(local, entry.data.length, 18);
    writeU32(local, entry.data.length, 22);
    writeU16(local, nameBuf.length, 26);
    writeU16(local, 0, 28);
    chunks.push(local, nameBuf, entry.data);

    const cd = Buffer.alloc(46);
    writeU32(cd, 0x02014b50, 0);
    writeU16(cd, 20, 4);
    writeU16(cd, 20, 6);
    writeU16(cd, 0x0800, 8);
    writeU16(cd, 0, 10);
    writeU16(cd, dosTime, 12);
    writeU16(cd, dosDate, 14);
    writeU32(cd, entry.crc, 16);
    writeU32(cd, entry.data.length, 20);
    writeU32(cd, entry.data.length, 24);
    writeU16(cd, nameBuf.length, 28);
    writeU16(cd, 0, 30);
    writeU16(cd, 0, 32);
    writeU16(cd, 0, 34);
    writeU16(cd, 0, 36);
    writeU32(cd, 0, 38);
    writeU32(cd, offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + entry.data.length;
  });

  const centralStart = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  writeU32(end, 0x06054b50, 0);
  writeU16(end, 0, 4);
  writeU16(end, 0, 6);
  writeU16(end, files.length, 8);
  writeU16(end, files.length, 10);
  writeU32(end, centralSize, 12);
  writeU32(end, centralStart, 16);
  writeU16(end, 0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

module.exports = {
  cacheKey,
  createCache,
  createSerialQueue,
  withTimeout,
  isTransient,
  expandHeaderCells,
  auditResults,
  verifyResultsByParams,
  createRateLimiter,
  createByteBoundedCache,
  createConcurrentQueue,
  validateSearchBudget,
  projectScrollCoverage,
  normalizeAttachmentName,
  classifyAttachmentCandidate,
  buildKdsisDetailPopupUrl,
  extractKdsisDetailPopupUrl,
  sanitizeFilename,
  createZip,
};
