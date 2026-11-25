# AI General Staff (AGS)

여러 AI가 각자의 세션에서 작업하고, 필요할 때 같은 작업공간의 자료와 결과를 주고받는 개인용 로컬 작업환경입니다.

## 지금 실행할 수 있는 것

P0은 개발 기반입니다. 터미널에서 메시지를 보내면 로컬 mock 공급자가 받은 문장을 그대로 돌려줍니다. API 키와 유료 호출 없이 입력부터 출력까지 확인할 수 있습니다. 웹 채팅과 대화 저장은 P1에서 추가합니다.

## 설치와 첫 실행

Node.js 24.22.3과 pnpm 11.25.0을 사용합니다. Windows PowerShell과 Linux 셸에서 저장소 루트로 이동한 뒤 실행하세요.

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev "첫 작업 확인"
```

출력은 `[mock] 수신한 메시지: 첫 작업 확인`입니다. 인자를 생략하면 기본 예문으로 실행합니다.

## 검증과 빌드

```sh
pnpm run check
pnpm start "빌드 실행 확인"
```

`check`는 린트, 타입 검사, 자동 테스트, 빌드를 순서대로 실행합니다. `start`는 빌드된 JavaScript를 실행합니다. GitHub Actions에서도 Windows와 Linux에 같은 절차를 적용합니다.

## 작업을 이어갈 때

- [최초 설계도](docs/DESIGN.md)에는 UX, 공유 데이터와 비공개 상태의 경계, 단계별 완료 조건이 있습니다. 문서 안의 AI Workspace는 AGS의 설계 당시 가칭입니다.
- [개발 로드맵](docs/ROADMAP.md)에는 이번 구현 범위와 다음 PR의 인수 조건이 있습니다.
- [작업 규약](AGENTS.md)에는 개발 명령과 리뷰 기준이 있습니다.
