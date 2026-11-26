export class SearchResultChanged extends Error {}
export class WriteConflict extends Error {}
export class SettingsConflict extends Error {
  constructor() {
    super("다른 창에서 설정이 바뀌었습니다. 최신 내용과 비교해 주세요.");
  }
}
import type { ChatEvent } from "../../../packages/contracts/src/chat.ts";

const workspaceMessages: Record<string, string> = {
  source_unavailable: "현재 연결 폴더에서 원본을 확인할 수 없습니다.",
  knowledge_disabled: "설정 → 토글형 모듈에서 외부 지식 참조를 켜면 지식 발췌를 추가할 수 있습니다.",
  reference_kind_conflict: "이 범위는 이미 다른 방식으로 첨부했습니다. 첨부 자료에서 뺀 뒤 다시 선택하세요.",
  review_reference_unavailable: "선택한 자료가 삭제됐거나 지식 참조가 꺼졌습니다. 첨부 목록을 다시 확인하세요.",
  review_input_limit: "발췌를 포함한 검토 요청을 8,000자 이내로 줄여 주세요.",
  invalid_review: "보낼 내용과 검토 모델을 확인하세요.",
  review_budget: "검토 내용이 대상 모델의 입력 예산을 넘습니다. 내용을 줄여 주세요.",
  review_busy: "이 대화에서 요청한 검토가 진행 중입니다.",
  review_id_conflict: "요청 내용이 변경됐습니다. 새 검토를 요청하세요.",
  review_cancelled: "검토가 중단됐거나 제한 시간을 넘었습니다.",
  review_disabled: "설정 → 토글형 모듈에서 AI 협업 허용을 켜세요.",
  review_target_unavailable: "선택한 검토 모델의 연결 설정을 확인하세요.",
  review_empty: "검토 모델이 빈 응답을 반환했습니다.",
  review_too_long: "검토 결과가 길이 제한을 넘었습니다.",
  checkpoint_too_long: "생성된 요약이 너무 깁니다. 다시 생성하세요.",
  checkpoint_busy: "이 대화의 구간 요약을 처리 중입니다.",
  no_checkpoint_turns: "아직 기록할 새 완료 턴이 없습니다.",
  checkpoint_disabled: "설정 → 토글형 모듈에서 작업기억 갱신을 켜세요.",
  checkpoint_model_changed: "대화 모델이 바뀌었습니다. 새로 열어 확인하세요.",
  checkpoint_changed: "다른 창에서 이 구간을 먼저 기록했습니다. 다음 구간을 확인하세요.",
  invalid_checkpoint: "폴더 연결과 요약 내용을 확인하고 초안을 다시 만드세요.",
  checkpoint_timeout: "요약 요청이 중단됐습니다. 다시 시도할 수 있습니다.",
  checkpoint_budget: "요약할 대화가 입력 예산을 넘습니다. 컨텍스트 제어에서 입력 예산 또는 모델을 확인하세요.",
  checkpoint_empty: "모델이 빈 요약을 반환했습니다. 다시 시도하세요.",
  provider_limit: "공급자 요청 한도에 도달했습니다.",
  provider_auth: "공급자 키와 접근 권한을 확인하세요.",
  provider_failed: "공급자가 요청을 완료하지 못했습니다. 모델 설정을 확인하세요.",
  search_cancelled: "검색이 중단됐습니다.",
  no_workspace_folder: "연결된 작업 폴더가 없습니다.",
  invalid_state_file: "첫 줄부터 전체가 보이는 80줄·6,000자 이내의 상태 파일을 선택하세요.",
  state_source_changed: "섹션의 지정 파일이 바뀌었습니다. 작업공간을 다시 열어 확인하세요.",
  invalid_search: "검색할 문구를 확인하세요.",
  reference_too_large: "6,000자 이하로 줄 범위를 좁혀 주세요. 화면에서 잘린 긴 줄은 첨부할 수 없습니다.",
  reference_limit: "대화에 첨부한 자료가 8개입니다. 기존 자료를 뺀 뒤 다시 첨부하세요.",
  write_disabled: "이 폴더는 읽기 전용입니다. 연결 폴더 변경에서 승인형 저장을 켜세요.",
  write_conflict: "원본 또는 폴더가 변경됐습니다. 최신 원본과 다시 비교하거나 새 파일 이름을 확인하세요.",
  invalid_proposal: "수정안이 만료됐거나 폴더 연결이 바뀌었습니다. 다시 비교하세요.",
  write_busy: "저장을 처리하고 있습니다. 잠시 후 확인하세요.",
  no_changes: "원본과 내용이 같습니다.",
  invalid_edit: "1 MiB 이하의 UTF-8 텍스트를 입력하세요.",
  write_pending: "저장 완료 기록이 없습니다. 현재 원본과 백업을 확인하세요.",
  write_failed: "파일을 저장하지 못했습니다. 파일 상태와 쓰기 권한을 확인하세요.",
  excluded_folder: "이 폴더는 기본 검색 범위에서 제외됩니다.",
  hardlink_not_supported: "하드링크 파일은 다른 경로와 내용을 공유해 열 수 없습니다.",
  search_result_changed: "검색 후 원본이 변경됐습니다. 다시 검색해 현재 줄을 확인하세요.",
  invalid_folder: "서버 PC에 있는 작업 폴더의 절대 경로를 입력하세요.",
  outside_workspace: "이 경로는 열 수 없습니다. 실제 작업 폴더와 접근 권한을 확인하세요.",
  path_unavailable: "경로를 찾을 수 없습니다. 폴더 연결과 파일 위치를 확인하세요.",
  file_too_large: "1 MiB를 넘는 파일은 미리볼 수 없습니다.",
  not_text: "UTF-8 텍스트 파일만 미리볼 수 있습니다.",
  folder_changed: "연결 폴더가 바뀌었습니다. 작업공간을 다시 열어 주세요.",
  file_changed: "읽는 동안 파일이 변경됐습니다. 다시 열어 주세요.",
  invalid_range: "표시할 줄 범위를 확인하세요.",
};

export function fileActivityError(code: string) {
  return workspaceMessages[code] ?? code;
}

export async function api(
  token: string,
  path: string,
  method = "GET",
  value?: unknown,
  signal?: AbortSignal,
) {
  const res = await fetch(path, {
    method,
    ...(signal && { signal }),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(value !== undefined && { "Content-Type": "application/json" }),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!res.ok) {
    if (res.status === 401) {
      sessionStorage.removeItem("ags-token");
      window.dispatchEvent(new Event("ags-unauthorized"));
      throw new Error("로컬 인증 토큰을 확인해 주세요.");
    }
    if (path.startsWith("/api/projects") || path.endsWith("/checkpoint") || path.endsWith("/review")) {
      const body = await res.json().catch(() => ({}));
      if (body.error === "write_conflict") throw new WriteConflict(workspaceMessages.write_conflict);
      if (body.error === "search_result_changed")
        throw new SearchResultChanged(workspaceMessages.search_result_changed);
      throw new Error(
        workspaceMessages[body.error] ?? `작업공간 요청을 완료하지 못했습니다 (HTTP ${res.status}).`,
      );
    }
    if (path.startsWith("/api/providers/")) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error === "provider_auth" ? workspaceMessages.provider_auth : "목록을 가져오지 못했습니다. 모델 ID를 직접 입력할 수 있습니다.");
    }
    if (path.startsWith("/api/settings/connections/")) {
      if (res.status === 409) throw new SettingsConflict();
      const { error } = await res.json().catch(() => ({}));
      if (error === "new_endpoint_key") throw new Error("주소가 바뀌었습니다. 새 키를 입력하거나 기존 키 제거를 선택하세요.");
      if (error === "invalid_connection_url") throw new Error("API 기본 주소를 확인하세요. 원격 서버는 HTTPS를 사용하세요.");
      if (error === "invalid_connection") throw new Error("모델 ID와 API 키에 공백이나 허용되지 않는 문자가 있는지 확인하세요.");
      throw new Error("연결 설정을 저장하거나 읽지 못했습니다. 서버의 사용자 계정과 저장 권한을 확인하세요.");
    }
    if (path === "/api/settings/presets" && res.status === 409)
      throw new Error("같은 이름의 프리셋이 있습니다. 다른 이름으로 저장하세요.");
    if (res.status === 422)
      throw new Error(
        "현재 메시지와 지침이 입력 예산을 넘습니다. 입력·출력 예산을 조정하거나 메시지를 줄여 주세요.",
      );
    if (
      res.status === 409 &&
      (path === "/api/settings/prompt" || path === "/api/settings/response-language" || path.endsWith("/sources") || path === "/api/settings/display-rules")
    )
      throw new SettingsConflict();
    if (res.status === 409) throw new Error("이 대화에서 응답이 진행 중입니다.");
    throw new Error(`요청을 완료하지 못했습니다 (HTTP ${res.status}).`);
  }
  return res;
}

export async function* chatEvents(res: Response): AsyncGenerator<ChatEvent> {
  if (!res.body) throw new Error("응답 본문이 없습니다.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) throw new Error("응답 형식을 읽을 수 없습니다.");
        const event: ChatEvent = JSON.parse(data.slice(6));
        yield event;
        if (event.type !== "delta") return;
        end = buffer.indexOf("\n\n");
      }
    }
    throw new Error("응답 연결이 끊겼습니다.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
