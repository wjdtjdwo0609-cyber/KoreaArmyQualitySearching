# 🎖️ 국방 AI 어시스턴트 — KDSIS 실시간 검색 에이전트

KDSIS(국방표준종합정보시스템) 국민서비스를 AI 에이전트가 자동으로 검색하는 시스템입니다.
담당자가 자연어로 질문하면 Claude/Gemini가 검색 폼 파라미터를 추출하고, Playwright가 KDSIS를 자동 조회해 결과를 반환합니다.

**원칙: 데이터를 저장하지 않습니다.** 매 요청마다 KDSIS를 실시간으로 조회합니다 (검색 결과 캐싱은 60초 TTL의 메모리 캐시만).

## 아키텍처

```
사용자 자연어
    ↓
parseQuery — Claude/Gemini API (없으면 규칙 기반 폴백)
    ↓
TTL 캐시 (60초) — 동일 params 즉답
    ↓
Serial 큐 → Playwright (싱글턴 Chromium)
    ↓
KDSIS 폼 입력 → 검색 → WebSquare 그리드 파싱
    ↓
JSON 응답
    ↓
챗봇 UI (카드/표 뷰, 정렬, 페이지네이션, CSV/JSON 다운로드, ...)
```

## 설치 및 실행

```bash
npm install
npm run setup        # Playwright Chromium 설치
npm start            # dotenv로 .env 로드 후 기동
# 또는 npm run start:no-ai  (AI 키 없이 규칙 기반만)
```

http://localhost:3000 접속.

### 환경 변수 (.env)

```
AI_PROVIDER=claude              # claude | gemini
ANTHROPIC_API_KEY=sk-ant-...    # Claude 사용 시
GEMINI_API_KEY=AIza...          # Gemini 사용 시
PORT=3000                       # 선택
KDSIS_CACHE_TTL_MS=60000        # 검색 결과 캐시 TTL (선택)
KDSIS_SEARCH_TIMEOUT_MS=75000   # 검색 1회 wall-clock 타임아웃 (선택)
KDSIS_MAX_SCROLLS=10            # 무한 스크롤 최대 반복 횟수 (선택)
# 첨부파일 프록시 (선택)
KDSIS_DOWNLOAD_CONCURRENCY=2    # 다운로드 동시 실행 상한 (검색과 분리된 풀)
KDSIS_DETAIL_TTL_MS=600000      # 첨부 목록 메타 캐시 TTL (10분)
KDSIS_ATTACH_TTL_MS=300000      # 다운로드 바이트 캐시 TTL (5분)
KDSIS_ATTACH_CACHE_MAX_BYTES=52428800  # 바이트 캐시 총합 상한 (50MB)
KDSIS_DOWNLOAD_RATE_LIMIT=10    # 분당 IP별 요청 수 상한
KDSIS_DOWNLOAD_RATE_WINDOW_MS=60000  # 위 상한의 윈도우
# 피드백 (별점 + 익명 댓글)
FEEDBACK_LOG_FILE=data/feedback.jsonl  # JSONL append 경로 (선택)
FEEDBACK_ADMIN_TOKEN=                  # 비워두면 GET /api/feedback 비활성
KDSIS_FEEDBACK_RATE_LIMIT=10           # 분당 IP별 피드백 제출 상한
KDSIS_FEEDBACK_RATE_WINDOW_MS=60000    # 위 상한의 윈도우
```

AI 키가 없으면 자동으로 규칙 기반 파싱으로 폴백합니다.

## 기능

### 검색
- 자연어 → 검색 파라미터 (Claude/Gemini)
- 직접 파라미터 지정 (`/api/search/direct`)
- 규격번호, 적용장비명, 제정기관, 규격상태 등 10개 필드 지원
- WebSquare 그리드 무한 스크롤 자동 처리 (기본 최대 10회, 새 행이 안 올라오면 조기 종료, `KDSIS_MAX_SCROLLS`로 조정)

### 챗봇 UI
- 첨부파일 칩 (카드당 "📎 첨부파일 보기" → `/api/detail` → 링크 칩, `<a download>`로 브라우저 직접 저장)
- 카드 뷰 ↔ 표 뷰 토글
- 컬럼 정렬 (오름/내림/해제)
- 페이지네이션 (20/50/100/전체)
- 검색어 하이라이트
- 규격번호 1-클릭 복사
- CSV / JSON 다운로드 (RFC 4180, BOM 포함)
- 다크 모드 (시스템 감지 + 수동 토글)
- 최근 검색 드롭다운 (↑↓ 키 네비게이션, screen reader 지원)
- 키보드 단축키 (`?` 모달 참고)
- 공유 가능한 URL 해시 (`#q=...` / `#p.규격번호=...`)
- 세션 복원 (localStorage, 정렬·페이지 상태 포함)
- WCAG 보강 (skip-to-content, ARIA, 포커스 트랩, aria-activedescendant)
- 인쇄 스타일 (`@media print`)
- 토스트 알림 (3개 캡)
- 입력 글자 수 카운터 (400 경고 / 480 위험)
- 스크롤 따라가기 + ↓ 최신 점프 버튼

### 서버 인프라
- **Chromium 싱글턴**: 프로세스 당 1개 브라우저 재사용, 콜드 스타트 3~5초 절감
- **Serial 큐**: 동시 검색을 직렬화해 WebSquare 그리드 race 방지
- **TTL LRU 캐시**: 동일 params 60초 캐싱, in-flight 중복 요청 dedup
- **타임아웃 + 1회 재시도**: 45초 wall-clock, transient 에러만 재시도
- **Graceful shutdown**: SIGTERM/SIGINT에서 브라우저 정리

### 첨부파일 프록시 (zero-storage)
- 파일을 서버 디스크에 저장하지 않고 요청 시점에 KDSIS를 다시 열어 바이트를 그대로 스트림
- 매 요청은 새 Playwright **컨텍스트**로 세션을 처음부터 재현 → 쿠키 만료 창 없음 (브라우저 싱글턴은 그대로)
- 검색과 분리된 **다운로드 풀** (`createConcurrentQueue`, 기본 2 동시), 검색 지연 없음
- **바이트 캐시** (5분, 총합 50MB) + **메타 캐시** (10분) — 동일 파일 재다운로드 즉답
- **Per-IP rate limit** (기본 10 req/min) + 차단 감지 시 `503 Retry-After` 응답
- `/api/health`에 `downloadActive / downloadQueued / attachCacheBytes / kdsisBlockCount15m` 노출

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/search` | 자연어 검색 (`{ query }`) |
| POST | `/api/search/direct` | 필드 직접 지정 (`{ params }`) |
| GET  | `/api/detail` | 특정 행의 첨부 메타 조회 (`?params=<json>&key=<규격번호>`) |
| GET  | `/api/attachment` | 첨부 스트리밍 프록시 (`?params=<json>&key=<규격번호>&id=<id>`) |
| GET  | `/api/health` | 브라우저/캐시/in-flight/다운로드 풀 상태 |
| GET  | `/api/screenshot` | 마지막 검색 화면 캡처 |
| GET/POST | `/api/debug` | 진단 모드 (DOM 상태 덤프) |
| POST | `/api/debug/detail` | 첫 결과 상세 팝업 분석 |

### 예시

```bash
# 자연어
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "K2 소총 활성 규격"}'

# 직접 지정
curl -X POST http://localhost:3000/api/search/direct \
  -H "Content-Type: application/json" \
  -d '{"params": {"규격번호": "1005-0409"}}'

# 첨부 목록
curl 'http://localhost:3000/api/detail?params=%7B%22규격번호%22%3A%221005-0409%22%7D&key=1005-0409'

# 첨부 다운로드 (스트리밍, 서버 디스크 경유 0)
curl -OJ 'http://localhost:3000/api/attachment?params=%7B%22규격번호%22%3A%221005-0409%22%7D&key=1005-0409&id=<id>'

# 헬스
curl http://localhost:3000/api/health
```

## 기술 스택

- **Backend:** Node.js + Express
- **브라우저 자동화:** Playwright (Chromium)
- **Frontend:** Vanilla HTML/CSS/JS (단일 파일, 빌드 도구 없음)
- **AI 파싱:** Claude (claude-sonnet-4) / Gemini (gemini-2.0-flash) / 규칙 기반 폴백

## 운영 노트

- 첫 검색은 Chromium 기동으로 5~10초 걸릴 수 있습니다. 이후 요청은 컨텍스트만 새로 만들어 ~3~7초.
- 동일 검색을 60초 안에 반복하면 캐시에서 즉답합니다 (`__cached: true`).
- 서버는 매 요청마다 브라우저를 종료하지 않습니다. `kill` / `Ctrl+C` 시 graceful shutdown으로 정리됩니다.
- 결과가 0건일 때도 캐시되어, 잘못된 검색을 빠르게 거를 수 있습니다.
