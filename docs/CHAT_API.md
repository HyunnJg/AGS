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
- `GET /api/settings/prompt`는 `{prompt,order}`를 반환한다. `PUT`에 `{prompt,previous}`를 보내면 최대 4,000자의 전역 지침을 저장한다. 다른 창이 먼저 수정해 기존 값이 달라지면 409를 반환한다. 순서도 변경할 때는 기존 previous와 함께 order 및 previousOrder를 보낸다. memory, history, retrieval, input을 각각 한 번 포함해야 하며 지침과 순서는 함께 저장한다. 인증·접근 권한은 서버 측에서 별도로 검증한다.
- `GET /api/sessions/{id}/sources`와 `PUT`은 세션별 수동 참고 자료 `{memory,retrieval,revision}`를 읽고 저장한다. 저장할 때 읽은 revision이 달라지면 409다. 각 자료는 최대 6,000자이다. 참고 자료는 user 역할로 전달하고, 완료 턴은 원래 역할로 전달한다.
- 미리보기의 blocks는 messages와 같은 순서의 출처 목록이다. 고정 지침과 현재 입력의 예산을 먼저 확보하고 남은 예산을 설정 순서대로 사용한다. 빈 블록은 생략하며, excluded는 예산 때문에 일부 또는 전부 생략된 블록이다.
- 모델 목록 GET에 `?refresh=1`을 붙이면 캐시 만료 전에도 공급자 목록을 다시 조회한다. 같은 공급자에 대한 동시 갱신은 하나의 요청을 공유한다.

### 답변 표시 규칙

인증된 `GET /api/settings/display-rules`는 작업실 공통 설정 `{revision,rules}`를 반환한다. 기본 규칙은 빈 배열이다. `PUT`으로 읽은 revision과 규칙 배열을 보내면 순서대로 저장하고 새 revision을 반환한다. 각 규칙은 `{id,name,enabled,pattern,flags,replacement}`로 구성한다. 문법 오류·중복 ID·개수 초과는 400, 동시 편집 충돌은 409다. 브라우저는 응답이 끝난 뒤 표시할 때만 치환한다.

### 프로젝트와 읽기 전용 파일

모든 경로는 로컬 토큰을 요구한다. 프로젝트와 섹션 ID는 서버가 발급한다.

| 요청 | 동작 |
|---|---|
| `GET /api/projects` | 프로젝트와 섹션 목록. 프로젝트에는 연결한 서버 폴더의 절대 경로 또는 null을 포함한다. |
| `POST /api/projects`, `POST /api/projects/{id}/sections` | `{name}`으로 생성하고 `{id}`를 반환한다. 프로젝트와 기본 ‘일반’ 섹션은 함께 생성한다. |
| `PUT /api/projects/{id}/root` | `{path,previous}`로 로컬 폴더를 연결한다. path가 null이면 연결을 해제하고, 기존 경로가 previous와 다르면 409를 반환한다. |
| `POST /api/projects/{id}/entries` | `{path,offset?}`으로 목록을 최대 100개와 다음 offset으로 반환한다. path는 등록 폴더 기준이며 빈 문자열은 최상위다. |
| `POST /api/projects/{id}/attach` | `{session,root,path,version,start,end}`로 사용자가 확인한 줄 범위를 대화에 첨부한다. file 응답의 version이 현재 텍스트와 달라지면 409다. 최대 80줄·6,000자이고 화면에서 잘린 줄은 제외해야 한다. 같은 대화·프로젝트·경로·버전·범위의 재요청은 같은 id를 반환한다. |
| `GET /api/sessions/{id}/references` | 해당 대화에 저장한 발췌 목록과 본문을 반환한다. 대화마다 8개까지 저장한다. |
| `DELETE /api/sessions/{id}/references/{refId}` | 해당 대화에서 발췌를 빼고 남은 목록을 반환한다. |
| `GET /api/projects/{id}/activity` | 프로젝트의 최근 파일 조회 활동 최대 100건을 최신순으로 반환한다. time은 Unix 밀리초다. 완료한 요청에는 action·상대 path·해당 시 start/end 줄, 실패한 요청에는 action·오류 코드가 남는다. 검색어·발췌·본문은 저장하지 않는다. |
| `POST /api/projects/{id}/search` | `{path,query,root?,caseSensitive?}`로 하위 UTF-8 파일에서 1~120자의 한 줄 문구를 찾는다. hits에는 상대 경로·줄 번호·일치 주변 발췌·텍스트 버전이 포함된다. 기존 호출과의 호환을 위해 API는 caseSensitive 생략 시 true이며, 화면은 기본 false를 보낸다. files는 검색한 파일 수, skipped는 읽지 못해 건너뛴 항목 수다. |
| `POST /api/projects/{id}/file` | `{path,start?}`로 1부터 시작하는 UTF-8 줄 범위를 읽는다. 검색 결과의 version을 함께 보내면 텍스트가 변경된 경우 409를 반환한다. 최대 1 MiB, 80줄이고 한 줄이 2,048자를 넘으면 clipped가 true다. |
| `POST /api/sessions` | 기존 형식에 sectionId를 추가할 수 있다. sectionId만 전달하면 일반 새 대화와 같은 공급자 기본값을 쓴다. |

목록과 파일 읽기 요청에도 화면에서 확인한 root를 함께 보낼 수 있다. 연결이 바뀌면 409를 반환한다. 링크, 장치 파일, 운영체제의 최상위 폴더, 서버 비공개 상태 폴더와 겹치는 루트는 파일 도구의 범위에서 제외한다. 단순 조회는 모델 입력을 바꾸지 않는다. 사용자가 첨부한 발췌는 대화의 로컬 DB에 보관하고, 다음 요청 조립 시 retrieval 위치에서 수동 참고 자료 뒤에 각각 user 역할로 포함한다. 입력 예산에 들어가지 않는 발췌는 통째로 제외한다. 활동 기록에는 본문이 저장되지 않는다.

검색은 요청당 최대 1,500개 디렉터리 항목, 파일 읽기 시도 200개, 파일 본문 합계 8 MiB, 일치한 줄 50개로 제한한다. 한도 때문에 탐색이 일찍 끝나면 limited가 true다. `.git`, `node_modules`, `dist` 디렉터리와 링크는 탐색에서 제외한다.
