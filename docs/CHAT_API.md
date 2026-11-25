# 로컬 채팅 HTTP 계약

서버는 IPv4 loopback에 바인딩한다. 클라이언트는 서버와 같은 포트의 `127.0.0.1` 또는 `localhost`를 사용한다. 모든 요청에는 `Authorization: Bearer <AGS_LOCAL_TOKEN>`이 필요하다. 권장 토큰은 난수 32바이트의 16진수 문자열이다. 서버는 환경 변수로 받은 토큰을 시작 시 검사한다. 인증 실패 응답에는 고정 오류 코드만 들어간다.

브라우저 요청에 Origin이 있으면 요청의 HTTP 스킴·호스트·포트가 정확히 일치해야 한다. CLI처럼 Origin이 없는 요청은 유효한 토큰과 로컬 Host로 인증한다. 작업실은 Vite 빌드 후 Node 서버의 같은 포트에서 열며 브라우저가 상대 경로로 API를 호출한다. Host의 도메인은 대소문자를 구분하지 않는다.

## 요청과 응답

`POST /api/chat`에 `application/json`으로 `{"message":"안녕하세요"}`를 보낸다. 본문 한도는 UTF-8 기준 64 KiB다. 성공하면 HTTP 200, `Content-Type: text/event-stream`, `X-Request-ID`가 도착한다. 클라이언트는 fetch의 응답 본문을 읽고 빈 줄을 기준으로 SSE 프레임을 분리한다. 네트워크 청크 하나에는 프레임 일부 또는 여러 프레임이 들어갈 수 있다. 각 프레임의 data는 JSON이고 event 이름은 JSON의 type과 같다.

| 이벤트 | data 예 | 처리 |
|---|---|---|
| delta | `{"type":"delta","text":"안녕"}` | 현재 턴에 텍스트를 붙인다. |
| done | `{"type":"done"}` | 완료로 기록한다. |
| cancelled | `{"type":"cancelled"}` | 부분 텍스트를 보존하고 중단으로 기록한다. |
| error | `{"type":"error","code":"provider_failed"}` | 부분 텍스트와 실패 상태를 보존한다. 유휴 제한(기본 60초)이나 전체 제한(기본 10분)을 넘기면 코드는 `timeout`이다. |

살아 있는 연결에는 종료 이벤트 하나가 도착한다. 클라이언트가 먼저 연결을 닫으면 종료 이벤트를 전달할 수 없다. 사용자가 로컬에서 중단했으면 UI가 중단 상태를 기록하고, 예기치 않은 EOF는 통신 실패로 처리한다.

## 두 가지 중단 경로

- 스트림 연결을 유지하면서 `POST /api/chat/<X-Request-ID>/cancel`에 같은 인증을 보낸다. 서버는 진행 중인 요청에 중단 신호를 보내고 HTTP 204를 반환한다. 종료된 ID나 알 수 없는 ID는 HTTP 404다. 기존 스트림에는 cancelled가 도착한다.
- 원래 fetch의 AbortController를 중단하면 서버도 연결 종료를 감지해 해당 공급자를 중단한다. 다른 요청은 계속 진행한다. 공급자 어댑터는 전달받은 AbortSignal을 대기와 I/O에 연결하고 종료 시 자원을 정리해야 한다.

스트림 시작 전 오류는 JSON `{"error":"코드"}` 형태다. 본문·메시지 오류는 400, 토큰 오류는 401, Host·Origin 오류는 403, 미등록 경로는 404, 메서드 오류는 405, 본문 크기 초과는 413, 미지원 미디어 형식은 415를 반환한다.

## 세션 API

아래 경로는 모두 같은 Bearer 인증을 사용한다. `GET /`은 대화 내용이 없는 정적 앱 화면을 연다.

| 요청 | 결과 |
|---|---|
| GET /api/sessions | 최신 생성순 세션 목록 |
| POST /api/sessions | 일반 프리셋의 빈 세션 생성 (201) |
| GET /api/sessions/{id} | 세션 설정과 시간순 턴 기록 |
| PATCH /api/sessions/{id} | JSON의 preset 값 변경. 다음 턴부터 적용 |
| POST /api/sessions/{id}/chat | 기존 채팅 SSE 형식으로 응답하며 DB에 턴 저장. 같은 세션에서 응답 진행 중이면 409 |

세션 채팅의 X-Request-ID는 저장된 턴 ID와 같고, 중단은 기존 취소 경로를 사용한다. done은 completed, cancelled는 cancelled, error는 failed 상태로 저장한다. 비정상 종료 후에도 streaming으로 남은 턴은 다음 시작 시 interrupted로 복구한다. 개별 요청만 검증하는 기존 POST /api/chat은 기록 없이 사용할 수 있다.

## 공급자와 모델

인증된 GET /api/providers는 공급자 ID, 설정 여부와 기본 모델 ID를 반환한다. 세션 경로에 PATCH로 `{"provider":"custom","model":"my-model"}`을 보내면 다음 턴의 공급자와 모델을 바꾼다. 각 턴에는 시작 시 선택한 공급자와 모델이 기록된다. 기존 세션과 이력은 mock으로 복원한다.

외부 공급자는 고정 규약·공용 지침·프리셋, 해당 세션의 예산 안에 들어오는 최근 완료 턴(기본 최대 12개), 현재 메시지를 받는다. 진행 중이거나 취소·실패한 턴은 제외한다. 동일 세션의 중복 요청은 409다. 401/403과 429는 각각 고정된 provider_auth와 provider_limit 스트림 오류로 변환한다. 로컬 접속 인증 실패는 기존 HTTP 401로 구분한다. 브라우저에서 주소와 API 키를 지정하는 경로는 없다.

SQLite는 WAL과 synchronous=NORMAL을 사용한다. 스트림은 즉시 전송하며, DB에는 150ms 또는 8KiB마다 모아 저장하고 모든 정상 종료·취소·오류 처리 시 남은 텍스트를 저장한다. 프로세스가 강제 종료되면 마지막 체크포인트 이후의 텍스트가 유실될 수 있다.

### 설정 센터

인증된 `GET /api/providers/:id/models`는 설정된 공급자의 모델 ID, 이름, 제공된 경우 컨텍스트 길이를 반환한다. 정상 응답은 공급자별로 5분간 캐시한다. 조회 실패는 502이며 직접 모델 ID 적용은 계속 가능하다. `GET /api/settings/favorites`는 작업실의 고정 목록을 읽는다. `PUT`에 `{provider,model,pinned}`를 보내면 해당 항목만 변경한다. `GET /api/settings/runtime`은 유휴·전체 제한(ms)과 로컬 저장 폴더를 반환한다. 새 세션 생성 요청에 선택적으로 `{provider,model}`을 보내 첫 세션의 모델도 지정할 수 있다. 쓰기 실패 시 SSE 오류 코드는 `storage_failed`이다.

### 컨텍스트와 공용 지침

- `GET /api/sessions/{id}/context`와 `PUT`은 대화별 `{turns,inputBudget,outputBudget}`를 읽고 저장한다. 기존 대화의 기본값은 `{turns:12,inputBudget:null,outputBudget:null}`이다. 예산은 양의 정수이며 빈 한도는 null로 보낸다.
- `POST /api/sessions/{id}/context-preview`는 `{message,limits}`를 받아 실제 전송과 동일한 조립 코드로 메시지를 생성한다. 공급자 호출이나 대화 기록 쓰기는 없다. 이전 턴은 사용자·응답 쌍 단위로 포함한다. 입력량은 메시지별 UTF-8 바이트 수 + 8로 추정하며 공급자 사용량과 다를 수 있다. 모델 목록에서 해당 모델의 컨텍스트 길이를 알고 있으면 그 범위에서 지정 출력량을 예약한다. 필수 입력이 예산을 넘으면 미리보기의 `fits`는 false이며 전송은 422로 거절한다. 출력 한도는 설정된 경우에만 `max_tokens`로 전달한다.
- `GET /api/settings/prompt`는 `{prompt}`를 반환한다. `PUT`에 `{prompt,previous}`를 보내면 최대 4,000자의 전역 지침을 저장한다. 다른 창이 먼저 수정해 기존 값이 달라지면 409를 반환한다. 인증·접근 권한은 서버 측에서 별도로 검증한다.
- 모델 목록 GET에 `?refresh=1`을 붙이면 캐시 만료 전에도 공급자 목록을 다시 조회한다. 같은 공급자에 대한 동시 갱신은 하나의 요청을 공유한다.
