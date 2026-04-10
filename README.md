# 🎖️ 국방 AI 어시스턴트 — KDSIS 실시간 검색 에이전트

KDSIS(국방표준종합정보시스템) 국민서비스를 AI 에이전트가 자동으로 검색하는 시스템입니다.
담당자가 자연어로 질문하면, Playwright가 KDSIS 검색 폼을 자동으로 채우고 결과를 가져옵니다.

## 아키텍처

```
사용자 입력 (자연어)
    ↓
parseQuery() — 키워드 분석 → 검색 필드 매핑
    ↓
Playwright — KDSIS 페이지 자동 조작
    ↓
결과 파싱 → JSON → 채팅 UI에 테이블 표시
```

**핵심: 데이터를 저장하지 않음.** 매번 KDSIS를 실시간 조회합니다.

## 설치 및 실행

```bash
# 1. 의존성 설치
npm install

# 2. Playwright 브라우저 설치 (Chromium)
npm run setup

# 3. 서버 시작
npm start
```

브라우저에서 http://localhost:3000 접속

## 지원하는 자연어 검색 예시

| 입력 | 자동 매핑 |
|------|-----------|
| "K2 소총 규격서 찾아줘" | 적용장비명: "K2 소총" |
| "KDS 1005 검색" | 규격번호: "KDS 1005" |
| "국방기술품질원 제정 활성 규격" | 제정기관: "국방기술품질원", 규격상태: "활성" |
| "1005-01-570-0001 재고번호 조회" | 재고번호: "1005-01-570-0001" |
| "박격포 관련 규격" | 적용장비명 또는 규격서명: "박격포" |

## API

### POST /api/search
자연어 검색

```json
{ "query": "K2 소총 규격서 찾아줘" }
```

### POST /api/search/direct
필드 직접 지정 검색

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

## 결과 테이블 파싱 주의사항

현재 결과 테이블 파싱 로직(`server.js`의 `page.evaluate` 부분)은
KDSIS의 실제 결과 HTML 구조에 맞게 조정이 필요할 수 있습니다.

**조정 방법:**
1. 서버 실행 후 검색 실행
2. `/api/screenshot`에서 캡처 이미지 확인
3. KDSIS 결과 테이블의 실제 HTML 구조를 확인하여 셀렉터 수정

## 기술 스택

- **Backend:** Node.js + Express
- **브라우저 자동화:** Playwright (Chromium)
- **Frontend:** Vanilla HTML/CSS/JS
- **AI 파싱:** 규칙 기반 NLU (Claude API 연동 가능)

## 향후 확장

- [ ] Claude API 연동으로 자연어 파싱 정확도 향상
- [ ] 결과 테이블 셀렉터 KDSIS 실제 구조에 맞게 튜닝
- [ ] 검색 결과 내 문서(한글, 도면) 다운로드 링크 파싱
- [ ] 검색 이력 세션 관리 (저장하지 않음, 세션 중에만 유지)
