/** A deterministic local fixture. No network calls or shared conversation state. */
export function* mockReply(prompt: string): Generator<string> {
  const message = prompt.trim();
  if (!message) {
    throw new Error("메시지를 입력해 주세요.");
  }
  yield "[mock] 수신한 메시지: ";
  yield message;
}
