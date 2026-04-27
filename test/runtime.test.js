/**
 * Unit tests for lib/runtime — uses Node's built-in test runner so no
 * external dev dependencies are required. Run with `npm test`.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  cacheKey,
  createCache,
  createSerialQueue,
  withTimeout,
  isTransient,
  expandHeaderCells,
  auditResults,
  createRateLimiter,
  createByteBoundedCache,
  createConcurrentQueue,
  validateSearchBudget,
  projectScrollCoverage,
} = require("../lib/runtime");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── cacheKey ───────────────────────────────────────────────

test("cacheKey: order-independent canonical key", () => {
  const a = cacheKey({ 규격번호: "1005-0409", 제정기관: "방위사업청" });
  const b = cacheKey({ 제정기관: "방위사업청", 규격번호: "1005-0409" });
  assert.equal(a, b);
});

test("cacheKey: empty params → empty string", () => {
  assert.equal(cacheKey({}), "");
  assert.equal(cacheKey(null), "");
  assert.equal(cacheKey(undefined), "");
});

test("cacheKey: single field", () => {
  assert.equal(cacheKey({ 규격번호: "1005-0409" }), "규격번호=1005-0409");
});

// ── createCache: TTL ───────────────────────────────────────

test("cache: hit before expiry, miss after", async () => {
  const c = createCache({ ttlMs: 80, max: 10 });
  c.set("k", { rows: [1] });
  assert.deepEqual(c.get("k"), { rows: [1] });
  await sleep(120);
  assert.equal(c.get("k"), null);
});

test("cache: zero-row payload is still cacheable", () => {
  const c = createCache({ ttlMs: 1000 });
  c.set("k", { rows: [], totalCount: 0 });
  assert.deepEqual(c.get("k"), { rows: [], totalCount: 0 });
});

// ── createCache: LRU ───────────────────────────────────────

test("cache: LRU evicts oldest when over max", () => {
  const c = createCache({ ttlMs: 10_000, max: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("d", 4); // evicts a
  assert.equal(c.get("a"), null);
  assert.equal(c.get("d"), 4);
  assert.equal(c.size, 3);
});

test("cache: read touches LRU position", () => {
  const c = createCache({ ttlMs: 10_000, max: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a"); // a becomes newest
  c.set("d", 4); // should evict b (now oldest), not a
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), null);
});

test("cache: re-set existing key resets position and TTL", async () => {
  const c = createCache({ ttlMs: 100, max: 3 });
  c.set("a", 1);
  await sleep(60);
  c.set("a", 2);          // refresh
  await sleep(60);        // 120ms total since first set, only 60ms since refresh
  assert.equal(c.get("a"), 2);
});

test("cache: clear and delete", () => {
  const c = createCache({ ttlMs: 10_000 });
  c.set("a", 1);
  c.set("b", 2);
  c.delete("a");
  assert.equal(c.get("a"), null);
  assert.equal(c.size, 1);
  c.clear();
  assert.equal(c.size, 0);
});

test("cache: ttlMs and max getters reflect config", () => {
  const c = createCache({ ttlMs: 1234, max: 7 });
  assert.equal(c.ttlMs, 1234);
  assert.equal(c.max, 7);
});

// ── createSerialQueue ──────────────────────────────────────

test("serial queue: tasks execute in submission order", async () => {
  const runSerial = createSerialQueue();
  const order = [];
  const p1 = runSerial(async () => { await sleep(20); order.push(1); });
  const p2 = runSerial(async () => { order.push(2); });
  const p3 = runSerial(async () => { order.push(3); });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("serial queue: rejection does not stall later tasks", async () => {
  const runSerial = createSerialQueue();
  const order = [];
  runSerial(async () => { order.push("a"); }).catch(() => {});
  runSerial(async () => { throw new Error("boom"); }).catch(() => {});
  await runSerial(async () => { order.push("b"); });
  assert.deepEqual(order, ["a", "b"]);
});

test("serial queue: returns the task's resolved value", async () => {
  const runSerial = createSerialQueue();
  const result = await runSerial(async () => 42);
  assert.equal(result, 42);
});

// ── withTimeout ────────────────────────────────────────────

test("withTimeout: resolves when promise wins the race", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 100, "test");
  assert.equal(r, "ok");
});

test("withTimeout: rejects with labeled error after deadline", async () => {
  const start = Date.now();
  await assert.rejects(
    withTimeout(sleep(500).then(() => "late"), 80, "[t]"),
    /\[t\] timeout after 80ms/
  );
  assert.ok(Date.now() - start < 200, "should reject near the deadline, not wait for the inner promise");
});

test("withTimeout: clears its timer on resolve (no leaked handle)", async () => {
  // If the timer leaks the test runner will hang past this point. The
  // assertion is just that we don't hang.
  await withTimeout(Promise.resolve("ok"), 50_000, "test");
  assert.ok(true);
});

// ── isTransient ────────────────────────────────────────────

test("isTransient: matches retryable error patterns", () => {
  assert.equal(isTransient("page goto timeout"), true);
  assert.equal(isTransient("Navigation failed"), true);
  assert.equal(isTransient("Target closed"), true);
  assert.equal(isTransient("Browser has been closed"), true);
  assert.equal(isTransient("frame was detached"), true);
  assert.equal(isTransient("net::ERR_CONNECTION_RESET"), true);
  assert.equal(isTransient("websocket disconnect"), true);
});

test("isTransient: rejects non-transient strings", () => {
  assert.equal(isTransient("invalid params"), false);
  assert.equal(isTransient("element not found"), false);
  assert.equal(isTransient(""), false);
  assert.equal(isTransient(null), false);
  assert.equal(isTransient(undefined), false);
});

// ── expandHeaderCells ──────────────────────────────────────

test("expandHeaderCells: no colspan keeps names 1:1", () => {
  assert.deepEqual(
    expandHeaderCells([
      { name: "규격번호", colspan: 1 },
      { name: "규격서명", colspan: 1 },
    ]),
    ["규격번호", "규격서명"]
  );
});

test("expandHeaderCells: colspan=3 expands to name(1..3)", () => {
  assert.deepEqual(
    expandHeaderCells([{ name: "형상관리책임기관", colspan: 3 }]),
    ["형상관리책임기관(1)", "형상관리책임기관(2)", "형상관리책임기관(3)"]
  );
});

test("expandHeaderCells: mixed single + group headers preserve order", () => {
  assert.deepEqual(
    expandHeaderCells([
      { name: "규격번호", colspan: 1 },
      { name: "형상관리책임기관", colspan: 3 },
      { name: "규격상태", colspan: 1 },
    ]),
    [
      "규격번호",
      "형상관리책임기관(1)",
      "형상관리책임기관(2)",
      "형상관리책임기관(3)",
      "규격상태",
    ]
  );
});

// ── auditResults ────────────────────────────────────────────

test("auditResults: clean input passes with no warnings", () => {
  const out = auditResults({
    columns: ["규격번호", "규격서명"],
    rows: [
      { 규격번호: "1005-0409", 규격서명: "총몸" },
      { 규격번호: "1005-0410", 규격서명: "총열" },
    ],
    totalCount: 2,
  });
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.warnings, []);
});

test("auditResults: drops all-empty rows and warns", () => {
  const out = auditResults({
    columns: ["a", "b"],
    rows: [
      { a: "x", b: "y" },
      { a: "", b: "" },
      { a: null, b: undefined },
    ],
    totalCount: 1,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.warnings.find((w) => w.code === "EMPTY_ROWS_DROPPED").count, 2);
});

test("auditResults: drops exact duplicate rows and warns", () => {
  const out = auditResults({
    columns: ["a"],
    rows: [{ a: "1" }, { a: "1" }, { a: "2" }, { a: "1" }],
    totalCount: 2,
  });
  assert.equal(out.rows.length, 2);
  assert.equal(out.warnings.find((w) => w.code === "DUPLICATE_ROWS_DROPPED").count, 2);
});

test("auditResults: flags column shape mismatch", () => {
  const out = auditResults({
    columns: ["a", "b", "c"],
    rows: [{ a: "1", b: "2", c: "3" }, { a: "x", b: "y" }],
    totalCount: 2,
  });
  const w = out.warnings.find((x) => x.code === "COLUMN_SHAPE_MISMATCH");
  assert.ok(w);
  assert.equal(w.count, 1);
  assert.equal(w.expected, 3);
});

test("auditResults: warns when totalCount > rendered (scroll incomplete)", () => {
  const out = auditResults({
    columns: ["a"],
    rows: [{ a: "1" }, { a: "2" }],
    totalCount: 50,
  });
  const w = out.warnings.find((x) => x.code === "SCROLL_INCOMPLETE");
  assert.ok(w);
  assert.equal(w.totalCount, 50);
  assert.equal(w.rendered, 2);
});

test("auditResults: warns when totalCount < rendered (overshoot)", () => {
  const out = auditResults({
    columns: ["a"],
    rows: [{ a: "1" }, { a: "2" }, { a: "3" }],
    totalCount: 1,
  });
  const w = out.warnings.find((x) => x.code === "OVERSHOT_TOTALCOUNT");
  assert.ok(w);
});

test("auditResults: missing data defaults to empty result set", () => {
  const out = auditResults(null);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.columns, []);
  assert.deepEqual(out.warnings, []);
});

// ── createRateLimiter ──────────────────────────────────────

test("rateLimiter: allows up to max within window", () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(rl.check("ip").allowed, true);
  assert.equal(rl.check("ip").allowed, true);
  assert.equal(rl.check("ip").allowed, true);
  const denied = rl.check("ip");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);
  assert.ok(denied.retryAfterMs <= 1000);
});

test("rateLimiter: separate keys do not share budget", () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("b").allowed, true);
  assert.equal(rl.check("a").allowed, false);
  assert.equal(rl.check("b").allowed, false);
});

test("rateLimiter: window slides as old hits expire", async () => {
  const rl = createRateLimiter({ windowMs: 80, max: 2 });
  rl.check("k"); rl.check("k");
  assert.equal(rl.check("k").allowed, false);
  await sleep(120);
  assert.equal(rl.check("k").allowed, true);
});

test("rateLimiter: reset wipes a single key", () => {
  const rl = createRateLimiter({ windowMs: 10_000, max: 1 });
  rl.check("k");
  assert.equal(rl.check("k").allowed, false);
  rl.reset("k");
  assert.equal(rl.check("k").allowed, true);
});

// ── createByteBoundedCache ─────────────────────────────────

test("byteCache: get/set with byte tracking", () => {
  const c = createByteBoundedCache({ ttlMs: 10_000, maxEntries: 10, maxBytes: 1000 });
  assert.equal(c.set("a", "one", 100), true);
  assert.equal(c.bytes, 100);
  assert.equal(c.get("a"), "one");
});

test("byteCache: evicts oldest to fit new entry under maxBytes", () => {
  const c = createByteBoundedCache({ ttlMs: 10_000, maxEntries: 10, maxBytes: 200 });
  c.set("a", "x", 100);
  c.set("b", "y", 90);
  c.set("c", "z", 50); // forces eviction; total 240 → drop a (oldest) to fit
  assert.equal(c.get("a"), null);
  assert.equal(c.get("b"), "y");
  assert.equal(c.get("c"), "z");
  assert.ok(c.bytes <= 200);
});

test("byteCache: single entry exceeding maxBytes is rejected", () => {
  const c = createByteBoundedCache({ ttlMs: 10_000, maxEntries: 10, maxBytes: 100 });
  assert.equal(c.set("big", "X", 200), false);
  assert.equal(c.get("big"), null);
  assert.equal(c.bytes, 0);
});

test("byteCache: re-set updates bytes and LRU position", () => {
  const c = createByteBoundedCache({ ttlMs: 10_000, maxEntries: 10, maxBytes: 1000 });
  c.set("a", "v1", 100);
  c.set("a", "v2", 50);
  assert.equal(c.get("a"), "v2");
  assert.equal(c.bytes, 50);
});

test("byteCache: TTL expiry clears bytes", async () => {
  const c = createByteBoundedCache({ ttlMs: 80, maxEntries: 10, maxBytes: 1000 });
  c.set("a", "x", 100);
  await sleep(120);
  assert.equal(c.get("a"), null);
  assert.equal(c.bytes, 0);
});

test("byteCache: delete reclaims bytes", () => {
  const c = createByteBoundedCache({ ttlMs: 10_000, maxEntries: 10, maxBytes: 1000 });
  c.set("a", "x", 100);
  c.set("b", "y", 200);
  c.delete("a");
  assert.equal(c.bytes, 200);
  assert.equal(c.size, 1);
});

// ── createConcurrentQueue ──────────────────────────────────

test("concurrentQueue: respects concurrency limit", async () => {
  const q = createConcurrentQueue(2);
  let peak = 0, inflight = 0;
  const task = async () => {
    inflight++; peak = Math.max(peak, inflight);
    await sleep(30);
    inflight--;
  };
  await Promise.all([q.run(task), q.run(task), q.run(task), q.run(task)]);
  assert.equal(peak, 2);
});

test("concurrentQueue: returns task result and surfaces rejection", async () => {
  const q = createConcurrentQueue(1);
  assert.equal(await q.run(async () => 42), 42);
  await assert.rejects(q.run(async () => { throw new Error("x"); }), /x/);
});

test("concurrentQueue: one task's rejection doesn't stall others", async () => {
  const q = createConcurrentQueue(1);
  const p1 = q.run(async () => { throw new Error("boom"); });
  const p2 = q.run(async () => "ok");
  await p1.catch(() => {});
  assert.equal(await p2, "ok");
});

test("concurrentQueue: active/queued counters track state", async () => {
  const q = createConcurrentQueue(1);
  let release;
  const blocked = q.run(() => new Promise((r) => { release = r; }));
  // Wait a tick for scheduler to promote the first task to active
  await Promise.resolve(); await Promise.resolve();
  q.run(async () => "later");
  assert.equal(q.active, 1);
  assert.equal(q.queued, 1);
  release();
  await blocked;
});

test("concurrentQueue: n<1 normalizes to 1", async () => {
  const q = createConcurrentQueue(0);
  assert.equal(q.limit, 1);
});

// ── validateSearchBudget ────────────────────────────────────
// dc2b004 회귀 시나리오 — 사용자가 본 "[KDSIS] search timeout after 40000ms"
// 의 직접 원인. sub-step worst-case 합계가 SEARCH_TIMEOUT_MS 를 넘으면 무조건
// 정상 검색이 컷된다. 이 테스트는 그 회귀를 빌드 타임에 잡는다.
test("validateSearchBudget: dc2b004 (40s budget) overflows", () => {
  const r = validateSearchBudget({
    subBudgets: {
      portalWarmup: 10_000,
      gotoKdsis: 30_000,
      formReady: 20_000,
      fieldSelectors: 5_000,
      clickSearch: 10_000,
      gridWait: 15_000,
      stabilize: 2_500,
      scrollLoop: 2_500 * 5,
    },
    totalBudget: 40_000,
  });
  assert.equal(r.ok, false);
  assert.ok(r.overflow > 0, "overflow > 0 expected");
  assert.equal(r.totalBudget, 40_000);
});

test("validateSearchBudget: 85s budget with diet sub-budgets passes", () => {
  const r = validateSearchBudget({
    subBudgets: {
      portalWarmup: 10_000,
      gotoKdsis: 20_000,
      formReady: 20_000,
      fieldSelectors: 5_000,
      clickSearch: 10_000,
      gridWait: 10_000,
      stabilize: 1_500,
      scrollLoop: 1_500 * 5,
    },
    totalBudget: 85_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.overflow, 0);
});

test("validateSearchBudget: empty input is trivially ok", () => {
  const r = validateSearchBudget({ subBudgets: {}, totalBudget: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.sum, 0);
});

// ── projectScrollCoverage ──────────────────────────────────
test("projectScrollCoverage: MAX_SCROLLS=5 cannot cover 230 rows", () => {
  const r = projectScrollCoverage({ totalCount: 230, maxScrolls: 5 });
  assert.equal(r.sufficient, false);
  assert.ok(r.projected < 230);
  assert.ok(r.coverage < 1);
});

test("projectScrollCoverage: MAX_SCROLLS=25 covers 230 rows", () => {
  const r = projectScrollCoverage({ totalCount: 230, maxScrolls: 25 });
  assert.equal(r.sufficient, true);
  assert.equal(r.coverage, 1);
});

test("projectScrollCoverage: unknown totalCount returns sufficient=true", () => {
  const r = projectScrollCoverage({ totalCount: 0, maxScrolls: 5 });
  assert.equal(r.sufficient, true);
});
