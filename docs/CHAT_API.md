# 로컬 채팅 HTTP 계약

서버는 IPv4 loopback에 바인딩한다. 클라이언트는 서버와 같은 포트의 `127.0.0.1` 또는 `localhost`를 사용한다. 모든 요청에는 `Authorization: Bearer <AGS_LOCAL_TOKEN>`이 필요하다. 권장 토큰은 난수 32바이트의 16진수 문자열이다. 서버는 환경 변수로 받은 토큰을 시작 시 검사한다. 인증 실패 응답에는 고정 오류 코드만 들어간다.

브라우저 요청에 Origin이 있으면 요청의 HTTP 스킴·호스트·포트가 정확히 일치해야 한다. CLI처럼 Origin이 없는 요청은 유효한 토큰과 로컬 Host로 인증한다. #3 UI 개발 서버는 동일 출처의 경로로 연결한다.

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
