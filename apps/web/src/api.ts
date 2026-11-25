export class SettingsConflict extends Error {
  constructor() {
    super("다른 창에서 설정이 바뀌었습니다. 최신 내용과 비교해 주세요.");
  }
}
import type { ChatEvent } from "../../../packages/contracts/src/chat.ts";

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
    if (path.startsWith("/api/projects")) {
      const messages: Record<string, string> = {
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
      const body = await res.json().catch(() => ({}));
      throw new Error(messages[body.error] ?? `작업공간 요청을 완료하지 못했습니다 (HTTP ${res.status}).`);
    }
    if (res.status === 422)
      throw new Error(
        "현재 메시지와 지침이 입력 예산을 넘습니다. 입력·출력 예산을 조정하거나 메시지를 줄여 주세요.",
      );
    if (
      res.status === 409 &&
      (path === "/api/settings/prompt" || path.endsWith("/sources") || path === "/api/settings/display-rules")
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
