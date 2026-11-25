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
| error | `{"type":"error","code":"provider_failed"}` | 부분 텍스트와 실패 상태를 보존한다. 실행 시간 60초 초과 시 코드는 `timeout`이다. |

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

외부 공급자는 현재 프리셋 지침과 해당 세션의 최근 완료 턴 최대 12개, 현재 메시지를 받는다. 진행 중이거나 취소·실패한 턴은 제외한다. 동일 세션의 중복 요청은 409다. 401/403과 429는 각각 고정된 provider_auth와 provider_limit 스트림 오류로 변환한다. 로컬 접속 인증 실패는 기존 HTTP 401로 구분한다. 브라우저에서 주소와 API 키를 지정하는 경로는 없다.

SQLite는 WAL과 synchronous=NORMAL을 사용한다. 스트림은 즉시 전송하며, DB에는 150ms 또는 8KiB마다 모아 저장하고 모든 정상 종료·취소·오류 처리 시 남은 텍스트를 저장한다. 프로세스가 강제 종료되면 마지막 체크포인트 이후의 텍스트가 유실될 수 있다.
