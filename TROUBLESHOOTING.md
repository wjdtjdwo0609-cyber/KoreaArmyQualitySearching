# Troubleshooting

KoreaArmyQualitySearching은 국방기술품질원 데이터를 검색하는 Node/Playwright 기반 도구입니다. 검색 실패는 네트워크, 대상 사이트 DOM 변화, AI query parsing, 브라우저 자동화 문제로 나눠 확인합니다.

## 빠른 점검

```bash
npm install
npm run setup
npm test
npm run lint:syntax
npm start
```

AI 없이 기본 검색만 확인하려면:

```bash
npm run start:no-ai
```

## 자주 나는 문제

| 증상 | 확인할 것 | 해결 |
| --- | --- | --- |
| Chromium 실행 실패 | Playwright browser 설치 여부 | `npm run setup`으로 Chromium 재설치 |
| 검색이 timeout 됨 | 대상 사이트 응답, `KDSIS_SEARCH_TIMEOUT_MS`, 네트워크 | timeout 값을 늘리고 같은 검색어를 브라우저에서 직접 확인 |
| 결과가 항상 비어 있음 | 대상 사이트 DOM 변경, selector, 검색 파라미터 | `test/kdsis-search.test.js`와 raw debug output으로 selector 확인 |
| 자연어 검색이 이상함 | AI API key, query parser fallback | `npm run start:no-ai`로 규칙 기반 검색이 되는지 먼저 확인 |
| 서버 시작 실패 | `.env`, 포트, Node 버전 | 포트 사용 프로세스를 종료하거나 `PORT`를 변경 |

## 디버깅 순서

1. `npm run lint:syntax`로 문법 오류를 제거합니다.
2. `npm test`로 query/result formatting 단위 테스트를 확인합니다.
3. `npm run start:no-ai`로 AI 없이 검색 자동화만 확인합니다.
4. AI 검색이 필요하면 `.env`의 provider key를 로컬에서만 설정합니다.

## 이슈를 남길 때

- 검색어와 검색 모드
- timeout 값
- Node 버전
- 서버 로그
- Playwright 오류 메시지 또는 screenshot
