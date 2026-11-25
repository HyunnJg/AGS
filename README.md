# AI General Staff (AGS)

여러 AI가 각자의 세션에서 작업하고, 필요할 때 같은 작업공간의 자료와 결과를 주고받는 개인용 로컬 작업환경입니다.

## 지금 실행할 수 있는 것

터미널과 로컬 HTTP 서버에서 mock 공급자에 메시지를 보낼 수 있습니다. HTTP에서는 응답이 조각 단위로 도착하며, 요청 하나를 중단해도 다른 요청은 계속됩니다. 브라우저에서 대화별로 프리셋을 선택하고, 앱을 다시 시작한 뒤에도 대화와 부분 응답을 이어서 확인할 수 있습니다.

## Windows에서 바로 열기

GitHub Actions에서 검증이 끝난 **Verify AGS** 실행의 **AGS-Windows** 아티팩트를 내려받아 ZIP 전체를 풀고 **Start-AGS.cmd**를 두 번 클릭하세요. Node.js 24.22.3 이상 24.x가 필요합니다. 화면 파일이 포함되어 pnpm 설치나 빌드는 생략할 수 있습니다. 서버가 준비되면 기본 브라우저가 열리고 로컬 접속 토큰이 클립보드로 복사됩니다. 토큰을 붙여 넣고 **작업실 열기 → 첫 대화 시작**을 선택하세요. 종료할 때는 콘솔에서 Ctrl+C를 누르세요.

키 없이 시작하면 로컬 mock으로 확인할 수 있습니다. 새 대화는 OpenRouter 키와 기본 모델이 함께 설정되어 있을 때 OpenRouter로 시작합니다. 기존 세션은 마지막으로 저장한 선택을 유지합니다.

### 실제 모델 연결

서버를 시작할 PowerShell에서 환경 변수를 설정한 뒤 같은 창에서 `.\Start-AGS.cmd`를 실행하세요. API 키는 서버 프로세스에서만 사용합니다.

| 공급자 | 서버 환경 변수 |
|---|---|
| OpenRouter | `AGS_OPENROUTER_API_KEY`와 선택 사항인 `AGS_OPENROUTER_MODEL` |
| 사용자 지정 OpenAI 호환 API | `AGS_CUSTOM_BASE_URL` (예: `http://127.0.0.1:8080/v1`), 선택 사항인 `AGS_CUSTOM_API_KEY`, `AGS_CUSTOM_MODEL` |

채팅 상단의 **모델 설정**에서 공급자를 선택하고 정확한 모델 ID를 입력한 뒤 **적용**하세요. 서버는 지정된 기본 URL 뒤에 `/chat/completions`를 붙입니다. 원격 주소는 HTTPS를 사용합니다. 메시지를 보내면 해당 세션의 최근 완료 대화 최대 12턴도 선택한 공급자로 전송됩니다. A 대화에서 응답이 진행 중이어도 B로 전환해 별도 요청을 보낼 수 있습니다.

## 설치와 첫 실행

Node.js 24.22.3과 pnpm 11.25.0을 사용합니다. Windows PowerShell과 Linux 셸에서 저장소 루트로 이동한 뒤 실행하세요.

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev "첫 작업 확인"
```

출력은 `[mock] 수신한 메시지: 첫 작업 확인`입니다. 인자를 생략하면 기본 예문으로 실행합니다.

## 웹 작업실 열기

위 설치를 마쳤다면 PowerShell에서 다음을 실행하세요. 로컬 접속용 토큰은 클립보드로 복사됩니다.

```powershell
pnpm build
$env:AGS_LOCAL_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('hex')"
Set-Clipboard -Value $env:AGS_LOCAL_TOKEN
pnpm server:start
```

브라우저에서 서버가 표시한 주소(기본 `http://127.0.0.1:4317`)를 열고 토큰을 붙여 넣으세요. **첫 대화 시작**을 누른 뒤 메시지를 보냅니다. Enter는 전송, Shift+Enter는 줄바꿈입니다. 긴 응답 도중 **중단**을 누르면 받은 부분이 저장됩니다. **새 대화**에서 다른 프리셋을 선택해 독립적으로 작업할 수 있습니다.

로컬 mock은 공급자 키 없이 프리셋과 응답 형식을 확인할 때 사용합니다. 브라우저는 로컬 토큰을 현재 탭의 sessionStorage에 보관합니다. 서버에서 토큰을 교체하면 새 값으로 다시 연결하세요.

대화 DB는 기본적으로 사용자 홈의 `.ags/private/sessions.sqlite`에 저장합니다. 다른 위치로 지정하려면 시작 전 `AGS_STATE_DIR`를 설정하세요. 한 데이터 폴더를 서버 하나가 사용하며, Ctrl+C로 종료합니다. 강제 종료된 응답은 다음 시작 시 받은 부분까지 복원하고 중단 상태를 표시합니다.

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
