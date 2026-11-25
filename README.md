# AI General Staff (AGS)

여러 AI가 각자의 세션에서 작업하고, 필요할 때 같은 작업공간의 자료와 결과를 주고받는 개인용 로컬 작업환경입니다.

## 지금 실행할 수 있는 것

터미널과 로컬 HTTP 서버에서 mock 공급자에 메시지를 보낼 수 있습니다. HTTP에서는 응답이 조각 단위로 도착하며, 요청 하나를 중단해도 다른 요청은 계속됩니다. 웹 채팅 화면과 세션 저장은 다음 단계입니다.

## 설치와 첫 실행

Node.js 24.22.3과 pnpm 11.25.0을 사용합니다. Windows PowerShell과 Linux 셸에서 저장소 루트로 이동한 뒤 실행하세요.

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev "첫 작업 확인"
```

출력은 `[mock] 수신한 메시지: 첫 작업 확인`입니다. 인자를 생략하면 기본 예문으로 실행합니다.

## 로컬 채팅 서버 실행

Windows PowerShell에서 아래 세 줄을 실행하면 같은 셸에 임시 토큰을 두고 서버를 시작한 뒤 첫 응답을 확인할 수 있습니다.

```powershell
$env:AGS_LOCAL_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('hex')"
$agsServer = Start-Process node -ArgumentList 'apps/server/src/main.ts' -NoNewWindow -PassThru
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4317/api/chat -Headers @{ Authorization = "Bearer $env:AGS_LOCAL_TOKEN" } -ContentType 'application/json' -Body '{"message":"hello"}'
```

서버가 주소를 출력한 뒤 마지막 줄을 실행하세요. 종료할 때는 `Stop-Process -Id $agsServer.Id`를 사용합니다.

Linux 셸에서는 다음과 같이 실행합니다.

```sh
export AGS_LOCAL_TOKEN="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"
node apps/server/src/main.ts &
ags_pid=$!
# 서버 주소가 출력된 후 요청합니다.
curl -N http://127.0.0.1:4317/api/chat -H "Authorization: Bearer $AGS_LOCAL_TOKEN" -H 'Content-Type: application/json' -d '{"message":"hello"}'
kill "$ags_pid"
```

전경 실행 명령은 `pnpm server`이며, 빌드 후에는 `pnpm server:start`를 사용할 수 있습니다. 기본 포트는 4317입니다. 포트를 변경할 때는 `AGS_PORT`를 지정하고 클라이언트 주소에도 적용하세요. 브라우저 연동과 요청 중단 방법은 [채팅 HTTP 계약](docs/CHAT_API.md)에 있습니다.

## 검증과 빌드

```sh
pnpm run check
pnpm start "빌드 실행 확인"
```

`check`는 린트, 타입 검사, 자동 테스트, 빌드, 빌드한 서버의 실제 HTTP 왕복 테스트를 순서대로 실행합니다. `start`는 빌드된 JavaScript를 실행합니다. GitHub Actions에서도 Windows와 Linux에 같은 절차를 적용합니다.

## 작업을 이어갈 때

- [최초 설계도](docs/DESIGN.md)에는 UX, 공유 데이터와 비공개 상태의 경계, 단계별 완료 조건이 있습니다. 문서 안의 AI Workspace는 AGS의 설계 당시 가칭입니다.
- [개발 로드맵](docs/ROADMAP.md)에는 이번 구현 범위와 다음 PR의 인수 조건이 있습니다.
- [작업 규약](AGENTS.md)에는 개발 명령과 리뷰 기준이 있습니다.
