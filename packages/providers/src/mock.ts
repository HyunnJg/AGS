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

export async function* streamMock(prompt: string, signal: AbortSignal) {
  for (const text of mockReply(prompt)) {
    await delay(80, undefined, { signal });
    yield text;
  }
}
