/**
 * ═══════════════════════════════════════════════════════════
 * 국방 AI 어시스턴트 — KDSIS 자동 검색 에이전트 서버
 * ═══════════════════════════════════════════════════════════
 *
 * 구조:
 *   사용자 자연어 → AI 파싱 (Claude/Gemini) → 검색 파라미터
 *   → Playwright로 KDSIS 폼 자동 입력 + 검색
 *   → 결과 테이블 파싱 → JSON 응답
 *
 * 환경변수:
 *   AI_PROVIDER=claude|gemini       (기본: claude)
 *   ANTHROPIC_API_KEY=sk-ant-...    (Claude 사용 시)
 *   GEMINI_API_KEY=AIza...          (Gemini 사용 시)
 *
 * 실행: npm install && npm run setup && npm start
 */

const express = require("express");
const { chromium } = require("playwright");
const https = require("https");
const { URL } = require("url");
const path = require("path");
const fs = require("fs");
const {
  cacheKey,
  createCache,
  withTimeout,
  isTransient,
  auditResults,
  createRateLimiter,
  createByteBoundedCache,
  createConcurrentQueue,
  validateSearchBudget,
} = require("./lib/runtime");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const KDSIS_URL =
  "https://kdsis.dapa.go.kr/cs/ctlgSpprtMgt/cagecd9250Mgt/gukminPopup.do?tabIdx=0&popYn=Y";

// ═══════════════════════════════════════════════════════════
// Browser pool + request queue + TTL cache
// ═══════════════════════════════════════════════════════════
// 구버전은 매 요청마다 chromium.launch() → close()로 3~5초 콜드 스타트를 냈다.
// 지금은 프로세스 당 싱글턴 브라우저를 유지하고, 요청마다 새 context/page를
// 띄운다. 동시 요청은 serial 큐로 직렬화 (같은 브라우저 위에서 grid 렌더가
// 겹쳐 망가지는 걸 봤음). 동일 params는 TTL 캐시가 즉답.

let _browser = null;
let _browserLaunching = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browserLaunching) return _browserLaunching;
  _browserLaunching = (async () => {
    console.log("[browser] chromium launching...");
    const b = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    b.on("disconnected", () => {
      if (_browser === b) _browser = null;
      console.warn("[browser] disconnected — will relaunch on next request");
    });
    _browser = b;
    console.log("[browser] ready");
    return b;
  })();
  try {
    return await _browserLaunching;
  } finally {
    _browserLaunching = null;
  }
}

async function closeBrowser() {
  const b = _browser;
  _browser = null;
  if (b) {
    try { await b.close(); } catch {}
  }
}

// Serial queue — concurrency 1. A shared Chromium can technically run two
// contexts in parallel, but KDSIS' WebSquare grid occasionally races when
// two searches land in the same tick, and memory blows up fast. Queueing
// is fine because repeat callers hit the cache anyway.
// Default concurrency 1 preserves the old serial behaviour; raise
// KDSIS_SEARCH_CONCURRENCY (e.g. 2) to let batch searches process in
// parallel without unleashing unlimited contexts.
const SEARCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.KDSIS_SEARCH_CONCURRENCY || 2)
);
const searchQueue = createConcurrentQueue(SEARCH_CONCURRENCY);
const runSerial = (fn) => searchQueue.run(fn);

// TTL+LRU cache with in-flight dedup. Non-error results (even empty) get
// cached by canonical params key.
const CACHE_TTL_MS = Number(process.env.KDSIS_CACHE_TTL_MS || 60_000);
const cache = createCache({ ttlMs: CACHE_TTL_MS, max: 64 });
const _inFlight = new Map();   // key → Promise<results>

// ── Attachment proxy infra (/api/detail & /api/attachment) ──
// Separate concurrency pool from the search queue — downloads shouldn't
// block searches and vice versa. Lazy: attachment metadata + bytes are
// only fetched when the client explicitly opens a row / clicks a file.
// 512MB 메모리 환경에서 검색 컨텍스트(2) + 다운로드 컨텍스트(2) = 동시 4개
// Playwright 컨텍스트로 OOM 위험. 다운로드는 1로 낮춰 메모리 압박 줄이기.
// (배치 검색은 여전히 동시성 2 로 활용 가능 — 검색이 다운로드보다 더 자주
// 발생하는 작업.)
const DOWNLOAD_CONCURRENCY = Number(process.env.KDSIS_DOWNLOAD_CONCURRENCY || 1);
const downloadPool = createConcurrentQueue(DOWNLOAD_CONCURRENCY);

// Metadata cache: { attachments: [...] } keyed by params + row-key.
const DETAIL_TTL_MS = Number(process.env.KDSIS_DETAIL_TTL_MS || 600_000);
const detailCache = createCache({ ttlMs: DETAIL_TTL_MS, max: 128 });

// Byte cache: attachment file bytes keyed by params + row-key + attachment id.
// Total bytes capped so one big file can't evict everything useful.
const ATTACH_TTL_MS = Number(process.env.KDSIS_ATTACH_TTL_MS || 300_000);
const ATTACH_CACHE_MAX_BYTES = Number(process.env.KDSIS_ATTACH_CACHE_MAX_BYTES || 50 * 1024 * 1024);
const attachCache = createByteBoundedCache({
  ttlMs: ATTACH_TTL_MS,
  maxEntries: 32,
  maxBytes: ATTACH_CACHE_MAX_BYTES,
});

// Per-IP rate limiter shared by /api/detail and /api/attachment. KDSIS has
// historically IP-blocked callers that hammer it; we cap each client so a
// single misbehaving user can't exhaust our KDSIS budget.
const DOWNLOAD_RATE_LIMIT = Number(process.env.KDSIS_DOWNLOAD_RATE_LIMIT || 10);
const DOWNLOAD_RATE_WINDOW_MS = Number(process.env.KDSIS_DOWNLOAD_RATE_WINDOW_MS || 60_000);
const downloadRateLimiter = createRateLimiter({
  windowMs: DOWNLOAD_RATE_WINDOW_MS,
  max: DOWNLOAD_RATE_LIMIT,
});

// Rolling 15-min count of KDSIS-origin block responses (403 / "접근 거부"
// landing). Lets the operator tell IP-block from code bug via /api/health.
const BLOCK_WINDOW_MS = 15 * 60_000;
let _blockHits = [];
function recordBlockHit() {
  const now = Date.now();
  _blockHits.push(now);
  _blockHits = _blockHits.filter((t) => t > now - BLOCK_WINDOW_MS);
}
function currentBlockCount() {
  const cutoff = Date.now() - BLOCK_WINDOW_MS;
  return _blockHits.filter((t) => t > cutoff).length;
}

// ── AI 설정 ──────────────────────────────────────────────
const AI_PROVIDER = (process.env.AI_PROVIDER || "claude").toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// KDSIS가 화면 리뉴얼할 때마다 검색 버튼 id가 조금씩 바뀌어 왔다. 한 개만
// 믿지 말고 관찰된 후보를 순서대로 시도한다. 진단 모드와 메인 검색 경로가
// 같은 리스트를 쓰도록 단일 상수로 통일.
const SEARCH_BUTTON_SELECTORS = [
  "#btn_search1",
  "#btn_search",
  "#btnSearch",
  "#btn_srch",
  'input[type="button"][value="검색"]',
  'button:has-text("검색")',
];

// KDSIS가 결과 그리드 id를 바꾼 전례가 있어 하드코딩하지 않고 후보 리스트에서
// 런타임에 고른다. 운영 관찰상 실제 검색 결과는 ggr_stndList에 들어가고,
// ggr_exelSearchList는 "엑셀다운로드" 용 보조 그리드로 보인다. 따라서 실제
// 데이터가 있는 grid를 우선 고르고, 없으면 tbody가 존재하는 첫 후보로 폴백.
const GRID_ID_CANDIDATES = ["ggr_stndList", "ggr_exelSearchList"];
// 후보 중 실제로 행이 있는 grid를 우선 고른다. page.evaluate 안에서
// `eval(PICK_GRID_ID)(gridIds)` 형태로 쓰도록 문자열 템플릿 대신 해당 함수
// 로직을 각 evaluate에서 인라인한다 — Playwright가 콜백 본문만 직렬화하므로
// 외부 참조가 남으면 ReferenceError가 된다.

async function clickSearchButton(page, { timeout = 10000 } = {}) {
  // WebSquare가 버튼을 JS로 나중에 붙이는 경우가 있어, 즉시 $()로 조회하면
  // 초기화가 끝나기 전에 실패한다. 250ms 간격으로 deadline까지 폴링하며
  // 최초로 DOM에 붙은 후보를 클릭.
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    for (const sel of SEARCH_BUTTON_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        await page.click(sel);
        return { clicked: sel, tried: SEARCH_BUTTON_SELECTORS };
      } catch (e) {
        lastErr = e;
      }
    }
    await page.waitForTimeout(250);
  }
  // 타임아웃 순간의 DOM 스냅샷 — "어떤 셀렉터를 시도했는지"만으로는
  // 폼 자체가 비어있었는지 / 버튼만 다른 id로 렌더됐는지 구분이 안 된다.
  const diagnostics = await page.evaluate((fieldIds) => {
    const btnIds = [];
    document.querySelectorAll('[id^="btn_"], [id*="earch"]').forEach((el) => {
      if (el.id && btnIds.length < 20) btnIds.push(el.id);
    });
    const presentFields = fieldIds.filter((id) => !!document.getElementById(id));
    return {
      url: location.href,
      title: document.title,
      btnIds,
      fieldsPresent: presentFields.length,
      fieldsTotal: fieldIds.length,
    };
  }, Object.values(FIELD_MAP).map((c) => c.id)).catch(() => ({ error: "diagnostics evaluate failed" }));

  const err = new Error(
    `검색 버튼을 찾지 못했습니다. 시도한 셀렉터: ${SEARCH_BUTTON_SELECTORS.join(", ")}${
      lastErr ? ` (마지막 에러: ${lastErr.message})` : ""
    }`
  );
  err.tried = SEARCH_BUTTON_SELECTORS;
  err.diagnostics = diagnostics;
  throw err;
}

// Shared "open KDSIS" pathway. Both the main search and the
// detail/attachment replay flows need the same behavior:
//   1) portal warmup so KDSIS sees a same-origin nav into the popup,
//   2) deep-link goto with HTTP status check (403/429 → BLOCKED),
//   3) DOM readiness wait.
// Factored here so the two paths can't drift out of sync again.
async function navigateToKdsis(page, { warmup = true } = {}) {
  if (warmup) {
    // Hit the portal root first. Establishes session cookies and — more
    // importantly — makes the subsequent popup navigation look same-origin
    // rather than a bare deep link. Cheap (<1s, small HTML) and swallowed
    // silently if it fails so we don't punish already-warm contexts.
    try {
      await page.goto("https://kdsis.dapa.go.kr/", {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
    } catch (err) {
      console.warn("[KDSIS] portal warmup skipped:", err.message);
    }
  }
  const response = await page.goto(KDSIS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  if (response && !response.ok() && response.status() !== 304) {
    recordBlockHit();
    const err = new Error("KDSIS_BLOCKED");
    err.diagnostics = { httpStatus: response.status(), url: response.url() };
    throw err;
  }
  await waitForKdsisReady(page);
}

// Waits for the KDSIS search form to be fully initialized. Originally this
// required BOTH a known field id AND a known button selector to be present,
// but KDSIS's WebSquare wraps / re-ids some field inputs, so the field check
// was flaky while the button check was reliable. fillSearchForm already
// tolerates missing fields individually, so the minimum useful readiness
// signal is "search button exists" — that's exactly what the next step
// (clickSearchButton) needs. On timeout we collect a DOM diagnostic and
// re-classify the failure: an essentially-empty body (bodyLen < 20) with a
// normal title is almost always KDSIS returning a blank shell because the IP
// was throttled / the deep link was refused, not a readiness race.
async function waitForKdsisReady(page, { timeout = 20000 } = {}) {
  // Filter out Playwright-only selectors (e.g. `button:has-text(...)`): inside
  // page.waitForFunction we run against the real DOM, where those throw
  // SyntaxError on querySelector, which propagates out of .some() and
  // immediately rejects waitForFunction — so the 20s budget never applies and
  // we misclassify a slow-to-render WebSquare form as KDSIS_BLOCKED. Keep only
  // standards-compliant CSS for the readiness check. Playwright-only selectors
  // are fine in clickSearchButton() because that uses page.locator.
  const buttonSelectors = SEARCH_BUTTON_SELECTORS.filter((s) => !s.includes(":has-text"));
  try {
    await page.waitForFunction(
      (btns) =>
        btns.some((s) => {
          try {
            return !!document.querySelector(s);
          } catch (_) {
            return false;
          }
        }),
      buttonSelectors,
      { timeout, polling: 250 }
    );
  } catch (_) {
    const diagnostics = await page.evaluate((fieldIds) => {
      const btnIds = [];
      document.querySelectorAll('[id^="btn_"], [id*="earch"]').forEach((el) => {
        if (el.id && btnIds.length < 20) btnIds.push(el.id);
      });
      return {
        url: location.href,
        title: document.title,
        btnIds,
        fieldsPresent: fieldIds.filter((id) => !!document.getElementById(id)).length,
        fieldsTotal: fieldIds.length,
        bodyLen: (document.body?.textContent || "").length,
        iframes: document.querySelectorAll("iframe").length,
        scripts: document.querySelectorAll("script").length,
      };
    }, Object.values(FIELD_MAP).map((c) => c.id)).catch(() => ({ error: "diagnostics evaluate failed" }));
    // Empty body after the full timeout = KDSIS served a blank page.
    // That's a block / deep-link refusal, not a readiness race.
    const empty = diagnostics && typeof diagnostics.bodyLen === "number" && diagnostics.bodyLen < 20;
    const err = new Error(empty ? "KDSIS_BLOCKED" : "KDSIS_FORM_NOT_READY");
    err.diagnostics = diagnostics;
    if (empty) recordBlockHit();
    throw err;
  }
}

// Fills the KDSIS search form on an already-loaded page. Shared between the
// main search path and the detail/attachment replay flow so the form-fill
// behavior can't drift between endpoints. FIELD_MAP must be initialized
// before this runs (it's defined below but both functions are hoisted at
// call time, so ordering is fine).
// NOTE: 메인 검색 경로(`_runSearchOnce`) 는 이 헬퍼를 호출하지 않고 자체
// 인라인 로직(아래 약 685-711 라인)을 쓴다. 이 헬퍼는 첨부 재현 흐름
// (`openRowDetail`) 전용 — Tab/keyup 등 무거운 시퀀스가 메인 검색을
// 깨뜨리지 않게 분리되어 있다. 둘을 통합하려면 양쪽 모두 회귀 테스트 필요.
async function fillSearchForm(page, params) {
  for (const [fieldName, value] of Object.entries(params || {})) {
    const config = FIELD_MAP[fieldName];
    if (!config) continue;
    const sel = `#${config.id}`;
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      if (config.type === "text") {
        // WebSquare w2input은 자체 이벤트 파이프라인으로 값을 바인딩하는데,
        // page.fill만으로는 focus → keydown/keyup → change 시퀀스가 부족해
        // 내부 모델에 값이 반영되지 않는 경우가 관찰됐다(검색 시 필터 없이
        // 제출되어 0건 또는 전체 결과가 나오는 증상). focus → clear → type →
        // blur로 실제 사용자 타이핑을 재현하고, 추가로 JS로 value 를 직접
        // 세팅한 뒤 input/change 이벤트를 dispatch — 어느 한쪽이 막혀도
        // 다른 쪽이 반영되도록 이중 안전장치.
        await page.focus(sel);
        await page.fill(sel, "");
        await page.type(sel, String(value), { delay: 20 });
        await page.evaluate(
          ({ s, v }) => {
            const el = document.querySelector(s);
            if (!el) return;
            el.value = v;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
          },
          { s: sel, v: String(value) }
        );
        await page.keyboard.press("Tab").catch(() => {});
      } else {
        await page.selectOption(sel, { label: value });
        await page.dispatchEvent(sel, "change");
      }
    } catch (err) {
      console.warn(`[KDSIS] 폼 입력 실패 (${fieldName}):`, err.message);
    }
  }
}

// Waits for the grid to render or report zero rows. Used after clickSearchButton.
async function waitForGridResult(page, timeoutMs = 15000) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(
    (gridIds) => {
      for (const gid of gridIds) {
        const tb = document.getElementById(`${gid}_body_tbody`);
        if (tb) {
          const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
          if (rows.length > 0) return true;
        }
      }
      // zero-row signal: any element whose id ends with "listCnt" reading "0건".
      const cntEls = document.querySelectorAll('[id$="listCnt"], #spn_listCnt');
      for (const el of cntEls) {
        const txt = (el.textContent || "").trim();
        if (/^0건?$/.test(txt) || txt === "0") return true;
      }
      return false;
    },
    GRID_ID_CANDIDATES,
    { timeout: timeoutMs }
  ).catch(() => {});
}

// ── KDSIS 검색 필드 매핑 ──────────────────────────────────
const FIELD_MAP = {
  규격종류: { id: "gee_stdrdKndCd_input_0", type: "select" },
  규격번호: { id: "gee_specno", type: "text" },
  "재고번호": { id: "gee_nsn", type: "text" },
  "연관재고번호": { id: "gee_relNsn", type: "text" },
  규격서명: { id: "gee_dtaNm", type: "text" },
  부품관리번호: { id: "gee_cmpntsMgtno", type: "text" },
  제정기관: { id: "gee_enactOrganCd_input_0", type: "select" },
  적용장비명: { id: "gee_aplyEqpNm", type: "text" },
  도면번호: { id: "gee_drwgno", type: "text" },
  규격상태: { id: "stdrdStateCd_input_0", type: "select" },
};

// 규격종류 옵션 매핑
const SPEC_TYPE_MAP = {
  "국방표준": "KDS (국방/표준)",
  "국방정식": "KDS (국방/정식)",
  "국방임시": "KDC (국방/임시)",
  "수출용": "EXS (수출용)",
  "KDS": "KDS (국방/표준)",
  "KDC": "KDC (국방/임시)",
  "EXS": "EXS (수출용)",
};

// 규격상태 옵션 매핑
const STATUS_MAP = {
  "활성": "활성",
  "비활성": "비활성",
  "전환": "전환",
  "폐지": "폐지",
};

// 제정기관 매핑
const ORG_KEYWORDS = [
  "합동참모본부", "공군본부", "국방부", "육군", "해군", "공군",
  "방위사업청", "국방기술품질원", "국방기술진흥연구소",
  "국방과학연구소", "조달청",
];

// ── 자연어 → 검색 파라미터 변환 (AI + 폴백) ─────────────

const AI_SYSTEM_PROMPT = `당신은 KDSIS(국방표준종합정보시스템) 검색 에이전트입니다.
사용자의 자연어 질문을 분석하여 KDSIS 검색 폼에 입력할 파라미터를 JSON으로 반환하세요.

사용 가능한 필드:
- "규격종류": "KDS (국방/표준)" | "KDS (국방/정식)" | "KDC (국방/임시)" | "EXS (수출용)"
- "규격번호": 규격 번호 문자열
- "재고번호": NSN 또는 NIIN 번호
- "연관재고번호": 연관 NSN/NIIN
- "규격서명": 규격서 이름 키워드
- "부품관리번호": 부품 관리 번호
- "제정기관": "합동참모본부" | "국방부" | "육군" | "해군" | "공군" | "방위사업청" | "국방기술품질원" | "국방기술진흥연구소" | "국방과학연구소" | "조달청"
- "적용장비명": 장비 이름 (예: K2 소총, K1A 기관단총)
- "도면번호": 도면 번호
- "규격상태": "활성" | "비활성" | "전환" | "폐지"

규칙:
1. 해당하는 필드만 포함하세요. 빈 값은 넣지 마세요.
2. 반드시 JSON 객체만 반환하세요. 다른 텍스트는 포함하지 마세요.
3. 장비명에서 K1, K2 등은 적용장비명으로 매핑하세요.
4. 검색, 찾아줘, 보여줘 등의 동사는 제거하고 핵심 키워드만 추출하세요.
5. 부품 이름이나 품명 키워드는 "규격서명"에 넣으세요.

예시:
입력: "K2 소총 총몸 알루미늄 부품 중에 활성 상태인 것만 찾아줘"
출력: {"적용장비명": "K2 소총", "규격서명": "총몸 알루미늄", "규격상태": "활성"}

입력: "국방기술품질원이 제정한 KDS 규격 검색"
출력: {"제정기관": "국방기술품질원", "규격종류": "KDS (국방/표준)"}`;

// Claude API 호출
async function parseWithClaude(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });
  const data = await res.json();
  const content = data.content?.[0]?.text || "{}";
  return JSON.parse(content.replace(/```json|```/g, "").trim());
}

// Gemini API 호출
async function parseWithGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: AI_SYSTEM_PROMPT + "\n\n입력: " + text + "\n출력:" }],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 300 },
    }),
  });
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(content.replace(/```json|```/g, "").trim());
}

// 규칙 기반 파싱 (폴백)
function parseWithRules(text) {
  const params = {};
  const lower = text.toLowerCase();

  const specNoMatch = text.match(/[A-Z]{2,3}[\s\-]?\d{3,5}[\s\-]?\d{0,5}/i);
  if (specNoMatch) params["규격번호"] = specNoMatch[0].trim();

  const nsnMatch = text.match(/\d{4}-\d{2}-\d{3}-\d{4}/);
  if (nsnMatch) params["재고번호"] = nsnMatch[0];

  const niinMatch = text.match(/\d{2}-\d{3}-\d{4}/);
  if (niinMatch && !nsnMatch) params["재고번호"] = niinMatch[0];

  for (const [kw, val] of Object.entries(SPEC_TYPE_MAP)) {
    if (text.includes(kw)) { params["규격종류"] = val; break; }
  }
  for (const [kw, val] of Object.entries(STATUS_MAP)) {
    if (text.includes(kw)) { params["규격상태"] = val; break; }
  }
  for (const org of ORG_KEYWORDS) {
    if (text.includes(org)) { params["제정기관"] = org; break; }
  }

  const eqPatterns = [
    /K\d+[A-Z]?\s*(?:소총|기관단총|기관총|유탄발사기|박격포|전차|장갑차|자주포)/i,
    /[가-힣]+(?:소총|기관단총|기관총|전차|장갑차|자주포|함정|항공기|헬기|미사일)/,
  ];
  for (const pat of eqPatterns) {
    const m = text.match(pat);
    if (m) { params["적용장비명"] = m[0].trim(); break; }
  }

  const drawingMatch = text.match(/[A-Z]{1,3}-?\d{5,}/i);
  if (drawingMatch && !specNoMatch) params["도면번호"] = drawingMatch[0];

  if (Object.keys(params).length === 0) {
    const cleaned = text
      .replace(/[을를이가은는의에서도로만으며고해서줘요]/g, " ")
      .replace(/찾아|검색|조회|보여|알려|목록/g, " ")
      .trim().replace(/\s+/g, " ");
    if (cleaned.length > 0) params["규격서명"] = cleaned;
  }
  return params;
}

// 메인 파싱 함수: AI 우선 → 규칙 기반 폴백
async function parseQuery(text) {
  // AI API 키가 있으면 AI 사용
  const useAI =
    (AI_PROVIDER === "claude" && ANTHROPIC_API_KEY) ||
    (AI_PROVIDER === "gemini" && GEMINI_API_KEY);

  if (useAI) {
    try {
      console.log(`[AI] ${AI_PROVIDER} 파싱 중...`);
      const params =
        AI_PROVIDER === "claude"
          ? await parseWithClaude(text)
          : await parseWithGemini(text);
      console.log(`[AI] 결과:`, params);

      if (params && Object.keys(params).length > 0) return params;
    } catch (err) {
      console.warn(`[AI] ${AI_PROVIDER} 파싱 실패, 규칙 기반으로 폴백:`, err.message);
    }
  } else {
    console.log("[AI] API 키 미설정 → 규칙 기반 파싱");
  }

  return parseWithRules(text);
}

// ── Playwright로 KDSIS 검색 실행 ─────────────────────────
// Public entry point: dedup + cache + serial queue around the raw Playwright
// call. Cache and in-flight dedup live OUTSIDE the serial queue so that two
// identical concurrent requests don't both run Playwright.
async function searchKDSIS(params) {
  const key = cacheKey(params);
  const cached = cache.get(key);
  if (cached) {
    console.log(`[cache] hit: ${key || "(empty key)"}`);
    return { ...cached, __cached: true };
  }
  if (_inFlight.has(key)) {
    console.log(`[cache] in-flight join: ${key || "(empty key)"}`);
    return _inFlight.get(key);
  }
  const p = runSerial(() => _runSearch(params))
    .then((results) => {
      // Cache non-error results (including zero-row) so repeat empty searches
      // also go instant. Errors stay uncached so retries actually retry.
      if (results && !results.error) cache.set(key, results);
      return results;
    })
    .finally(() => _inFlight.delete(key));
  _inFlight.set(key, p);
  return p;
}

// Wall-clock timeout for a single search attempt. Cloudflare 100s 게이트웨이가
// 천장이므로 그 안에 단일 시도가 들어와야 한다. dc2b004 에서 40s 로 줄였더니
// sub-step 합계(portalWarmup 10s + gotoKdsis 30s + formReady 20s + ... ≈ 100s)
// 가 넘어 정상 검색이 "[KDSIS] search timeout after 40000ms" 로 컷되는 회귀
// 발생. Standard 플랜(Always On)에서는 cold-start 비용이 사라졌으므로 85s 로
// 다시 풀고, sub-step 도 함께 다이어트해서 happy path 가 ~22s 안에 끝나게.
// SEARCH_RETRIES 는 클라이언트(fetchWithRetry)가 5xx 재시도를 담당하므로 0.
const SEARCH_TIMEOUT_MS = Number(process.env.KDSIS_SEARCH_TIMEOUT_MS || 85_000);
const SEARCH_RETRIES = Number(process.env.KDSIS_SEARCH_RETRIES || 0);

async function _runSearch(params) {
  let lastError = null;
  for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt++) {
    try {
      const result = await withTimeout(
        _runSearchOnce(params),
        SEARCH_TIMEOUT_MS,
        "[KDSIS] search"
      );
      // _runSearchOnce returns { error: msg } for soft failures. Retry only
      // if the error looks transient.
      if (result && result.error && isTransient(result.error) && attempt < SEARCH_RETRIES) {
        lastError = result.error;
        console.warn(`[KDSIS] 시도 ${attempt + 1} 실패 (transient), 재시도: ${lastError}`);
        continue;
      }
      if (attempt > 0 && result && !result.error) {
        console.log(`[KDSIS] 재시도 성공 (시도 ${attempt + 1})`);
      }
      // 정상 결과 경로에만 백엔드 검증 적용. 에러 응답은 audit을 건너뛰고
      // 그대로 통과시켜 retry/에러 핸들러가 원형을 볼 수 있게 둔다.
      if (result && !result.error) {
        const audited = auditResults(result);
        if (audited.warnings.length > 0) {
          console.warn(
            `[KDSIS][audit] params=${cacheKey(params) || "(empty)"} warnings=${JSON.stringify(audited.warnings)}`
          );
        }
        return {
          rows: audited.rows,
          columns: audited.columns,
          totalCount: audited.totalCount || audited.rows.length,
        };
      }
      return result;
    } catch (err) {
      lastError = err.message || String(err);
      if (attempt < SEARCH_RETRIES && isTransient(lastError)) {
        console.warn(`[KDSIS] 시도 ${attempt + 1} 예외, 재시도: ${lastError}`);
        continue;
      }
      return { rows: [], columns: [], totalCount: 0, error: lastError };
    }
  }
  return { rows: [], columns: [], totalCount: 0, error: lastError };
}

async function _runSearchOnce(params) {
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      locale: "ko-KR",
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      extraHTTPHeaders: { Referer: "https://kdsis.dapa.go.kr/" },
    });

    const page = await context.newPage();

    // 1) KDSIS 페이지 로드 — portal warmup → deep link → HTTP status check
    //    → DOM 준비. networkidle은 쓰지 않는다 (WebSquare가 long-poll / 주기
    //    XHR을 계속 열고 있어서 idle이 영영 안 오는 경우가 있다).
    console.log("[KDSIS] 페이지 로딩 중...");
    await navigateToKdsis(page);

    // 2) 검색 필드 입력
    console.log("[KDSIS] 검색 조건 입력:", params);

    for (const [fieldName, value] of Object.entries(params)) {
      const config = FIELD_MAP[fieldName];
      if (!config) {
        console.warn(`[KDSIS] 알 수 없는 필드: ${fieldName}`);
        continue;
      }

      try {
        if (config.type === "text") {
          const selector = `#${config.id}`;
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.fill(selector, "");
          await page.fill(selector, value);
          // WebSquare 입력 이벤트 트리거
          await page.dispatchEvent(selector, "change");
          console.log(`[KDSIS]   ${fieldName} = "${value}"`);
        } else if (config.type === "select") {
          const selector = `#${config.id}`;
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.selectOption(selector, { label: value });
          await page.dispatchEvent(selector, "change");
          console.log(`[KDSIS]   ${fieldName} = "${value}" (select)`);
        }
      } catch (err) {
        console.warn(`[KDSIS]   필드 입력 실패 (${fieldName}):`, err.message);
      }
    }

    // 3) 검색 버튼 클릭 — 관찰된 id 후보들을 순차 시도 (진단 경로와 동일)
    console.log("[KDSIS] 검색 실행...");
    const { clicked: clickedBtn } = await clickSearchButton(page);
    console.log(`[KDSIS] 검색 버튼: ${clickedBtn}`);

    // 4) 결과 로딩 대기
    // WebSquare w2grid는 검색 후 비동기로 행을 생성하므로
    // 고정 타임아웃 대신 "실제로 행이 나타날 때까지" 명시적으로 기다림
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForFunction(
      (gridIds) => {
        for (const gid of gridIds) {
          const tb = document.getElementById(`${gid}_body_tbody`);
          if (tb) {
            const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
            if (rows.length > 0) return true;
          }
        }
        const cntEls = document.querySelectorAll('[id$="listCnt"], #spn_listCnt');
        for (const el of cntEls) {
          const txt = (el.textContent || "").trim();
          if (/^0건?$/.test(txt) || txt === "0") return true;
        }
        return false;
      },
      GRID_ID_CANDIDATES,
      { timeout: 10000 }
    ).catch(() => {
      console.warn("[KDSIS] 그리드 렌더링 대기 타임아웃 (10초) — 계속 진행");
    });
    // 안정화용 추가 대기 — diagnosticSearch가 스크린샷/DOM 스캔으로 우연히 얻던 버퍼와 맞춤
    await page.waitForTimeout(1500);

    // 5) 결과 파싱 — KDSIS WebSquare w2grid (tbody 후보: GRID_ID_CANDIDATES)
    //   칼럼은 하드코딩하지 않고 thead를 읽어서 동적으로 구성. grid id는 DOM에
    //   실제로 존재하는 첫 후보를 골라 본 검색과 스크롤 루프에서 공유한다.
    console.log("[KDSIS] 결과 파싱 중...");
    const parsed = await page.evaluate((gridIds) => {
      const data = { rows: [], columns: [], totalCount: 0, activeGridId: null };

      // 실제로 DOM에 붙어있는 첫 후보를 고른다.
      const gridId = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`));
      data.activeGridId = gridId || null;
      if (!gridId) return data;

      // ── 헤더에서 칼럼명 추출 ──
      // KDSIS w2grid는 "형상관리책임기관" 같은 그룹 헤더에 colspan=3을 붙여
      // 하위 3개 데이터 칼럼을 묶는다. colspan을 펼쳐야 td와 1:1 매칭됨.
      const headOrder = [];
      const thead =
        document.getElementById(`${gridId}_header_thead`) ||
        document.querySelector(`#${gridId} thead`);
      if (thead) {
        thead.querySelectorAll("th[col_id]").forEach((th) => {
          const name = (th.textContent || "").trim() || th.getAttribute("col_id");
          const colspan = parseInt(th.getAttribute("colspan") || "1", 10);
          if (colspan > 1) {
            for (let i = 0; i < colspan; i++) headOrder.push(`${name}(${i + 1})`);
          } else {
            headOrder.push(name);
          }
        });
      }
      data.columns = headOrder.slice();

      // ── tbody 행 파싱 ──
      // thead col_id(column53 등)와 td col_id(stdrdKndNm 등)는 서로 다른
      // 네임스페이스라 속성값으로 매칭하면 안 됨. td 순서 기반으로 짝짓는다.
      // 첫 번째 td는 row number 셀(id=_headerRowNumber_...)이므로 제외.
      const tbody = document.getElementById(`${gridId}_body_tbody`);
      if (!tbody) return data;

      const trs = tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
      trs.forEach((tr) => {
        const rowData = {};
        const tds = Array.from(tr.querySelectorAll("td")).filter(
          (td) => !(td.id || "").startsWith("_headerRowNumber_")
        );
        tds.forEach((td, idx) => {
          const name = headOrder[idx] || `col_${idx}`;
          const link = td.querySelector("a");
          const span = td.querySelector("span.w2grid_span");
          let text = "";
          if (link && link.textContent.trim()) text = link.textContent.trim();
          else if (span) text = span.textContent.trim();
          else text = (td.textContent || "").trim();
          rowData[name] = text;
        });
        if (headOrder.length === 0 && data.columns.length === 0) {
          data.columns = Object.keys(rowData);
        }
        const hasData = Object.values(rowData).some((v) => v && v.length > 0);
        if (hasData) data.rows.push(rowData);
      });

      // ── 총 건수 추출 — 고정 id가 아니라 id$="listCnt" 패턴을 쓴다 ──
      const cntEls = document.querySelectorAll('[id$="listCnt"], #spn_listCnt');
      for (const el of cntEls) {
        const m = (el.textContent || "").match(/[\d,]+/);
        if (m) { data.totalCount = parseInt(m[0].replace(/,/g, "")); break; }
      }
      if (!data.totalCount) data.totalCount = data.rows.length;

      return data;
    }, GRID_ID_CANDIDATES);
    const GRID_ID = parsed.activeGridId || GRID_ID_CANDIDATES[0];
    const results = parsed;
    if (parsed.activeGridId) {
      console.log(`[KDSIS] 활성 grid id: ${parsed.activeGridId}`);
    }

    // 6) 무한 스크롤 — 추가 데이터 로딩
    //   매 스크롤마다 thead를 다시 읽어서 동적 파싱 — col_id 하드코딩 없음.
    //   MAX_SCROLLS는 안전 상한선일 뿐, 새 행이 안 올라오면 즉시 break 한다.
    //   totalCount 게이트를 두지 않는다 — #spn_listCnt 파싱이 실패해 totalCount가
    //   rows.length로 폴백되면 게이트가 항상 false라 전체 결과가 첫 배치(≈10건)에
    //   갇혔다. 루프 내부의 "새 행 없음" 조기 종료가 진짜 신호.
    // 한 스크롤당 ~1.5s (page.evaluate + waitForTimeout(1500) + 파싱). 25회면
    // ~37s, 총 timeout 85s 의 절반 미만으로 안전. listCnt 로 totalCount 가
    // 알려진 경우 행이 다 차면 즉시 break 하므로 평균 비용은 훨씬 적다.
    // dc2b004 의 5는 totalCount=230 결과를 ~50행에서 자르는 회귀를 만들었음.
    const MAX_SCROLLS = Number(process.env.KDSIS_MAX_SCROLLS || 25);
    if (results.rows.length > 0) {
      console.log(`[KDSIS] 무한 스크롤 시작 (현재 ${results.rows.length}건 / 총 ${results.totalCount}건)`);

      for (let i = 0; i < MAX_SCROLLS; i++) {
        // 그리드 데이터 영역을 맨 아래로 스크롤
        await page.evaluate((gridId) => {
          const dataLayer =
            document.querySelector(`#${gridId}_dataLayer`) ||
            document.querySelector(`#${gridId}_body_scroll`) ||
            document.querySelector(`#${gridId}`);
          if (dataLayer) dataLayer.scrollTop = dataLayer.scrollHeight;
        }, GRID_ID);

        await page.waitForTimeout(1500);

        // 추가된 행만 파싱 (prevRowCount부터) — td 순서 기반 매칭
        const moreResults = await page.evaluate(
          ({ gridId, prevRowCount }) => {
            const thead =
              document.querySelector(`#${gridId}_header_thead`) ||
              document.querySelector(`#${gridId} thead`);
            const columnNames = [];
            if (thead) {
              // Same colspan expansion as the initial parse — group headers
              // (colspan > 1) must become name(1)/name(2)/... so td index
              // aligns with column name.
              thead.querySelectorAll("th[col_id]").forEach((th) => {
                const name = (th.textContent || "").trim() || th.getAttribute("col_id");
                const colspan = parseInt(th.getAttribute("colspan") || "1", 10);
                if (colspan > 1) {
                  for (let i = 0; i < colspan; i++) columnNames.push(`${name}(${i + 1})`);
                } else {
                  columnNames.push(name);
                }
              });
            }
            const tbody = document.querySelector(`#${gridId}_body_tbody`);
            if (!tbody) return [];
            const allRows = tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
            const newRows = [];
            for (let r = prevRowCount; r < allRows.length; r++) {
              const tr = allRows[r];
              const rowData = {};
              const tds = Array.from(tr.querySelectorAll("td")).filter(
                (td) => !(td.id || "").startsWith("_headerRowNumber_")
              );
              tds.forEach((td, idx) => {
                const name = columnNames[idx] || `col_${idx}`;
                const link = td.querySelector("a");
                const span = td.querySelector("span.w2grid_span");
                let text = "";
                if (link && link.textContent.trim()) text = link.textContent.trim();
                else if (span) text = span.textContent.trim();
                else text = (td.textContent || "").trim();
                rowData[name] = text;
              });
              if (Object.values(rowData).some((v) => v && v.length > 0)) newRows.push(rowData);
            }
            return newRows;
          },
          { gridId: GRID_ID, prevRowCount: results.rows.length }
        );

        if (moreResults.length === 0) {
          console.log(`[KDSIS] 스크롤 ${i + 1}: 추가 데이터 없음, 중단`);
          break;
        }
        results.rows.push(...moreResults);
        console.log(`[KDSIS] 스크롤 ${i + 1}: +${moreResults.length}건 (누적 ${results.rows.length}건)`);
        // listCnt 가 신뢰가능한 totalCount 를 줬다면 그만큼 차자마자 종료.
        // (totalCount 가 rows.length 로 폴백된 케이스에서는 자명 거짓이라 안전.)
        if (results.totalCount > 0 && results.rows.length >= results.totalCount) {
          console.log(`[KDSIS] 스크롤 종료 (totalCount ${results.totalCount} 충족)`);
          break;
        }
      }
    }

    // 6) 스크린샷 (디버깅용)
    const screenshotPath = path.join(__dirname, "public", "last-search.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });

    console.log(`[KDSIS] 검색 완료: ${results.rows.length}건`);
    return results;
  } catch (error) {
    console.error("[KDSIS] 검색 에러:", error.message);
    // If the shared browser dropped, invalidate the singleton so the next
    // call relaunches a fresh instance.
    if (/disconnect|Target closed|Browser has been closed|has been closed/i.test(error.message || "")) {
      await closeBrowser();
    }
    return { rows: [], columns: [], totalCount: 0, error: error.message };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

// ── 첨부 다운로드 프록시 내부 로직 ─────────────────────────
// openRowDetail: 새 context에서 검색 재현 → 지정 행 상세 팝업 진입.
// extractAttachments: 팝업 프레임을 훑어서 { name, kind, id|href|onclick } 목록 추출.
// triggerDownload: 메타 한 건을 받아 bytes + filename + contentType 반환.
//
// 세 함수 모두 "상태 없는 self-contained" — 세션 쿠키/페이지 캐시를 요청 간
// 공유하지 않는다. 싱글턴 브라우저 + 새 context로 콜드 스타트는 피하면서
// 세션 만료 윈도우도 없앤다.

async function openRowDetail({ params, rowKey }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "ko-KR",
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // Popup URL (popYn=Y) sometimes returns a blank shell when visited
    // without a parent context — setting Referer to the portal nudges KDSIS
    // to render the full form in the popup mode. Harmless if ignored.
    extraHTTPHeaders: { Referer: "https://kdsis.dapa.go.kr/" },
  });
  try {
    const page = await context.newPage();
    await navigateToKdsis(page);

    // KDSIS 차단 페이지 감지 — 본문에 "접근이 거부" / "차단" / 403 표시가 있으면
    // 조기 실패시켜 호출자가 503을 돌려줄 수 있게 한다.
    const blocked = await page.evaluate(() => {
      const t = (document.body?.textContent || "").slice(0, 400);
      return /접근이\s*거부|차단|access\s*denied|forbidden/i.test(t);
    }).catch(() => false);
    if (blocked) {
      recordBlockHit();
      throw new Error("KDSIS_BLOCKED");
    }

    await fillSearchForm(page, params);
    await clickSearchButton(page);
    await waitForGridResult(page);
    await page.waitForTimeout(1000);

    // 지정된 규격번호가 첫 배치에 없으면 grid 를 스크롤해 추가 페이지를 로드.
    // 메인 검색(_runSearchOnce)은 MAX_SCROLLS=10 로 230행 전부 끌어오지만,
    // openRowDetail 은 스크롤이 없어서 예) 230건 중 STD-0008 이 아래쪽에
    // 있으면 못 찾고 ROW_NOT_FOUND 를 던지던 버그가 있었다.
    if (rowKey) {
      const MAX_SCROLLS = Number(process.env.KDSIS_DETAIL_MAX_SCROLLS || 15);
      let prevRowCount = -1;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        const { found, rowCount } = await page.evaluate(
          ({ key, gridIds }) => {
            const gid = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`));
            if (!gid) return { found: false, rowCount: 0 };
            const tbody = document.getElementById(`${gid}_body_tbody`);
            const rows = tbody
              ? tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']")
              : [];
            for (const tr of rows) {
              if ((tr.textContent || "").includes(key)) {
                tr.scrollIntoView({ block: "center" });
                return { found: true, rowCount: rows.length };
              }
            }
            const layer =
              document.getElementById(`${gid}_dataLayer`) ||
              document.getElementById(`${gid}_body_scroll`) ||
              document.getElementById(gid);
            if (layer) layer.scrollTop = layer.scrollHeight;
            return { found: false, rowCount: rows.length };
          },
          { key: rowKey, gridIds: GRID_ID_CANDIDATES }
        );
        if (found) break;
        if (rowCount === prevRowCount) break; // 새 행 없음 = 끝
        prevRowCount = rowCount;
        await page.waitForTimeout(800);
      }
    }

    // 지정 행(규격번호 일치) 클릭. 새 페이지/팝업이 열릴 수 있어 대기.
    const newPagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    const clicked = await page.evaluate(({ key, gridIds }) => {
      const gridId = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`));
      if (!gridId) return false;
      const tbody = document.getElementById(`${gridId}_body_tbody`);
      if (!tbody) return false;
      const rows = tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");

      // KDSIS 상세 popup(viewTchdataOpenP.xml)은 "규격서명" 컬럼의 anchor 만이
      // 트리거한다. 규격번호 컬럼에도 anchor 가 있어서 단순히 첫 <a> 를 누르면
      // 메인 페이지에 머물고 newPageOpened=false 로 끝난다.
      const thead =
        document.getElementById(`${gridId}_header_thead`) ||
        document.querySelector(`#${gridId} thead`);
      let specIdx = -1;
      if (thead) {
        const headers = Array.from(thead.querySelectorAll("th[col_id]"));
        specIdx = headers.findIndex((th) =>
          /규격\s*서명|규격명/.test((th.textContent || "").trim())
        );
      }
      const pickLink = (rowEl) => {
        const tds = Array.from(rowEl.querySelectorAll("td")).filter(
          (td) => !(td.id || "").startsWith("_headerRowNumber_")
        );
        const targetCell = specIdx >= 0 ? tds[specIdx] : null;
        return (
          (targetCell && targetCell.querySelector("a")) ||
          rowEl.querySelector("td a, span.w2grid_span a") ||
          null
        );
      };

      for (const tr of rows) {
        const text = tr.textContent || "";
        if (key && text.includes(key)) {
          const link = pickLink(tr);
          if (link) { link.click(); return true; }
          const tds = tr.querySelectorAll("td");
          if (tds[3]) { tds[3].click(); return true; }
        }
      }
      // key가 명시됐는데 매칭 행이 없으면 실패시킴 — 첫 행 폴백은 잘못된
      // 상세 팝업을 열어 사용자를 혼동시킨다(STD-0008 요청했는데 STD-0001
      // 열림). key 없을 때(디버깅/샘플링 경로)만 첫 행 폴백 유지.
      if (!key) {
        const first = rows[0];
        if (first) {
          const link = pickLink(first);
          if (link) { link.click(); return "fallback_first"; }
        }
      }
      return false;
    }, { key: rowKey, gridIds: GRID_ID_CANDIDATES });
    if (!clicked) {
      // ROW_NOT_FOUND 원인 파악용 진단 스냅샷 — grid가 비어있었는지 / 행은
      // 있는데 key가 안 맞았는지 구별해야 고칠 수 있다.
      const snap = await page.evaluate((gridIds) => {
        const gid = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`));
        const tbody = gid ? document.getElementById(`${gid}_body_tbody`) : null;
        const rows = tbody
          ? tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']")
          : [];
        const firstRowTexts = Array.from(rows)
          .slice(0, 5)
          .map((tr) => (tr.textContent || "").trim().slice(0, 200));
        const cntEls = document.querySelectorAll('[id$="listCnt"], #spn_listCnt');
        const cntTxts = Array.from(cntEls).map((el) => (el.textContent || "").trim()).slice(0, 3);
        return {
          activeGridId: gid || null,
          rowCount: rows.length,
          firstRowTexts,
          countElTexts: cntTxts,
          bodyLen: (document.body?.textContent || "").length,
        };
      }, GRID_ID_CANDIDATES).catch(() => null);
      const err = new Error("ROW_NOT_FOUND");
      err.diagnostics = snap;
      throw err;
    }

    const newPage = await newPagePromise;
    const target = newPage || page;
    if (newPage) {
      await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await newPage.waitForTimeout(1500);
    } else {
      await page.waitForTimeout(1500);
    }
    return { context, page: target, rowMatch: clicked };
  } catch (e) {
    try { await context.close(); } catch {}
    throw e;
  }
}

// openRowDetail 래퍼: 메인 검색 경로(_runSearch)와 동일하게 transient 에러에
// 한해 한 번 재시도한다. ROW_NOT_FOUND / KDSIS_BLOCKED 는 사실관계 에러이므로
// 재시도 가치가 없어 즉시 전달. Download pool 슬롯을 추가로 점유하지 않도록
// 호출은 pool 내부에서 하고, 재시도도 같은 슬롯 안에서 순차 실행한다.
const DETAIL_RETRIES = 1;
async function openRowDetailWithRetry({ params, rowKey }) {
  let lastErr;
  for (let attempt = 0; attempt <= DETAIL_RETRIES; attempt++) {
    try {
      return await openRowDetail({ params, rowKey });
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      if (msg === "ROW_NOT_FOUND" || msg === "KDSIS_BLOCKED") throw err;
      if (attempt >= DETAIL_RETRIES) throw err;
      if (!(isTransient(msg) || msg === "KDSIS_FORM_NOT_READY")) throw err;
      console.warn(`[detail-retry ${attempt + 1}/${DETAIL_RETRIES}] ${msg}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

// 상세 페이지(+ 서브프레임)에서 첨부 후보를 긁어온다. 반환 형태:
//   { name, kind: "direct"|"js", id, href?, onclick?, frameUrl }
// 직링크(A/B)와 JS 트리거(C)를 모두 수용. UI는 kind 무관하게 같은 URL을 쓰고,
// triggerDownload가 kind별로 갈라진다.
// NOTE: 예전엔 <a> 태그만 스캔했다가 KDSIS 상세 팝업이 <button>/<span
// onclick=>/<li data-*> 으로 첨부를 렌더하는 화면에서 전부 0건으로 나오는
// 이슈가 있었다. 이제는 클릭 가능한 모든 요소 + 파일 확장자가 포함된 요소를
// 넓게 스캔하고 탐지 근거(matched)를 함께 저장해 디버깅 가능하게 한다.
async function extractAttachments(page, opts = {}) {
  const seen = new Map();
  const out = [];
  const FILE_EXT_RE = /\.(pdf|hwp|hwpx|doc|docx|xls|xlsx|ppt|pptx|zip|txt|xml|jpg|jpeg|png|gif)$/i;
  const FILE_EXT_INLINE_RE = /\.(pdf|hwp|hwpx|doc|docx|xls|xlsx|ppt|pptx|zip|txt|xml|jpg|jpeg|png|gif)\b/i;
  const DOWNLOAD_KW_RE = /download|filedown|fn_download|fndownload|filednwld|openfile|goFile|다운로드|첨부/i;
  const ATTACH_CONTEXT_RE = /첨부|파일\s*목록|file.*list|attach/i;

  for (const frame of page.frames()) {
    const batch = await frame
      .evaluate(
        ({ FILE_EXT_SRC, FILE_EXT_INLINE_SRC, DOWNLOAD_KW_SRC, CTX_SRC }) => {
          const FILE_EXT = new RegExp(FILE_EXT_SRC, "i");
          const FILE_EXT_INLINE = new RegExp(FILE_EXT_INLINE_SRC, "i");
          const DOWNLOAD_KW = new RegExp(DOWNLOAD_KW_SRC, "i");
          const CTX_RE = new RegExp(CTX_SRC, "i");

          // Step 1 — "첨부파일" 섹션 root 후보를 찾아서 그 scope 안을 우선적으로
          // 훑는다. root를 못 찾으면 body 전체를 scope로 사용.
          let scope = null;
          const allEls = document.querySelectorAll("*");
          for (const el of allEls) {
            const direct = Array.from(el.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent)
              .join("")
              .trim();
            if (direct && CTX_RE.test(direct) && el.children.length < 8) {
              // 이 요소가 "첨부파일" 라벨이면 그 부모(2~3단 위)를 scope로
              let s = el.parentElement || el;
              for (let i = 0; i < 3 && s.parentElement; i++) s = s.parentElement;
              scope = s;
              break;
            }
          }
          const root = scope || document;

          const hits = [];
          const tags = "a, button, span, li, tr, div, input";
          root.querySelectorAll(tags).forEach((el, idx) => {
            const tag = el.tagName.toLowerCase();
            const href = el.getAttribute("href") || "";
            const onclick = el.getAttribute("onclick") || "";
            const val = el.getAttribute("value") || "";
            const text = (el.textContent || "").trim();
            const dataAttrs = Array.from(el.attributes || [])
              .filter((a) => a.name.startsWith("data-"))
              .map((a) => `${a.name}=${a.value}`)
              .join(" ");

            const reasons = [];
            if (FILE_EXT.test(href)) reasons.push("href-ext");
            if (FILE_EXT_INLINE.test(text)) reasons.push("text-ext");
            if (FILE_EXT_INLINE.test(val)) reasons.push("val-ext");
            if (FILE_EXT_INLINE.test(dataAttrs)) reasons.push("data-ext");
            if (onclick && DOWNLOAD_KW.test(onclick)) reasons.push("onclick-dl");
            if (href && /^javascript:/.test(href) && DOWNLOAD_KW.test(href)) reasons.push("href-js-dl");
            // scope 안에서 클릭 가능한 버튼/링크는 일단 후보로 (너무 넓으면
            // dedup/텍스트 체크로 걸러짐)
            if (
              scope &&
              (tag === "a" || tag === "button" || (tag === "input" && /button|submit/i.test(el.type || ""))) &&
              text.length > 0 &&
              text.length < 120
            ) {
              reasons.push("scope-clickable");
            }
            if (reasons.length === 0) return;
            if (!text && !val && !href) return;

            const name = (text || val || href).slice(0, 200);
            const isDirectHref = href && !/^javascript:|^#$/.test(href);
            hits.push({
              tag,
              kind: isDirectHref ? "direct" : "js",
              name,
              href: href.slice(0, 1000),
              onclick: onclick.slice(0, 500),
              val: val.slice(0, 200),
              matched: reasons,
              idx,
            });
          });
          return { hits, scopeFound: !!scope };
        },
        {
          FILE_EXT_SRC: FILE_EXT_RE.source,
          FILE_EXT_INLINE_SRC: FILE_EXT_INLINE_RE.source,
          DOWNLOAD_KW_SRC: DOWNLOAD_KW_RE.source,
          CTX_SRC: ATTACH_CONTEXT_RE.source,
        }
      )
      .catch(() => ({ hits: [] }));

    for (const b of batch.hits) {
      const id = `${b.kind}|${b.name}|${b.href}|${b.onclick}|${b.val}`;
      if (seen.has(id)) continue;
      // "scope-clickable" 만 걸린 것 중 "닫기", "취소", "검색" 같은 명백한
      // non-첨부 버튼은 이름으로 배제.
      if (
        b.matched.length === 1 &&
        b.matched[0] === "scope-clickable" &&
        /^(닫기|확인|취소|검색|목록|뒤로|이전|다음|엑셀다운로드|복사|초기화)$/.test(b.name.trim())
      ) {
        continue;
      }
      seen.set(id, true);
      out.push({
        id: String(out.length),
        name: b.name,
        kind: b.kind,
        tag: b.tag,
        href: b.href || null,
        onclick: b.onclick || null,
        val: b.val || null,
        matched: b.matched,
        frameUrl: frame.url().slice(0, 200),
      });
    }
  }

  // 직접 디버깅용으로 상세 페이지 전체 HTML + 스크린샷 저장. 다음 호출에
  // 덮어쓰기 때문에 가장 최근의 detail 페이지를 언제든 /api/debug/last-detail
  // 로 브라우저에서 바로 볼 수 있다. extractAttachments가 0건을 반환했을 때
  // "진짜로 첨부가 없는지" vs "셀렉터가 놓친 건지" 육안으로 즉시 확인 가능.
  let savedHtml = null;
  try {
    const html = await page.content();
    savedHtml = html;
    const htmlPath = path.join(__dirname, "public", "last-detail.html");
    await fs.promises.writeFile(htmlPath, html, "utf8");
    console.log(`[detail] HTML 저장: ${htmlPath} (${html.length} bytes)`);
    await page
      .screenshot({
        path: path.join(__dirname, "public", "last-detail.png"),
        fullPage: true,
      })
      .then(() => console.log("[detail] 스크린샷 저장 완료"))
      .catch((e) => console.warn("[detail] 스크린샷 실패:", e.message));
  } catch (err) {
    console.warn("[detail] HTML 저장 실패:", err.message);
  }

  // opts.includeHtml 가 true 면 추출 결과와 함께 페이지 HTML(앞 60KB) 도 동봉.
  // 파일시스템 우회용 — 사용자가 응답 JSON 만으로 KDSIS 상세 페이지 실물을
  // 확인할 수 있다.
  if (opts.includeHtml && savedHtml) {
    return { attachments: out, html: savedHtml.slice(0, 60_000) };
  }
  return out;
}

// Returns { buffer, filename, contentType } for a single attachment descriptor.
// Uses page.on('download') so both JS-triggered and direct-link clicks funnel
// through the same Playwright download pipeline — no need for a separate
// fetch() path.
async function triggerDownload(page, attachment) {
  // extractAttachments 가 a/button/span/li/input 등 다양한 태그를 반환하므로
  // 여기서도 같은 태그 집합을 훑으며 이름+href+onclick 지문으로 매칭한다.
  const TAGS = "a, button, span, li, tr, div, input";
  for (const frame of page.frames()) {
    const ok = await frame.evaluate((meta) => {
      const els = document.querySelectorAll("a, button, span, li, tr, div, input");
      for (const el of els) {
        const href = el.getAttribute("href") || "";
        const onclick = el.getAttribute("onclick") || "";
        const val = el.getAttribute("value") || "";
        const text = (el.textContent || "").trim();
        const name = (text || val || href).slice(0, 200);
        if (name === meta.name && href === (meta.href || "") && onclick === (meta.onclick || "")) {
          el.scrollIntoView({ block: "center" });
          return true;
        }
      }
      return false;
    }, attachment).catch(() => false);
    if (!ok) continue;

    const downloadPromise = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
    await frame.evaluate((meta) => {
      const els = document.querySelectorAll("a, button, span, li, tr, div, input");
      for (const el of els) {
        const text = (el.textContent || "").trim();
        const val = el.getAttribute("value") || "";
        const name = (text || val || el.getAttribute("href") || "").slice(0, 200);
        if (name === meta.name) { el.click(); return; }
      }
    }, attachment).catch(() => {});
    const dl = await downloadPromise;
    if (dl) {
      const stream = await dl.createReadStream();
      const chunks = [];
      await new Promise((resolve, reject) => {
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      const buffer = Buffer.concat(chunks);
      return {
        buffer,
        filename: dl.suggestedFilename() || attachment.name,
        contentType: "application/octet-stream",
      };
    }
    // JS click이 새 탭 navigation으로 끝나는 사이트도 있음 — 현재 URL이 파일이면 스트림
    break;
  }
  throw new Error("DOWNLOAD_FAILED");
}

// ── 진단 모드: 페이지 내부 상태 전부 덤프 ─────────────────
// 목적: "왜 결과가 0건인가"를 원인별로 분리해서 판정
//   1) 폼 입력이 실제로 반영됐는가 (dropdown 선택 포함)
//   2) 검색 버튼이 실제로 클릭됐는가 (어떤 셀렉터가 매칭됐는가)
//   3) 검색 후 페이지에 결과가 있는가 (DOM 스캔)
//   4) 카운트/tbody 셀렉터가 실제 DOM과 일치하는가
async function diagnosticSearch(params) {
  let context;
  const consoleErrors = [];
  const diag = {
    params,
    pageLoaded: false,
    currentUrl: null,
    fieldFillResults: {},
    formValuesAfterFill: {},
    searchButtonTried: [],
    searchButtonClicked: null,
    searchButtonCandidates: [],
    countElements: [],
    specificIds: {},
    tbodyCandidates: [],
    gridTbodyFound: false,
    gridRowCount: 0,
    gridFirstRowHtml: null,
    consoleErrors,
    screenshotUrl: "/api/screenshot?t=" + Date.now(),
    error: null,
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      locale: "ko-KR",
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text());
    });

    await page.goto(KDSIS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    diag.pageLoaded = true;
    diag.currentUrl = page.url();

    // 1) 폼 입력 + 입력 결과 검증
    for (const [fieldName, value] of Object.entries(params)) {
      const config = FIELD_MAP[fieldName];
      if (!config) {
        diag.fieldFillResults[fieldName] = { error: "unknown field in FIELD_MAP" };
        continue;
      }
      const sel = `#${config.id}`;
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        if (config.type === "text") {
          await page.fill(sel, "");
          await page.fill(sel, value);
          await page.dispatchEvent(sel, "change");
        } else {
          await page.selectOption(sel, { label: value });
          await page.dispatchEvent(sel, "change");
        }
        const actual = await page.$eval(sel, (el) => el.value);
        diag.fieldFillResults[fieldName] = {
          requested: value,
          actualValue: actual,
          ok: actual && actual.length > 0,
        };
      } catch (err) {
        diag.fieldFillResults[fieldName] = { requested: value, error: err.message };
      }
    }

    // 2) 채워진 폼 전체 상태 스냅샷
    diag.formValuesAfterFill = await page.evaluate(() => {
      const ids = [
        "gee_stdrdKndCd_input_0", "gee_specno", "gee_nsn", "gee_relNsn",
        "gee_dtaNm", "gee_cmpntsMgtno", "gee_enactOrganCd_input_0",
        "gee_aplyEqpNm", "gee_drwgno", "stdrdStateCd_input_0",
      ];
      const r = {};
      ids.forEach((id) => {
        const el = document.getElementById(id);
        r[id] = el ? (el.value ?? "(no value attr)") : "(no element)";
      });
      return r;
    });

    // 3) 검색 버튼 후보 전체 스캔 (클릭 전)
    diag.searchButtonCandidates = await page.evaluate(() => {
      const cands = document.querySelectorAll(
        'button, input[type="button"], input[type="submit"], a, [role="button"]'
      );
      const matches = [];
      cands.forEach((el) => {
        const txt = (el.textContent || el.value || "").trim();
        const id = el.id || "";
        if (txt === "검색" || (txt.includes("검색") && txt.length < 20) || /search/i.test(id)) {
          matches.push({
            tag: el.tagName,
            id: id || null,
            class: (el.className || "").slice(0, 80) || null,
            text: txt.slice(0, 30),
          });
        }
      });
      return matches.slice(0, 20);
    });

    // 4) 검색 버튼 클릭 — 메인 경로와 동일한 헬퍼 사용
    try {
      const res = await clickSearchButton(page);
      diag.searchButtonTried = res.tried;
      diag.searchButtonClicked = res.clicked;
    } catch (e) {
      diag.searchButtonTried = e.tried || [];
      diag.searchButtonClicked = null;
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    // 그리드 행이 실제로 나타날 때까지 대기 (searchKDSIS와 동일 정책)
    await page.waitForFunction(
      (gridIds) => {
        for (const gid of gridIds) {
          const tb = document.getElementById(`${gid}_body_tbody`);
          if (tb) {
            const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
            if (rows.length > 0) return true;
          }
        }
        const cntEls = document.querySelectorAll('[id$="listCnt"], #spn_listCnt');
        for (const el of cntEls) {
          const txt = (el.textContent || "").trim();
          if (/^0건?$/.test(txt) || txt === "0") return true;
        }
        return false;
      },
      GRID_ID_CANDIDATES,
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(500);

    // 5) 결과 후 스크린샷
    await page.screenshot({
      path: path.join(__dirname, "public", "last-search.png"),
      fullPage: true,
    });

    // 6) 페이지 전체에서 "N건" 패턴을 가진 요소 전부 찾기 → 진짜 카운트 위치 식별
    const scan = await page.evaluate(() => {
      const result = {
        countElements: [],
        specificIds: {},
        tbodyCandidates: [],
      };

      // "N건" 포함 텍스트 요소 전부 수집
      const seen = new Set();
      const all = document.querySelectorAll("*");
      all.forEach((el) => {
        const direct = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join("")
          .trim();
        if (direct && /\d[\d,]*\s*건/.test(direct) && !seen.has(direct + "|" + el.id)) {
          seen.add(direct + "|" + el.id);
          result.countElements.push({
            tag: el.tagName,
            id: el.id || null,
            class: (el.className || "").slice(0, 60) || null,
            text: direct.slice(0, 100),
          });
        }
      });

      // 실제 코드가 사용하는 ID 검증
      [
        "spn_listCnt",
        "ggr_stndList_body_tbody",
        "ggr_stndList_header_thead",
        "ggr_stndList_dataLayer",
        "ggr_stndList",
      ].forEach((id) => {
        const el = document.getElementById(id);
        result.specificIds[id] = el
          ? { found: true, text: (el.textContent || "").slice(0, 200) }
          : { found: false };
      });

      // tbody 후보 전체
      document.querySelectorAll("tbody").forEach((tb) => {
        if (tb.id || tb.querySelectorAll("tr").length > 0) {
          result.tbodyCandidates.push({
            id: tb.id || null,
            class: (tb.className || "").slice(0, 60) || null,
            rowCount: tb.querySelectorAll("tr").length,
            firstRowClass: tb.querySelector("tr")?.className?.slice(0, 60) || null,
          });
        }
      });

      return result;
    });
    diag.countElements = scan.countElements;
    diag.specificIds = scan.specificIds;
    diag.tbodyCandidates = scan.tbodyCandidates;

    // 7) 실제 사용 tbody 상세 + thead 칼럼 구조 확인
    const tbodyInfo = await page.evaluate((gridIds) => {
      const gridId = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`)) || gridIds[0];
      const tb = document.getElementById(`${gridId}_body_tbody`);
      const thead =
        document.getElementById(`${gridId}_header_thead`) ||
        document.querySelector(`#${gridId} thead`);
      const columns = [];
      if (thead) {
        thead.querySelectorAll("th[col_id]").forEach((th) => {
          columns.push({
            colId: th.getAttribute("col_id"),
            name: (th.textContent || "").trim(),
          });
        });
      }
      if (!tb) return { found: false, activeGridId: gridId, columns };
      const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
      return {
        found: true,
        activeGridId: gridId,
        rowCount: rows.length,
        columns,
        firstRowHtml: rows[0]?.outerHTML.slice(0, 2500) || null,
      };
    }, GRID_ID_CANDIDATES);
    diag.gridTbodyFound = tbodyInfo.found;
    diag.gridActiveId = tbodyInfo.activeGridId || null;
    diag.gridRowCount = tbodyInfo.rowCount || 0;
    diag.gridColumns = tbodyInfo.columns || [];
    diag.gridFirstRowHtml = tbodyInfo.firstRowHtml;

    diag.currentUrl = page.url();
  } catch (err) {
    diag.error = err.message;
    if (/disconnect|Target closed|Browser has been closed|has been closed/i.test(err.message || "")) {
      await closeBrowser();
    }
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }

  return diag;
}

// ── 검색 결과 → 챗봇 응답 포맷 ──────────────────────────
function formatResultsForChat(params, results) {
  const searchDesc = Object.entries(params)
    .map(([k, v]) => `${k}: "${v}"`)
    .join(", ");

  if (results.error) {
    return {
      message: `검색 중 오류가 발생했습니다: ${results.error}`,
      type: "error",
    };
  }

  if (results.rows.length === 0) {
    return {
      message: `조건 [${searchDesc}]으로 검색했으나 결과가 없습니다. 다른 키워드로 시도해 보세요.`,
      type: "empty",
      searchParams: params,
    };
  }

  return {
    message: `[${searchDesc}] 검색 결과 ${results.totalCount || results.rows.length}건을 찾았습니다.`,
    type: "success",
    searchParams: params,
    columns: results.columns,
    rows: results.rows,
    totalCount: results.totalCount || results.rows.length,
  };
}

// ── API 엔드포인트 ───────────────────────────────────────

// POST /api/search — 자연어 검색
app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "query 파라미터가 필요합니다." });
  }

  try {
    console.log(`\n${"═".repeat(50)}`);
    console.log(`[요청] "${query}"`);

    // 1) 자연어 → 검색 파라미터 (AI 또는 규칙 기반)
    const params = await parseQuery(query);
    console.log("[파싱]", params);

    if (Object.keys(params).length === 0) {
      return res.json({
        message: "검색 조건을 파악할 수 없습니다. 규격번호, 장비명, 부품명 등을 포함해 주세요.",
        type: "empty",
        searchParams: {},
      });
    }

    // 2) KDSIS 자동 검색
    const results = await searchKDSIS(params);

    // 3) 응답 포맷
    const response = formatResultsForChat(params, results);
    console.log(`[결과] ${response.type}: ${response.rows?.length || 0}건`);
    console.log("═".repeat(50));

    res.json(response);
  } catch (err) {
    console.error("[/api/search] 처리 중 에러:", err);
    res.status(500).json({
      type: "error",
      message: "서버 내부 에러: " + (err.message || String(err)),
      detail: err.stack || String(err),
    });
  }
});

// POST /api/search/direct — 필드 직접 지정 검색
app.post("/api/search/direct", async (req, res) => {
  const { params } = req.body;
  if (!params || typeof params !== "object") {
    return res.status(400).json({ error: "params 객체가 필요합니다." });
  }

  try {
    console.log(`\n[직접 검색]`, params);
    const results = await searchKDSIS(params);
    const response = formatResultsForChat(params, results);
    res.json(response);
  } catch (err) {
    console.error("[/api/search/direct] 처리 중 에러:", err);
    res.status(500).json({
      type: "error",
      message: "서버 내부 에러: " + (err.message || String(err)),
      detail: err.stack || String(err),
    });
  }
});

// POST /api/search/batch — 여러 쿼리를 NDJSON 스트리밍으로 동시 실행.
// 동시성 상한은 KDSIS_SEARCH_CONCURRENCY(기본 1). 각 쿼리는 기존 searchKDSIS
// 경로(캐시 + in-flight dedup)를 그대로 타서 중복 쿼리는 비용 0. 응답은
// 한 줄에 하나의 JSON 이벤트:
//   {type:"queued", id, query?, params?}
//   {type:"started", id}
//   {type:"result", id, query, params, ...formatResultsForChat output}
//   {type:"error",  id, query, message, detail?}
//   {type:"done"}
// 클라는 response.body.getReader()로 라인 단위로 읽어 카드 UI에 얹으면 됨.
app.post("/api/search/batch", async (req, res) => {
  const { queries } = req.body || {};
  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: "queries 배열이 필요합니다." });
  }
  const MAX_BATCH = Math.max(1, Number(process.env.KDSIS_BATCH_MAX || 20));
  if (queries.length > MAX_BATCH) {
    return res
      .status(400)
      .json({ error: `쿼리는 한 번에 최대 ${MAX_BATCH}개까지 가능합니다.` });
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // Cloudflare/Nginx proxy 버퍼 off
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const write = (obj) => {
    res.write(JSON.stringify(obj) + "\n");
  };

  // 순서·중복을 유지하도록 id를 배열 인덱스로 부여. 클라가 q.id 지정하면 우선.
  const normalized = queries.map((q, i) => {
    const id = q && q.id != null ? q.id : i;
    const query = typeof q?.query === "string" ? q.query.trim() : "";
    const params = q?.params && typeof q.params === "object" ? q.params : null;
    return { id, query, params };
  });

  for (const q of normalized) write({ type: "queued", id: q.id, query: q.query, params: q.params });

  const tasks = normalized.map((q) =>
    (async () => {
      write({ type: "started", id: q.id });
      try {
        let params = q.params;
        if (!params && q.query) params = await parseQuery(q.query);
        params = params || {};
        if (Object.keys(params).length === 0) {
          write({
            type: "result",
            id: q.id,
            query: q.query,
            params,
            type_hint: "empty_params",
            message: "검색 조건을 파악할 수 없습니다.",
            rows: [],
            totalCount: 0,
          });
          return;
        }
        const results = await searchKDSIS(params);
        const response = formatResultsForChat(params, results);
        write({ type: "result", id: q.id, query: q.query, params, ...response });
      } catch (err) {
        console.error(`[/api/search/batch] id=${q.id} 실패:`, err.message);
        write({
          type: "error",
          id: q.id,
          query: q.query,
          message: err.message || String(err),
          detail: err.stack || null,
        });
      }
    })()
  );

  await Promise.allSettled(tasks);
  write({ type: "done" });
  res.end();
});

// GET /api/debug/last-detail — extractAttachments 가 마지막으로 저장한
// 상세 페이지 HTML 을 직접 서빙. express.static 캐싱/라우팅에 영향받지
// 않도록 fs 로 읽어 그대로 반환. ?as=png 으로 스크린샷도.
app.get("/api/debug/last-detail", async (req, res) => {
  const ext = req.query.as === "png" ? "png" : "html";
  const file = path.join(__dirname, "public", `last-detail.${ext}`);
  try {
    const stat = await fs.promises.stat(file);
    res.setHeader("Content-Type", ext === "png" ? "image/png" : "text/html; charset=utf-8");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("X-Last-Detail-Mtime", stat.mtime.toISOString());
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.status(404).json({
      error: `last-detail.${ext} 가 아직 없습니다 (/api/detail 호출 후 생성됨).`,
      detail: err.message,
      path: file,
    });
  }
});

// GET /api/debug/detail-page — KDSIS 상세 페이지 HTML 을 그대로 브라우저에
// 렌더한다. /api/detail 이 첨부 0건만 돌려줄 때 "진짜 첨부가 없는지" 시각
// 확인하려고 만든 가장 단순한 출구. 같은 params/key 를 받아 즉석에서 detail
// 페이지를 열고 page.content() 결과를 text/html 로 응답. 캐시·파일시스템
// 우회. JSON 파싱 없이 브라우저로 한 번에 확인 가능.
app.get("/api/debug/detail-page", async (req, res) => {
  const params = _parseParamsQuery(req.query.params);
  const rowKey = typeof req.query.key === "string" ? req.query.key : "";
  if (!params || !rowKey) {
    return res.status(400).json({ error: "params(JSON)과 key(문자열) 필요" });
  }
  let context;
  try {
    const result = await downloadPool.run(async () => {
      const r = await openRowDetailWithRetry({ params, rowKey });
      context = r.context;
      const html = await r.page.content();
      return html;
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // KDSIS 도메인 절대경로 자원이 우리 origin 으로 잘못 가지 않도록 base
    // 를 박는다. <base> 가 없으면 popup 페이지 안의 상대 경로 이미지/JS 가
    // 브라우저에서 깨져 보일 수 있다.
    const withBase = result.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="https://kdsis.dapa.go.kr/">`
    );
    res.send(withBase);
  } catch (err) {
    res
      .status(500)
      .send(
        `<pre>detail-page 실패: ${err.message}\n${err.stack || ""}</pre>`
      );
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
});

// GET /api/debug/raw — Playwright를 거치지 않고 node https로 KDSIS를 직접 호출.
// 목적: Render 서버 IP → KDSIS 네트워크 레이어만 격리해서 본다 (IP 차단 판별).
// 쉘 접근이 없어도 브라우저 주소창에서 바로 결과를 얻을 수 있도록 JSON으로 반환.
app.get("/api/debug/raw", async (req, res) => {
  const target = typeof req.query.url === "string" && req.query.url.startsWith("http")
    ? req.query.url
    : KDSIS_URL;
  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
  const started = Date.now();

  const result = await new Promise((resolve) => {
    try {
      const u = new URL(target);
      const req2 = https.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          headers: {
            "User-Agent": ua,
            Referer: "https://kdsis.dapa.go.kr/",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          },
          timeout: 15000,
        },
        (r) => {
          const chunks = [];
          let size = 0;
          r.on("data", (c) => {
            chunks.push(c);
            size += c.length;
            if (size > 200_000) r.destroy(); // bodyPreview로 쓸 선두만 있으면 됨
          });
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: true,
              httpStatus: r.statusCode,
              statusMessage: r.statusMessage,
              headers: r.headers,
              sizeSampled: size,
              bodyPreview: body.slice(0, 500),
              bodyLooksEmpty: body.trim().length < 30,
              elapsedMs: Date.now() - started,
            });
          });
          r.on("error", (err) =>
            resolve({ ok: false, stage: "response", error: String(err), elapsedMs: Date.now() - started })
          );
        }
      );
      req2.on("timeout", () => {
        req2.destroy();
        resolve({ ok: false, stage: "timeout", elapsedMs: Date.now() - started });
      });
      req2.on("error", (err) =>
        resolve({ ok: false, stage: "request", error: String(err), elapsedMs: Date.now() - started })
      );
      req2.end();
    } catch (err) {
      resolve({ ok: false, stage: "setup", error: String(err) });
    }
  });

  res.json({ target, userAgent: ua, ...result });
});

// GET /api/debug/mini — 시간 제한된 Playwright 진단.
// /api/debug/raw(순수 https)는 200 OK + 정상 HTML 셸을 받는데, Playwright
// 경로는 "비어있는 body"로 BLOCKED를 내는 상황 분리용. Playwright가 KDSIS를
// 여는 동안의 console 에러/실패 request/최종 DOM을 ~25초 안에 수집해
// Cloudflare 100초 게이트웨이 전에 무조건 응답한다.
app.get("/api/debug/mini", async (req, res) => {
  const warmup = req.query.warmup !== "0"; // ?warmup=0 로 warmup 비활성 A/B
  const overallBudgetMs = 25_000;
  const started = Date.now();
  let context;
  const consoleErrors = [];
  const failedRequests = [];
  let navError = null;
  let domState = null;

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms)
      ),
    ]);

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      locale: "ko-KR",
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      extraHTTPHeaders: { Referer: "https://kdsis.dapa.go.kr/" },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        if (consoleErrors.length < 30) {
          consoleErrors.push({ type: msg.type(), text: msg.text().slice(0, 300) });
        }
      }
    });
    page.on("requestfailed", (req2) => {
      if (failedRequests.length < 30) {
        failedRequests.push({
          url: req2.url().slice(0, 300),
          method: req2.method(),
          failure: req2.failure()?.errorText || null,
          resourceType: req2.resourceType(),
        });
      }
    });

    try {
      await withTimeout(navigateToKdsis(page, { warmup }), overallBudgetMs - 3000, "NAVIGATE");
    } catch (err) {
      navError = {
        message: err.message,
        diagnostics: err.diagnostics || null,
      };
    }

    domState = await page
      .evaluate(
        (fieldIds) => {
          const btnIds = [];
          document.querySelectorAll('[id^="btn_"], [id*="earch"]').forEach((el) => {
            if (el.id && btnIds.length < 30) btnIds.push(el.id);
          });
          return {
            url: location.href,
            title: document.title,
            bodyLen: (document.body?.textContent || "").length,
            bodyPreview: (document.body?.textContent || "").slice(0, 500),
            htmlPreview: (document.documentElement?.outerHTML || "").slice(0, 800),
            btnIds,
            fieldsPresent: fieldIds.filter((id) => !!document.getElementById(id)).length,
            fieldsTotal: fieldIds.length,
            iframes: document.querySelectorAll("iframe").length,
            scripts: document.querySelectorAll("script").length,
            readyState: document.readyState,
          };
        },
        Object.values(FIELD_MAP).map((c) => c.id)
      )
      .catch((e) => ({ error: "evaluate_failed: " + e.message }));
  } catch (err) {
    navError = navError || { message: err.message, stage: "setup" };
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
  }

  res.json({
    warmup,
    elapsedMs: Date.now() - started,
    navError,
    consoleErrors,
    failedRequests,
    domState,
  });
});

// GET/POST /api/debug — 진단 모드 (내부 상태 전부 덤프)
//   GET:  기본 테스트 쿼리 (규격상태=활성)로 자동 실행
//   POST: { params: {...} } 로 커스텀 쿼리 지정 가능
app.all("/api/debug", async (req, res) => {
  const params =
    req.method === "POST" && req.body?.params && typeof req.body.params === "object"
      ? req.body.params
      : { 규격상태: "활성" };

  console.log(`\n[진단] 시작:`, params);
  const diag = await diagnosticSearch(params);
  console.log(`[진단] 완료. tbody=${diag.gridTbodyFound} rows=${diag.gridRowCount} btn=${diag.searchButtonClicked}`);
  res.json(diag);
});

// GET/POST /api/debug/detail — 첫 검색 결과의 상세 팝업 구조 덤프
//   목적: 첨부파일이 어떤 DOM 요소로 렌더되는지 확인 (직링크/JS/버튼 등)
//   POST body: { params: {...} } / GET query: ?params=<JSON 문자열>&key=<규격번호>
app.all("/api/debug/detail", async (req, res) => {
  // POST body 우선, 없으면 GET query 에서 params 를 JSON 파싱.
  let params = null;
  if (req.body?.params && typeof req.body.params === "object") {
    params = req.body.params;
  } else if (typeof req.query.params === "string") {
    try { params = JSON.parse(req.query.params); } catch {}
  }
  params = params && typeof params === "object" ? params : { 규격상태: "활성" };
  const rowKey = typeof req.query.key === "string" ? req.query.key : null;

  let context;
  const diag = {
    params,
    searchOk: false,
    rowClicked: false,
    newPageOpened: false,
    popupUrl: null,
    frames: [],
    attachmentCandidates: [],
    attachmentSectionHtml: null,
    allAnchors: [],
    onclickHandlers: [],
    error: null,
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      locale: "ko-KR",
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // 메인 검색 경로와 동일하게 portal warmup + HTTP status 체크가 포함된
    // navigateToKdsis 헬퍼를 쓴다. 직접 goto 만 쓰면 KDSIS 가 popup URL 로 바로
    // 들어오는 요청에 빈 셸을 줘서 page.goto 가 30s 타임아웃을 맞는 경우가 있다.
    await navigateToKdsis(page);

    // 검색 실행
    for (const [fieldName, value] of Object.entries(params)) {
      const config = FIELD_MAP[fieldName];
      if (!config) continue;
      const sel = `#${config.id}`;
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        if (config.type === "text") {
          await page.fill(sel, value);
        } else {
          await page.selectOption(sel, { label: value });
        }
        await page.dispatchEvent(sel, "change");
      } catch (e) {}
    }
    await clickSearchButton(page);
    await page.waitForFunction(
      (gridIds) => {
        for (const gid of gridIds) {
          const tb = document.getElementById(`${gid}_body_tbody`);
          if (tb) {
            const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
            if (rows.length > 0) return true;
          }
        }
        return false;
      },
      GRID_ID_CANDIDATES,
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);
    diag.searchOk = true;

    // 특정 규격이 요청되면 grid 를 스크롤해가며 해당 행을 찾아 클릭. key 가
    // 없으면 첫 행 클릭(기존 동작).
    if (rowKey) {
      for (let i = 0; i < 15; i++) {
        const { found } = await page.evaluate(
          ({ key, gridIds }) => {
            const gid = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`));
            if (!gid) return { found: false };
            const tbody = document.getElementById(`${gid}_body_tbody`);
            const rows = tbody
              ? tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']")
              : [];
            for (const tr of rows) {
              if ((tr.textContent || "").includes(key)) {
                tr.scrollIntoView({ block: "center" });
                return { found: true };
              }
            }
            const layer =
              document.getElementById(`${gid}_dataLayer`) ||
              document.getElementById(`${gid}_body_scroll`) ||
              document.getElementById(gid);
            if (layer) layer.scrollTop = layer.scrollHeight;
            return { found: false };
          },
          { key: rowKey, gridIds: GRID_ID_CANDIDATES }
        );
        if (found) break;
        await page.waitForTimeout(600);
      }
    }
    const newPagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    const clicked = await page.evaluate(({ key, gridIds }) => {
      const gridId = gridIds.find((g) => !!document.getElementById(`${g}_body_tbody`));
      if (!gridId) return false;
      const tbody = document.getElementById(`${gridId}_body_tbody`);
      if (!tbody) return false;
      const rows = tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
      const target = key
        ? Array.from(rows).find((tr) => (tr.textContent || "").includes(key))
        : rows[0];
      if (!target) return false;

      // KDSIS 상세 popup(viewTchdataOpenP.xml)은 "규격서명" 컬럼의 anchor 만이
      // 트리거한다. openRowDetail 과 같은 매핑 로직을 여기도 적용.
      const thead =
        document.getElementById(`${gridId}_header_thead`) ||
        document.querySelector(`#${gridId} thead`);
      let specIdx = -1;
      if (thead) {
        const headers = Array.from(thead.querySelectorAll("th[col_id]"));
        specIdx = headers.findIndex((th) =>
          /규격\s*서명|규격명/.test((th.textContent || "").trim())
        );
      }
      const tds = Array.from(target.querySelectorAll("td")).filter(
        (td) => !(td.id || "").startsWith("_headerRowNumber_")
      );
      const targetCell = specIdx >= 0 ? tds[specIdx] : null;
      const link =
        (targetCell && targetCell.querySelector("a")) ||
        target.querySelector("td a, span.w2grid_span a");
      if (link) { link.click(); return true; }
      const allTds = target.querySelectorAll("td");
      if (allTds[3]) { allTds[3].click(); return true; }
      return false;
    }, { key: rowKey, gridIds: GRID_ID_CANDIDATES });
    diag.rowClicked = clicked;
    diag.rowKey = rowKey || null;

    await page.waitForTimeout(3000);
    const newPage = await newPagePromise;
    const targetPage = newPage || page;
    if (newPage) {
      diag.newPageOpened = true;
      await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await newPage.waitForTimeout(2000);
    }
    diag.popupUrl = targetPage.url();

    // 모든 frame 정보
    diag.frames = targetPage.frames().map((f) => ({
      name: f.name(),
      url: f.url().slice(0, 150),
    }));

    // 메인 프레임 + 모든 서브프레임에서 첨부파일 관련 요소 탐색
    for (const frame of targetPage.frames()) {
      const found = await frame.evaluate(() => {
        const result = {
          frameUrl: location.href.slice(0, 150),
          attachmentCandidates: [],
          sectionHtml: null,
          anchors: [],
          onclicks: [],
        };
        // "첨부", "파일", "다운로드" 텍스트 포함 요소 탐색
        const keywords = /첨부|파일|download|다운로드/i;
        const all = document.querySelectorAll("*");
        all.forEach((el) => {
          const text = (el.textContent || "").trim();
          if (text.length > 200) return;
          if (keywords.test(text) && el.children.length < 5) {
            result.attachmentCandidates.push({
              tag: el.tagName,
              id: el.id || null,
              class: (el.className || "").toString().slice(0, 80) || null,
              text: text.slice(0, 100),
            });
          }
        });
        result.attachmentCandidates = result.attachmentCandidates.slice(0, 20);

        // 첨부 섹션 HTML 추출 시도
        const sec = Array.from(document.querySelectorAll("*")).find(
          (el) => /첨부파일/.test((el.textContent || "").slice(0, 50)) && el.children.length > 0
        );
        if (sec) {
          let container = sec;
          for (let i = 0; i < 4 && container.parentElement; i++) container = container.parentElement;
          result.sectionHtml = container.outerHTML.slice(0, 4000);
        }

        // 다운로드로 보이는 a 태그
        document.querySelectorAll("a").forEach((a) => {
          const href = a.getAttribute("href") || "";
          const onclick = a.getAttribute("onclick") || "";
          const text = (a.textContent || "").trim().slice(0, 50);
          if (href.match(/\.(pdf|hwp|doc|xls|zip)/i) || /download|다운|첨부/i.test(onclick + text)) {
            result.anchors.push({ href: href.slice(0, 200), onclick: onclick.slice(0, 200), text });
          }
        });
        result.anchors = result.anchors.slice(0, 30);

        // download/file 관련 onclick 핸들러
        document.querySelectorAll("[onclick]").forEach((el) => {
          const onclick = el.getAttribute("onclick") || "";
          if (/download|file|첨부/i.test(onclick)) {
            result.onclicks.push({
              tag: el.tagName,
              id: el.id || null,
              text: (el.textContent || "").trim().slice(0, 50),
              onclick: onclick.slice(0, 200),
            });
          }
        });
        result.onclicks = result.onclicks.slice(0, 20);
        return result;
      }).catch(() => null);

      if (found && (found.attachmentCandidates.length || found.anchors.length || found.onclicks.length || found.sectionHtml)) {
        diag.attachmentCandidates.push(...found.attachmentCandidates.map((c) => ({ ...c, frame: found.frameUrl })));
        diag.allAnchors.push(...found.anchors.map((a) => ({ ...a, frame: found.frameUrl })));
        diag.onclickHandlers.push(...found.onclicks.map((o) => ({ ...o, frame: found.frameUrl })));
        if (!diag.attachmentSectionHtml && found.sectionHtml) {
          diag.attachmentSectionHtml = { frame: found.frameUrl, html: found.sectionHtml };
        }
      }
    }

    // 스크린샷
    await targetPage.screenshot({
      path: path.join(__dirname, "public", "last-detail.png"),
      fullPage: true,
    }).catch(() => {});
  } catch (err) {
    diag.error = err.message;
    if (/disconnect|Target closed|Browser has been closed|has been closed/i.test(err.message || "")) {
      await closeBrowser();
    }
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }

  res.json(diag);
});

// GET /api/screenshot — 마지막 검색 스크린샷 (디버깅용)
app.get("/api/screenshot", (req, res) => {
  const screenshotPath = path.join(__dirname, "public", "last-search.png");
  res.sendFile(screenshotPath, (err) => {
    if (err) res.status(404).json({ error: "스크린샷이 없습니다." });
  });
});

// GET /api/health — browser/cache/in-flight 상태 가볍게 노출
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    browserAlive: !!(_browser && _browser.isConnected()),
    cacheSize: cache.size,
    cacheTtlMs: cache.ttlMs,
    inFlight: _inFlight.size,
    aiProvider: AI_PROVIDER,
    uptimeSec: Math.round(process.uptime()),
    searchActive: searchQueue.active,
    searchQueued: searchQueue.queued,
    searchConcurrency: searchQueue.limit,
    downloadActive: downloadPool.active,
    downloadQueued: downloadPool.queued,
    downloadConcurrency: downloadPool.limit,
    detailCacheSize: detailCache.size,
    attachCacheSize: attachCache.size,
    attachCacheBytes: attachCache.bytes,
    attachCacheMaxBytes: attachCache.maxBytes,
    kdsisBlockCount15m: currentBlockCount(),
  });
});

// ── 첨부 프록시 API ───────────────────────────────────────
//
// /api/detail?params=<JSON>&key=<rowKey>
//   Returns { attachments: [{ id, name, kind, ... }] }. Opens the detail
//   popup for the row identified by <key> (usually 규격번호) and scrapes
//   attachment metadata out of every frame. Cached by (params, key).
//
// /api/attachment?params=<JSON>&key=<rowKey>&id=<attachmentId>
//   Streams the file bytes back with Content-Disposition. Clicks the
//   attachment's link inside Playwright (covers direct href + JS trigger
//   cases uniformly via page.on('download')).
//
// Both endpoints:
//   - per-IP rate limited (10/min default)
//   - share a concurrency-bounded Playwright pool (2 default), separate
//     from the search serial queue so downloads don't block searches
//   - each request opens a fresh context, no cross-request session state

function _clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "unknown";
}

function _parseParamsQuery(raw) {
  if (!raw) return null;
  try {
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

async function _enforceRateLimit(req, res) {
  const ip = _clientIp(req);
  const check = downloadRateLimiter.check(ip);
  if (!check.allowed) {
    const retryAfter = Math.ceil(check.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "Too Many Requests",
      retryAfterSec: retryAfter,
      limit: downloadRateLimiter.max,
      windowMs: downloadRateLimiter.windowMs,
    });
    return false;
  }
  return true;
}

// Cache-only probe. Returns {cached: true, count} if the (params, rowKey) pair
// is in detailCache, else {cached: false}. No Playwright, no rate-limit — used
// by the UI to opportunistically label cards on render ("첨부 N개" / "첨부 없음")
// without clicking anything. GET so it's trivially batchable in parallel.
app.get("/api/detail/cached", (req, res) => {
  const params = _parseParamsQuery(req.query.params);
  const rowKey = typeof req.query.key === "string" ? req.query.key : "";
  if (!params || !rowKey) return res.json({ cached: false });
  const entry = detailCache.get(`${cacheKey(params)}|${rowKey}`);
  if (!entry) return res.json({ cached: false });
  const count = Array.isArray(entry.attachments) ? entry.attachments.length : 0;
  res.json({ cached: true, count });
});

app.get("/api/detail", async (req, res) => {
  if (!(await _enforceRateLimit(req, res))) return;

  const params = _parseParamsQuery(req.query.params);
  const rowKey = typeof req.query.key === "string" ? req.query.key : "";
  if (!params || !rowKey) {
    return res.status(400).json({ error: "params(JSON)과 key(문자열)이 모두 필요합니다." });
  }

  const cacheK = `${cacheKey(params)}|${rowKey}`;
  // ?refresh=1 로 호출하면 캐시 건너뛰고 강제 재추출. extractAttachments 로직을
  // 바꿨거나 KDSIS 가 첨부를 나중에 올렸을 때 유용.
  const refresh = req.query.refresh === "1";
  if (!refresh) {
    const cached = detailCache.get(cacheK);
    if (cached) return res.json({ ...cached, __cached: true });
  }

  // ?html=1 로 호출하면 응답 JSON 에 상세 페이지 HTML(앞 60KB) 이 담긴다.
  // 파일시스템에 의존하지 않고 디버깅하려는 용도.
  const includeHtml = req.query.html === "1";
  try {
    const result = await downloadPool.run(async () => {
      const { context, page } = await openRowDetailWithRetry({ params, rowKey });
      try {
        const ext = await extractAttachments(page, { includeHtml });
        if (includeHtml && ext && Array.isArray(ext.attachments)) {
          return { attachments: ext.attachments, html: ext.html, rowKey };
        }
        return { attachments: ext, rowKey };
      } finally {
        try { await context.close(); } catch {}
      }
    });
    // html 은 캐시에 넣지 않는다(60KB×N → 메모리 폭증). 응답에만 동봉.
    const cacheable = { attachments: result.attachments, rowKey: result.rowKey };
    detailCache.set(cacheK, cacheable);
    res.json(result);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg === "KDSIS_BLOCKED") {
      res.setHeader("Retry-After", "60");
      const body = { error: "KDSIS가 현재 요청을 차단하고 있습니다. 잠시 후 다시 시도해 주세요." };
      if (err.diagnostics) body.diagnostics = err.diagnostics;
      return res.status(503).json(body);
    }
    if (msg === "ROW_NOT_FOUND") {
      const body = { error: `해당 규격(${rowKey})을 결과에서 찾지 못했습니다.` };
      if (err.diagnostics) body.diagnostics = err.diagnostics;
      return res.status(404).json(body);
    }
    console.error("[/api/detail]", msg);
    const body = { error: msg };
    if (err.diagnostics) body.diagnostics = err.diagnostics;
    res.status(500).json(body);
  }
});

app.get("/api/attachment", async (req, res) => {
  if (!(await _enforceRateLimit(req, res))) return;

  const params = _parseParamsQuery(req.query.params);
  const rowKey = typeof req.query.key === "string" ? req.query.key : "";
  const attachId = typeof req.query.id === "string" ? req.query.id : "";
  if (!params || !rowKey || !attachId) {
    return res.status(400).json({ error: "params, key, id가 모두 필요합니다." });
  }

  const bytesKey = `${cacheKey(params)}|${rowKey}|${attachId}`;
  const cachedBytes = attachCache.get(bytesKey);
  if (cachedBytes) {
    res.setHeader("Content-Type", cachedBytes.contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(cachedBytes.filename || "download")}`
    );
    return res.end(cachedBytes.buffer);
  }

  try {
    const file = await downloadPool.run(async () => {
      // 첨부 메타를 먼저 확보 (캐시 우선).
      const metaKey = `${cacheKey(params)}|${rowKey}`;
      let meta = detailCache.get(metaKey);
      const { context, page } = await openRowDetailWithRetry({ params, rowKey });
      try {
        if (!meta) {
          const attachments = await extractAttachments(page);
          meta = { attachments, rowKey };
          detailCache.set(metaKey, meta);
        }
        const attachment = meta.attachments.find((a) => a.id === attachId);
        if (!attachment) throw new Error("ATTACHMENT_NOT_FOUND");
        const dl = await triggerDownload(page, attachment);
        return dl;
      } finally {
        try { await context.close(); } catch {}
      }
    });

    // 캐시 저장 (단건이 상한 넘으면 자동 skip).
    attachCache.set(bytesKey, file, file.buffer.length);

    res.setHeader("Content-Type", file.contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename || "download")}`
    );
    res.end(file.buffer);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg === "KDSIS_BLOCKED") {
      res.setHeader("Retry-After", "60");
      return res.status(503).json({ error: "KDSIS가 요청을 차단했습니다." });
    }
    if (msg === "ATTACHMENT_NOT_FOUND" || msg === "ROW_NOT_FOUND") {
      return res.status(404).json({ error: msg });
    }
    console.error("[/api/attachment]", msg);
    res.status(500).json({ error: msg });
  }
});

// ── Graceful shutdown ───────────────────────────────────
// SIGTERM (e.g. docker stop, render deploy) / SIGINT (Ctrl+C) — close the
// shared chromium so it doesn't get orphaned as a zombie process.
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[서버] ${signal} 수신 — 정리 중...`);
  await closeBrowser();
  console.log("[서버] 종료");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Render Logs 에 명시적으로 찍히도록 — 침묵 502 의 근원이 unhandled rejection
// 이거나 uncaught exception 인지 식별하기 위함. 프로세스를 죽이지는 않는다.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[unhandledRejection]",
    reason && reason.stack ? reason.stack : reason
  );
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});

// ── 서버 시작 ────────────────────────────────────────────
app.listen(PORT, () => {
  const aiStatus =
    (AI_PROVIDER === "claude" && ANTHROPIC_API_KEY) ? "✅ Claude API" :
    (AI_PROVIDER === "gemini" && GEMINI_API_KEY) ? "✅ Gemini API" :
    "⚠️  규칙 기반 (API 키 미설정)";

  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║  🎖️  국방 AI 어시스턴트 서버 시작              ║
  ║  http://localhost:${PORT}                       ║
  ║                                               ║
  ║  AI 엔진: ${aiStatus.padEnd(35)}║
  ║                                               ║
  ║  POST /api/search      — 자연어 검색          ║
  ║  POST /api/search/direct — 필드 직접 지정     ║
  ║  GET  /api/health      — 상태 확인             ║
  ║  GET  /api/debug       — 진단 모드 (덤프)     ║
  ║  GET  /api/debug/raw   — 원시 fetch (IP 확인) ║
  ║  GET  /api/debug/mini  — Playwright 미니 진단 ║
  ║  GET  /api/screenshot  — 마지막 검색 캡처     ║
  ╚═══════════════════════════════════════════════╝
  `);

  // Render 무료 티어가 콜드 스타트로 깰 때 Playwright 첫 실행이 30~60초
  // 걸려서 사용자의 첫 검색이 Cloudflare 100초 게이트웨이를 맞고 502 가
  // 떨어진다. 서버 시작 직후 백그라운드로 브라우저를 미리 띄워서 첫 검색이
  // 콜드 스타트 비용을 안 떠안게.
  getBrowser()
    .then(() => console.log("[startup] Playwright 브라우저 미리 기동 완료"))
    .catch((err) => console.warn("[startup] 브라우저 사전 기동 실패:", err.message));

  // SEARCH_TIMEOUT_MS 가 step worst-case 합계보다 작으면 정상 검색이 컷된다
  // (dc2b004 회귀 — "[KDSIS] search timeout after 40000ms"). startup 에서
  // 명시적으로 경고만 찍어 운영자가 ENV 로 즉시 조정할 수 있게.
  const budget = validateSearchBudget({
    subBudgets: {
      portalWarmup: 10_000,   // server.js navigateToKdsis 의 portal goto
      gotoKdsis: 20_000,      // server.js navigateToKdsis 의 KDSIS_URL goto
      formReady: 20_000,      // waitForKdsisReady
      fieldFill: 5_000,       // 필드 입력 (waitForSelector 등)
      clickSearch: 10_000,    // clickSearchButton
      gridWait: 10_000,       // 그리드 렌더 대기
      stabilize: 1_500,       // 안정화
      scrollLoop: 1_500 * 5,  // 평균 5회 스크롤로 가정
    },
    totalBudget: SEARCH_TIMEOUT_MS,
  });
  if (!budget.ok) {
    console.warn(
      `[startup] SEARCH_TIMEOUT_MS(${SEARCH_TIMEOUT_MS}ms) 가 sub-step 합계` +
        `(${budget.sum}ms) 보다 작음 — overflow ${budget.overflow}ms.` +
        ` ENV KDSIS_SEARCH_TIMEOUT_MS 로 조정 필요.`
    );
  } else {
    console.log(
      `[startup] search budget OK (sub-sum ${budget.sum}ms / total ${SEARCH_TIMEOUT_MS}ms)`
    );
  }
});
