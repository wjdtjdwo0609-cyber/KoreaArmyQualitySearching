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
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const KDSIS_URL =
  "https://kdsis.dapa.go.kr/cs/ctlgSpprtMgt/cagecd9250Mgt/gukminPopup.do?tabIdx=0&popYn=Y";

// ── AI 설정 ──────────────────────────────────────────────
const AI_PROVIDER = (process.env.AI_PROVIDER || "claude").toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

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
      model: "claude-sonnet-4-20250514",
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
async function searchKDSIS(params) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      locale: "ko-KR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // 1) KDSIS 페이지 로드
    console.log("[KDSIS] 페이지 로딩 중...");
    await page.goto(KDSIS_URL, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // WebSquare 로딩 대기
    await page.waitForTimeout(2000);

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

    // 3) 검색 버튼 클릭
    console.log("[KDSIS] 검색 실행...");
    await page.click("#btn_search1");

    // 4) 결과 로딩 대기
    // WebSquare 그리드는 비동기로 렌더링되므로 네트워크 안정화 + 추가 대기
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);

    // 5) 결과 파싱 — KDSIS WebSquare w2grid 전용 셀렉터
    console.log("[KDSIS] 결과 파싱 중...");
    const results = await page.evaluate(() => {
      const data = { rows: [], columns: [], totalCount: 0 };

      // ── 컬럼 정의 (col_id → 한글 헤더 매핑) ──
      const COL_MAP = [
        { col_id: "rsltDivs",        name: "결과값종류" },
        { col_id: "cmpntsMgtNo",     name: "부품관리번호" },
        { col_id: "nsn",             name: "재고번호" },
        { col_id: "hanglItmnm",      name: "품명" },
        { col_id: "aplyEqpNm",       name: "적용장비명" },
        { col_id: "dtaDvsNm",        name: "품목유형" },
        { col_id: "specNo",          name: "규격서번호" },
        { col_id: "dtaNm",           name: "규격서/자료명" },
        { col_id: "stdrdstatecd",    name: "규격서상태" },
        { col_id: "stdrdMgtOrganNm", name: "형상관리책임기관" },
        { col_id: "drwgno",          name: "도면번호" },
        { col_id: "opnpblYn",        name: "도면상태" },
        { col_id: "partNumb",        name: "부품번호" },
        { col_id: "drwgno2",         name: "참조번호" },
      ];

      data.columns = COL_MAP.map(c => c.name);

      // ── tbody 행 파싱 ──
      const tbody = document.querySelector("#ggr_masterSrchList_body_tbody");
      if (!tbody) return data;

      const rows = tbody.querySelectorAll("tr.grid_body_row");
      rows.forEach((tr) => {
        const rowData = {};
        COL_MAP.forEach((col, colIdx) => {
          const td = tr.querySelector(`td[col_id="${col.col_id}"]`);
          if (!td) { rowData[col.name] = ""; return; }

          // 링크 셀: a 태그 텍스트 추출
          const link = td.querySelector("a");
          if (link && link.textContent.trim()) {
            rowData[col.name] = link.textContent.trim();
            return;
          }

          // 일반 셀: span.w2grid_span 텍스트 추출
          const span = td.querySelector("span.w2grid_span");
          if (span) {
            rowData[col.name] = span.textContent.trim();
            return;
          }

          rowData[col.name] = td.textContent.trim();
        });

        // 빈 행 제외
        const hasData = Object.values(rowData).some(v => v.length > 0);
        if (hasData) data.rows.push(rowData);
      });

      // ── 총 건수 추출 (#spn_listCnt) ──
      const countEl = document.querySelector("#spn_listCnt");
      if (countEl) {
        const m = countEl.textContent.match(/[\d,]+/);
        if (m) data.totalCount = parseInt(m[0].replace(/,/g, ""));
      } else {
        data.totalCount = data.rows.length;
      }

      return data;
    });

    // 6) 무한 스크롤 — 추가 데이터 로딩 (최대 3회 스크롤)
    const MAX_SCROLLS = 3;
    if (results.rows.length > 0 && results.totalCount > results.rows.length) {
      console.log(`[KDSIS] 무한 스크롤 시작 (현재 ${results.rows.length}건 / 총 ${results.totalCount}건)`);

      for (let i = 0; i < MAX_SCROLLS; i++) {
        const prevCount = results.rows.length;

        // 그리드 데이터 영역을 맨 아래로 스크롤
        await page.evaluate(() => {
          const dataLayer = document.querySelector("#ggr_masterSrchList_dataLayer");
          if (dataLayer) {
            dataLayer.scrollTop = dataLayer.scrollHeight;
          }
        });

        await page.waitForTimeout(2000);

        // 추가된 행 파싱
        const moreResults = await page.evaluate((prevRowCount) => {
          const COL_MAP = [
            { col_id: "rsltDivs", name: "결과값종류" },
            { col_id: "cmpntsMgtNo", name: "부품관리번호" },
            { col_id: "nsn", name: "재고번호" },
            { col_id: "hanglItmnm", name: "품명" },
            { col_id: "aplyEqpNm", name: "적용장비명" },
            { col_id: "dtaDvsNm", name: "품목유형" },
            { col_id: "specNo", name: "규격서번호" },
            { col_id: "dtaNm", name: "규격서/자료명" },
            { col_id: "stdrdstatecd", name: "규격서상태" },
            { col_id: "stdrdMgtOrganNm", name: "형상관리책임기관" },
            { col_id: "drwgno", name: "도면번호" },
            { col_id: "opnpblYn", name: "도면상태" },
            { col_id: "partNumb", name: "부품번호" },
            { col_id: "drwgno2", name: "참조번호" },
          ];
          const newRows = [];
          const tbody = document.querySelector("#ggr_masterSrchList_body_tbody");
          if (!tbody) return newRows;
          const allRows = tbody.querySelectorAll("tr.grid_body_row");
          for (let r = prevRowCount; r < allRows.length; r++) {
            const tr = allRows[r];
            const rowData = {};
            COL_MAP.forEach((col) => {
              const td = tr.querySelector(`td[col_id="${col.col_id}"]`);
              if (!td) { rowData[col.name] = ""; return; }
              const link = td.querySelector("a");
              if (link && link.textContent.trim()) { rowData[col.name] = link.textContent.trim(); return; }
              const span = td.querySelector("span.w2grid_span");
              rowData[col.name] = span ? span.textContent.trim() : td.textContent.trim();
            });
            if (Object.values(rowData).some(v => v.length > 0)) newRows.push(rowData);
          }
          return newRows;
        }, results.rows.length);

        if (moreResults.length === 0) {
          console.log(`[KDSIS] 스크롤 ${i + 1}: 추가 데이터 없음, 중단`);
          break;
        }

        results.rows.push(...moreResults);
        console.log(`[KDSIS] 스크롤 ${i + 1}: +${moreResults.length}건 (누적 ${results.rows.length}건)`);
      }
    }

    // 6) 스크린샷 (디버깅용)
    const screenshotPath = path.join(__dirname, "public", "last-search.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });

    console.log(`[KDSIS] 검색 완료: ${results.rows.length}건`);
    return results;
  } catch (error) {
    console.error("[KDSIS] 검색 에러:", error.message);
    return { rows: [], columns: [], totalCount: 0, error: error.message };
  } finally {
    if (browser) await browser.close();
  }
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
});

// POST /api/search/direct — 필드 직접 지정 검색
app.post("/api/search/direct", async (req, res) => {
  const { params } = req.body;
  if (!params || typeof params !== "object") {
    return res.status(400).json({ error: "params 객체가 필요합니다." });
  }

  console.log(`\n[직접 검색]`, params);
  const results = await searchKDSIS(params);
  const response = formatResultsForChat(params, results);
  res.json(response);
});

// GET /api/screenshot — 마지막 검색 스크린샷 (디버깅용)
app.get("/api/screenshot", (req, res) => {
  const screenshotPath = path.join(__dirname, "public", "last-search.png");
  res.sendFile(screenshotPath, (err) => {
    if (err) res.status(404).json({ error: "스크린샷이 없습니다." });
  });
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
  ║  GET  /api/screenshot  — 마지막 검색 캡처     ║
  ╚═══════════════════════════════════════════════╝
  `);
});
