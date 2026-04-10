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
    // WebSquare w2grid는 검색 후 비동기로 행을 생성하므로
    // 고정 타임아웃 대신 "실제로 행이 나타날 때까지" 명시적으로 기다림
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForFunction(
      () => {
        const tb = document.querySelector("#ggr_stndList_body_tbody");
        if (tb) {
          const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
          if (rows.length > 0) return true;
        }
        // 결과가 0건인 경우에도 무한 대기하지 않도록 카운트 요소 확인
        const cnt = document.querySelector("#spn_listCnt");
        if (cnt) {
          const txt = (cnt.textContent || "").trim();
          if (/^0건?$/.test(txt) || txt === "0") return true;
        }
        return false;
      },
      { timeout: 15000 }
    ).catch(() => {
      console.warn("[KDSIS] 그리드 렌더링 대기 타임아웃 (15초) — 계속 진행");
    });
    // 안정화용 추가 대기 — diagnosticSearch가 스크린샷/DOM 스캔으로 우연히 얻던 버퍼와 맞춤
    await page.waitForTimeout(2500);

    // 5) 결과 파싱 — KDSIS WebSquare w2grid (실제 tbody: ggr_stndList)
    //   칼럼은 하드코딩하지 않고 thead를 읽어서 동적으로 구성
    console.log("[KDSIS] 결과 파싱 중...");
    const GRID_ID = "ggr_stndList";
    const results = await page.evaluate((gridId) => {
      const data = { rows: [], columns: [], totalCount: 0, _debug: {} };

      // ── 헤더에서 칼럼명 추출 ──
      // WebSquare w2grid는 thead 안 th에 col_id 속성을 둠
      // thead의 th 순서대로 이름 수집. KDSIS w2grid는 "형상관리책임기관" 같은
      // 그룹 헤더에 colspan=3을 붙여 하위 3개 데이터 칼럼을 묶는다.
      // colspan을 펼쳐야 td와 1:1 매칭됨 (콜스팬 2~N은 이름 뒤에 (1),(2)... 붙임).
      const headOrder = [];
      const thead =
        document.querySelector(`#${gridId}_header_thead`) ||
        document.querySelector(`#${gridId} thead`);
      if (thead) {
        thead.querySelectorAll("th[col_id]").forEach((th) => {
          const colId = th.getAttribute("col_id");
          const name = (th.textContent || "").trim() || colId;
          const colspan = parseInt(th.getAttribute("colspan") || "1", 10);
          if (colspan > 1) {
            for (let i = 0; i < colspan; i++) {
              headOrder.push({ colId, name: `${name}(${i + 1})` });
            }
          } else {
            headOrder.push({ colId, name });
          }
        });
      }
      data.columns = headOrder.map((c) => c.name);

      // ── tbody 행 파싱 ──
      const tbody = document.querySelector(`#${gridId}_body_tbody`);
      data._debug.theadFound = !!thead;
      data._debug.theadSelectorUsed = document.querySelector(`#${gridId}_header_thead`)
        ? `#${gridId}_header_thead`
        : (document.querySelector(`#${gridId} thead`) ? `#${gridId} thead` : null);
      data._debug.headOrderLength = headOrder.length;
      data._debug.headOrderNames = headOrder.map((h) => h.name);
      // thead 구조 전체 덤프 (multi-row 헤더 진단용)
      if (thead) {
        const trs = thead.querySelectorAll("tr");
        data._debug.theadRowCount = trs.length;
        data._debug.theadRows = Array.from(trs).map((tr) => ({
          thCount: tr.querySelectorAll("th").length,
          thWithColId: tr.querySelectorAll("th[col_id]").length,
          thNames: Array.from(tr.querySelectorAll("th")).map((th) => ({
            colId: th.getAttribute("col_id"),
            colspan: th.getAttribute("colspan"),
            text: (th.textContent || "").trim().slice(0, 30),
          })),
        }));
      }
      // 첫 데이터 row의 td 상세 (공백 cell 포함)
      const firstTr = tbody && tbody.querySelector("tr.grid_body_row, tr[class*='grid_body']");
      if (firstTr) {
        const allTds = firstTr.querySelectorAll("td");
        data._debug.firstRowTdCount = allTds.length;
        data._debug.firstRowTds = Array.from(allTds).map((td) => ({
          colIndex: td.getAttribute("colindex"),
          colId: td.getAttribute("col_id"),
          id: (td.id || "").slice(0, 50),
          text: (td.textContent || "").trim().slice(0, 30),
        }));
      }
      data._debug.tbodyFound = !!tbody;
      if (!tbody) {
        const anyTbodies = Array.from(document.querySelectorAll("tbody")).map((t) => ({
          id: t.id || null, rowCount: t.querySelectorAll("tr").length,
        }));
        data._debug.allTbodies = anyTbodies.slice(0, 10);
        return data;
      }

      const trs = tbody.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
      data._debug.trMatchCount = trs.length;
      data._debug.tbodyAllTrCount = tbody.querySelectorAll("tr").length;
      // KDSIS w2grid 주의: thead의 col_id(column53 등 WebSquare 내부 번호)와
      // tbody td의 col_id(stdrdKndNm 등 데이터 필드명)는 서로 다른 네임스페이스라
      // 속성값으로 매칭하면 안 됨. td 순서(colindex) 기반으로 짝짓는다.
      // 첫 번째 td는 row number 셀(colindex=0, id=_headerRowNumber_...)이므로 제외.
      const columnNames = headOrder.map((h) => h.name);
      trs.forEach((tr) => {
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
        if (columnNames.length === 0 && data.columns.length === 0) {
          data.columns = Object.keys(rowData);
        }
        // 빈 행 제외
        const hasData = Object.values(rowData).some((v) => v && v.length > 0);
        if (hasData) data.rows.push(rowData);
      });

      // ── 총 건수 추출 (#spn_listCnt) ──
      const countEl = document.querySelector("#spn_listCnt");
      if (countEl) {
        data._debug.spnListCntText = (countEl.textContent || "").trim().slice(0, 50);
        const m = countEl.textContent.match(/[\d,]+/);
        if (m) data.totalCount = parseInt(m[0].replace(/,/g, ""));
      } else {
        data._debug.spnListCntText = null;
        data.totalCount = data.rows.length;
      }

      data._debug.rowsParsed = data.rows.length;
      return data;
    }, GRID_ID);

    // 6) 무한 스크롤 — 추가 데이터 로딩 (최대 3회 스크롤)
    //   매 스크롤마다 thead를 다시 읽어서 동적 파싱 — col_id 하드코딩 없음
    const MAX_SCROLLS = 3;
    if (results.rows.length > 0 && results.totalCount > results.rows.length) {
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

        await page.waitForTimeout(2000);

        // 추가된 행만 파싱 (prevRowCount부터) — td 순서 기반 매칭
        const moreResults = await page.evaluate(
          ({ gridId, prevRowCount }) => {
            const thead =
              document.querySelector(`#${gridId}_header_thead`) ||
              document.querySelector(`#${gridId} thead`);
            const columnNames = [];
            if (thead) {
              thead.querySelectorAll("th[col_id]").forEach((th) => {
                columnNames.push((th.textContent || "").trim());
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

// ── 진단 모드: 페이지 내부 상태 전부 덤프 ─────────────────
// 목적: "왜 결과가 0건인가"를 원인별로 분리해서 판정
//   1) 폼 입력이 실제로 반영됐는가 (dropdown 선택 포함)
//   2) 검색 버튼이 실제로 클릭됐는가 (어떤 셀렉터가 매칭됐는가)
//   3) 검색 후 페이지에 결과가 있는가 (DOM 스캔)
//   4) 카운트/tbody 셀렉터가 실제 DOM과 일치하는가
async function diagnosticSearch(params) {
  let browser;
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

    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text());
    });

    await page.goto(KDSIS_URL, { waitUntil: "networkidle", timeout: 30000 });
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

    // 4) 여러 검색 버튼 셀렉터 순차 시도
    const buttonSelectors = [
      "#btn_search1",
      "#btn_search",
      "#btnSearch",
      "#btn_srch",
      'input[type="button"][value="검색"]',
      'button:has-text("검색")',
    ];
    for (const btnSel of buttonSelectors) {
      diag.searchButtonTried.push(btnSel);
      try {
        const exists = await page.$(btnSel);
        if (exists) {
          await page.click(btnSel);
          diag.searchButtonClicked = btnSel;
          break;
        }
      } catch (e) {
        /* 다음 후보 */
      }
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    // 그리드 행이 실제로 나타날 때까지 대기 (searchKDSIS와 동일 정책)
    await page.waitForFunction(
      () => {
        const tb = document.querySelector("#ggr_stndList_body_tbody");
        if (tb) {
          const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
          if (rows.length > 0) return true;
        }
        const cnt = document.querySelector("#spn_listCnt");
        if (cnt) {
          const txt = (cnt.textContent || "").trim();
          if (/^0건?$/.test(txt) || txt === "0") return true;
        }
        return false;
      },
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
    const tbodyInfo = await page.evaluate(() => {
      const tb = document.querySelector("#ggr_stndList_body_tbody");
      const thead =
        document.querySelector("#ggr_stndList_header_thead") ||
        document.querySelector("#ggr_stndList thead");
      const columns = [];
      if (thead) {
        thead.querySelectorAll("th[col_id]").forEach((th) => {
          columns.push({
            colId: th.getAttribute("col_id"),
            name: (th.textContent || "").trim(),
          });
        });
      }
      if (!tb) return { found: false, columns };
      const rows = tb.querySelectorAll("tr.grid_body_row, tr[class*='grid_body']");
      return {
        found: true,
        rowCount: rows.length,
        columns,
        firstRowHtml: rows[0]?.outerHTML.slice(0, 2500) || null,
      };
    });
    diag.gridTbodyFound = tbodyInfo.found;
    diag.gridRowCount = tbodyInfo.rowCount || 0;
    diag.gridColumns = tbodyInfo.columns || [];
    diag.gridFirstRowHtml = tbodyInfo.firstRowHtml;

    diag.currentUrl = page.url();
  } catch (err) {
    diag.error = err.message;
  } finally {
    if (browser) await browser.close();
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
      _debug: results._debug || null,
    };
  }

  return {
    message: `[${searchDesc}] 검색 결과 ${results.totalCount || results.rows.length}건을 찾았습니다.`,
    type: "success",
    searchParams: params,
    columns: results.columns,
    rows: results.rows,
    totalCount: results.totalCount || results.rows.length,
    _debug: results._debug || null,
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
  ║  GET  /api/debug       — 진단 모드 (덤프)     ║
  ║  GET  /api/screenshot  — 마지막 검색 캡처     ║
  ╚═══════════════════════════════════════════════╝
  `);
});
