# Changelog

## [Unreleased] — UI/UX 개선 + 서버 최적화

### Phase 0: 초기 a11y·반응형·새 대화 (11be01f)
- aria-live, role 속성, focus-visible 전역 규칙
- 태블릿/와이드/울트라와이드 4개 반응형 브레이크포인트
- 0.6875rem 최소 타이포 0.75rem 이상 상향
- "＋ 새 대화" 버튼 + Ctrl+K 단축키
- 인라인 onclick 전부 이벤트 위임 전환

### Phase 1: 다크모드 (730e7ee)
- CSS 변수 라이트/다크 2종 세트
- `<head>` 인라인 스크립트로 FOUC 방지
- 수동 토글 + 시스템 prefers-color-scheme 추적
- 200ms 색상 전환 애니메이션

### Phase 2: 세션 영속화 (044dc5b)
- localStorage에 최대 50건 이벤트 로그 저장
- 새로고침 시 동일 렌더 함수로 재생 (재요청 없음)

### Phase 3: 규격번호 복사 + 토스트 (6c60590)
- spec-no 칩을 `<button>` 변환, Clipboard API + fallback
- 토스트 시스템: success/error/info, 2.2초 자동 소멸

### Phase 4: 스켈레톤 로더 (421e9d5)
- shimmer 키프레임 카드 2장으로 typing dots 대체

### Phase 5: 에러 재시도 + 빈 상태 (f8be7ab)
- lastSearch 추적, "🔄 다시 시도" 버튼 4개 분기 모두 부착
- 빈 결과에 안내 메시지 + 검색어 피드백

### Phase 6: 키보드 단축키 도움말 (722786c)
- role=dialog 모달, focus trap, Esc/? 토글
- `/` 입력창 포커스, `<kbd>` 스타일

### Phase 7: 검색어 하이라이트 (528834d)
- `highlight()` 헬퍼: 이스케이프 선행 → longest-match-first `<mark>`
- 카드 title/meta/details + 표 셀 양쪽 적용

### Phase 8: CSV 다운로드 (1b06a53)
- RFC 4180 인용, UTF-8 BOM, 정렬 순서 반영
- downloadBlob() 공통 헬퍼

### Phase 9: 최근 검색 히스토리 (5964680)
- localStorage 10개 캡, ↑↓ wrap-around, 개별/전체 삭제
- mousedown preventDefault로 blur 충돌 방지

### Phase 10: 컬럼 정렬 (97fb61b)
- compareVals: 숫자→Number, 날짜→lex, 한글→locale
- 빈 값 항상 바닥 고정 (sign 바깥에서 empty check)
- 표 헤더 3단 사이클 (asc→desc→해제) + 카드 드롭다운

### Phase 11: 페이지네이션 (4da9648)
- 기본 20/페이지, 20/50/100/전체 선택
- pageSlice 클램핑, 정렬 변경 시 0페이지 리셋

### Phase 12: JSON 다운로드 (a76b981)
- self-describing 엔벨로프 {exportedAt, totalCount, ...}
- CSV/JSON 단일 위임 핸들러 통합

### Phase 13: 공유 URL (baacd5e)
- hash 직렬화 (#q= / #p.필드=값)
- pushState/replaceState, popstate 뒤로가기 지원
- 해시 우선 복원 (세션보다 높은 우선순위)

### Phase 14: UI 마무리 7건 (f4a185b)
- Skip-to-content 링크 (WCAG 2.4.1)
- 토스트 큐 캡 (3개)
- 글자 수 카운터 (warn 90%, full 100%)
- 스마트 auto-scroll + "↓ 최신" FAB
- aria-activedescendant 최근 검색 연결
- 정렬/페이지 상태 세션 영속화
- @media print 인쇄 스타일

### Phase 15: server.js 최적화 (1d277b6)
- Playwright 싱글턴 풀링 (20회 재사용 후 교체)
- 동시 요청 큐 직렬화
- 5분 TTL 인메모리 캐시 (50건)
- AI 파싱 10초 타임아웃
- try/catch → 500 JSON 에러 응답
- SIGINT/SIGTERM graceful shutdown

### Phase 16: README + CHANGELOG (이 커밋)
- README 전면 재작성: 기능 표, 단축키, 서버 성능 비교, a11y, 환경변수
- CHANGELOG 신규 생성
