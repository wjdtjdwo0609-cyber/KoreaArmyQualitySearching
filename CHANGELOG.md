# Changelog

날짜는 한국 시간 기준이며, Phase 단위 작업으로 묶어 정리했습니다.

## Phase 15 — 서버 성능 (3eabcf6)

`server.js`의 콜드 스타트 병목과 운영 위생 문제를 정리.

- **싱글턴 Chromium**: 프로세스 당 1개 브라우저 재사용. 매 요청마다의 launch/close 제거 → 콜드 스타트 3~5초 절감.
- **Serial 큐**: 동시 검색을 직렬화. 같은 브라우저 위에서 WebSquare 그리드가 race 상태에 빠지는 걸 차단.
- **TTL + LRU 캐시** (60초, 64건): 동일 params 즉답. `KDSIS_CACHE_TTL_MS` 환경변수로 조정.
- **In-flight dedup**: 동시에 들어온 동일 검색은 하나의 Playwright 실행을 공유.
- **타임아웃 + 1회 재시도**: 45초 wall-clock, transient 에러(timeout/disconnect/nav 등)에만 재시도. `KDSIS_SEARCH_TIMEOUT_MS`.
- **Graceful shutdown**: SIGTERM/SIGINT에서 브라우저 정리.
- **`/api/health`**: 브라우저 alive, 캐시 크기, in-flight 수, uptime 노출.
- `diagnosticSearch` / `/api/debug/detail`도 싱글턴으로 마이그레이션.
- README 전면 갱신 (Phases 1~15 반영).

## Phase 14 — UI 마무리 (5519461)

기존 페이즈에서 빈 구멍 7개를 한 번에 메움.

- **스크롤 고정 UX**: `followBottom` 상태로 사용자가 스크롤 업 했을 때 자동 스크롤 차단. 위로 갔을 때 `↓ 최신` 버튼 노출.
- **정렬/페이지 영속화**: 세션 이벤트에 `sort/page/pageSize` 저장. 새로고침 후에도 같은 뷰 상태 복원.
- **`aria-activedescendant`**: 최근 검색 콤보박스가 스크린 리더에서 활성 항목을 안내.
- **인쇄 스타일**: `@media print`로 헤더/입력창/토스트 등 전부 숨김. 카드는 `page-break-inside: avoid`로 깔끔하게 출력.
- **입력 글자 수 카운터**: 0~500 표시, 400↑ 경고 / 480↑ 위험.
- **토스트 큐 캡**: 동시 토스트 최대 3개. 초과 시 가장 오래된 것 즉시 제거.
- **Skip-to-content 링크**: WCAG 2.4.1. 첫 Tab에서 노출, `<main tabindex="-1">`로 포커스 가능.

## Phase 13 — Shareable URL (baacd5e)

검색 상태를 URL 해시로 인코딩. `#q=...` (자연어) / `#p.규격번호=...&label=...` (직접 검색). Back/Forward 버튼 지원.

## Phase 12 — JSON 다운로드 (a76b981)

CSV에 더해 JSON 익스포트 추가. 정렬 상태 그대로, `exportedAt` 타임스탬프 포함.

## Phase 11 — 페이지네이션 (4da9648)

20건 초과 결과는 페이지로 분할. 페이지당 20/50/100/전체 선택. 정렬 변경 시 1페이지로 리셋.

## Phase 10 — 컬럼 정렬 (97fb61b)

표 헤더 클릭 / 카드 뷰 select로 정렬. 빈 값은 항상 하단 고정 (방향과 무관). 3-state: asc → desc → off.

## Phase 9 — 최근 검색 드롭다운 (5964680)

입력창 위 드롭다운 (`role="listbox"`). ↑↓ 키 네비, 항목별 제거, 모두 지우기. 최대 10건, localStorage 저장.

## Phase 8 — CSV 다운로드 (1b06a53)

결과별 CSV 익스포트. RFC 4180 따옴표 처리, UTF-8 BOM (Excel 한글 호환).

## Phase 7 — 검색어 하이라이트 (528834d)

검색 파라미터 + 자연어 토큰을 카드/표 결과에 `<mark>`로 강조. HTML escape 후 매칭, 최장 매치 우선.

## Phase 6 — 단축키 도움말 (722786c)

`?` 키로 모달. Focus trap, Esc로 닫기. Enter / Shift+Enter / Ctrl+K / Shift+D / Shift+S / `/` 등 단축키 전체 목록.

## Phase 5 — 재시도 + 빈 결과 UI (f8be7ab)

에러/빈 결과 메시지에 다시 시도 버튼. `lastSearch` 추적해 자연어 / 직접 검색 양쪽 재실행.

## Phase 4 — 스켈레톤 로더 (421e9d5)

타이핑 점 대신 결과 카드 모양의 shimmer skeleton. 결과가 어떤 모양으로 올지 미리 보여 체감 대기 시간 단축.

## Phase 3 — 규격번호 1-클릭 복사 (6c60590)

카드의 규격번호 칩이 버튼이 됨. 클릭 → 클립보드 복사 + 토스트 피드백. 비보안 컨텍스트는 `execCommand` 폴백.

## Phase 2 — 세션 복원 (044dc5b)

마지막 50개 이벤트 (user / bot / result)를 localStorage에 저장. 새로고침 시 채팅 흐름 그대로 복원, 결과는 구조화 데이터로 즉시 재렌더.

## Phase 1 — 다크 모드 (730e7ee)

`prefers-color-scheme` 자동 감지 + 수동 토글 (Shift+D). 사용자 선택은 localStorage에 영구. No-flash 적용.

## 그 이전 — 코어 기반 작업

- **PR #4** (13ec645): UI/UX 접근성·반응형·새 대화 흐름 개선
- **PR #3** (0973b37): 무한 스크롤, 컬럼 col_id 매칭, td 순서 기반 파싱
- **PR #2** (2f9bf4a): 그리드 tbody 셀렉터 (`ggr_stndList`), 동적 파싱
- **PR #1** (4869c24): 진단 모드 (`/api/debug`)
- **Initial**: Express + Playwright + 자연어 → KDSIS 자동 검색 골격
