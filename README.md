# 🎖️ 국방 AI 어시스턴트 — KDSIS 실시간 검색 에이전트

KDSIS(국방표준종합정보시스템) 국민서비스를 AI 에이전트가 자동으로 검색하는 시스템입니다.
담당자가 자연어로 질문하면, Playwright가 KDSIS 검색 폼을 자동으로 채우고 결과를 가져옵니다.

## 아키텍처

```
사용자 입력 (자연어)
    ↓
parseQuery() — AI 파싱 (Claude/Gemini) → 규칙 기반 폴백
    ↓
Playwright — KDSIS 페이지 자동 조작 (싱글턴 브라우저 + 요청 큐)
    ↓
결과 파싱 → JSON → 채팅 UI에 카드/표 표시
```

**핵심: 데이터를 저장하지 않음.** 매번 KDSIS를 실시간 조회합니다. (5분 TTL 인메모리 캐시만 사용)

## 설치 및 실행

```bash
# 1. 의존성 설치
npm install

# 2. Playwright 브라우저 설치 (Chromium)
npm run setup

# 3. 환경변수 (.env 파일 생성 — 선택)
echo "AI_PROVIDER=claude" > .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

# 4. 서버 시작
npm start
```

브라우저에서 http://localhost:3000 접속

> **API 키 없이도 동작합니다.** 규칙 기반 파싱으로 폴백하며, 샘플 카드 클릭은 `/api/search/direct`를 사용하므로 AI 파싱 없이 100% 작동합니다.

## UI 기능

| 기능 | 설명 |
|------|------|
| 다크 모드 | 시스템 자동 감지 + 수동 토글 (🌙 버튼 / `Shift+D`) |
| 세션 영속화 | 새로고침해도 대화·정렬·페이지 상태가 localStorage에 복원 |
| 규격번호 복사 | 카드의 규격번호 칩 클릭 → 클립보드 복사 + 토스트 |
| 검색어 하이라이트 | 결과 카드·표에서 검색 키워드를 `<mark>`로 강조 |
| CSV / JSON 다운로드 | 현재 정렬 순서로 전체 결과를 `kdsis_*.csv` / `.json`으로 내보내기 |
| 컬럼 정렬 | 카드뷰: 드롭다운 + ▲/▼ 방향 전환. 표뷰: 헤더 클릭 (asc→desc→해제) |
| 페이지네이션 | 20건 이상 결과 자동 페이지 분할 (20/50/100/전체 선택) |
| 최근 검색 히스토리 | 입력창 포커스 시 최근 10개 드롭다운 (↑↓ 키보드 네비게이션) |
| 공유 URL | 🔗 버튼 / `Shift+S` → 현재 검색을 해시 URL로 복사. 링크 열면 자동 재실행 |
| 에러 재시도 | 에러·빈 결과에 "🔄 다시 시도" 버튼 |
| 스켈레톤 로더 | 검색 중 결과 카드 형태의 shimmer 애니메이션 |
| 키보드 단축키 | `?` 키로 전체 목록 확인 (모달) |
| 인쇄 지원 | `Ctrl+P` → 깔끔한 프린트 레이아웃 (그림자·버튼 제거) |

### 키보드 단축키

| 키 | 동작 |
|----|------|
| `Enter` | 검색 전송 |
| `Shift+Enter` | 줄바꿈 |
| `Ctrl/Cmd+K` | 새 대화 |
| `Shift+D` | 다크모드 전환 |
| `Shift+S` | 공유 링크 복사 |
| `?` | 도움말 모달 |
| `/` | 입력창 포커스 |
| `Esc` | 모달 닫기 |
| `↑` `↓` | 최근 검색 탐색 |

## 서버 성능 개선

| 항목 | Before | After |
|------|--------|-------|
| 브라우저 launch | 매 요청마다 (15-30초) | 싱글턴 재사용 (20회 후 교체) |
| 동시 요청 | 충돌 → 상태 오염 | 큐 직렬화 |
| 반복 검색 | 매번 Playwright 실행 | 5분 TTL 캐시 (최대 50건) |
| AI 파싱 | 무한 대기 가능 | 10초 타임아웃 후 규칙 기반 폴백 |
| 에러 처리 | 프로세스 크래시 | try/catch → 500 JSON |
| 종료 | 좀비 프로세스 | SIGINT/SIGTERM → 브라우저 정리 |

## 접근성 (a11y)

- WCAG 2.4.1: Skip-to-content 링크
- WCAG 2.4.7: `:focus-visible` 모든 인터랙티브 요소
- `role="log"`, `aria-live="polite"` 동적 메시지 영역
- `role="dialog"`, focus trap, `aria-modal` 모달
- `aria-activedescendant` 최근 검색 드롭다운
- `prefers-reduced-motion` 미디어 쿼리 지원
- `color-scheme: light dark` 네이티브 폼 위젯 테마

## 자연어 검색 예시

| 입력 | 자동 매핑 |
|------|-----------|
| "K2 소총 규격서 찾아줘" | 적용장비명: "K2 소총" |
| "KDS 1005 검색" | 규격번호: "KDS 1005" |
| "국방기술품질원 제정 활성 규격" | 제정기관: "국방기술품질원", 규격상태: "활성" |
| "1005-01-570-0001 재고번호 조회" | 재고번호: "1005-01-570-0001" |
| "박격포 관련 규격" | 적용장비명 또는 규격서명: "박격포" |

## API

### POST /api/search
자연어 검색 (AI 파싱 → 규칙 기반 폴백)

```json
{ "query": "K2 소총 규격서 찾아줘" }
```

### POST /api/search/direct
필드 직접 지정 검색 (AI 파싱 없이 바로 KDSIS 조회)

```json
{
  "params": {
    "적용장비명": "K2 소총",
    "규격상태": "활성"
  }
}
```

### GET /api/screenshot
마지막 검색의 KDSIS 화면 캡처 (디버깅용)

### GET /api/debug
진단 모드 — KDSIS 폼 입력·버튼 클릭·DOM 상태 전부 덤프

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 |
| `AI_PROVIDER` | `claude` | AI 파싱 엔진 (`claude` / `gemini`) |
| `ANTHROPIC_API_KEY` | (없음) | Claude API 키 |
| `GEMINI_API_KEY` | (없음) | Gemini API 키 |

## 기술 스택

- **Backend:** Node.js + Express
- **브라우저 자동화:** Playwright (Chromium) — 싱글턴 풀링
- **Frontend:** Vanilla HTML/CSS/JS (SPA, 1700줄)
- **AI 파싱:** Claude/Gemini API (선택) + 규칙 기반 NLU (폴백)
- **영속화:** localStorage (테마, 세션, 최근 검색)

## 결과 테이블 파싱 주의사항

현재 결과 테이블 파싱 로직(`server.js`의 `page.evaluate` 부분)은
KDSIS의 실제 결과 HTML 구조에 맞게 조정이 필요할 수 있습니다.

**조정 방법:**
1. 서버 실행 후 검색 실행
2. `GET /api/debug`로 DOM 상태 확인
3. `/api/screenshot`에서 캡처 이미지 확인
4. KDSIS 결과 테이블의 실제 HTML 구조를 확인하여 셀렉터 수정

## 향후 확장

- [ ] 결과 테이블 셀렉터 KDSIS 실제 구조에 맞게 튜닝
- [ ] 검색 결과 내 문서(한글, 도면) 다운로드 링크 파싱
- [x] ~~Claude API 연동으로 자연어 파싱 정확도 향상~~ (Phase 15)
- [x] ~~검색 이력 세션 관리~~ (Phase 2, 9)
