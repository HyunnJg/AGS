import { setTimeout as delay } from "node:timers/promises";

/** A deterministic local fixture. No network calls or shared conversation state. */
export function* mockReply(prompt: string): Generator<string> {
  const message = prompt.trim();
  if (!message) {
    throw new Error("메시지를 입력해 주세요.");
  }
  yield "[mock] 수신한 메시지: ";
  yield message;
}

export async function* streamMock(prompt: string, signal: AbortSignal, preset?: string) {
  const [label = "", message = ""] = [...mockReply(prompt)];
  await delay(80, undefined, { signal });
  yield preset && preset !== "general" ? `[mock · ${preset}] 수신한 메시지: ` : label;
  const chars = Array.from(message);
  const chunkSize = preset ? Math.max(48, Math.ceil(chars.length / 100)) : chars.length || 1;
  for (let offset = 0; offset < chars.length; offset += chunkSize) {
    await delay(80, undefined, { signal });
    yield chars.slice(offset, offset + chunkSize).join("");
  }
}
