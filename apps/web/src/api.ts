import type { ChatEvent } from "../../../packages/contracts/src/chat.ts";

export async function api(token: string, path: string, method = "GET", value?: unknown) {
  const res = await fetch(path, {
    method,
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
    if (res.status === 422)
      throw new Error(
        "현재 메시지와 지침이 입력 예산을 넘습니다. 입력·출력 예산을 조정하거나 메시지를 줄여 주세요.",
      );
    if (res.status === 409 && path === "/api/settings/prompt")
      throw new Error("다른 창에서 공용 지침을 변경했습니다. 탭을 다시 열어 최신 값을 확인하세요.");
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
