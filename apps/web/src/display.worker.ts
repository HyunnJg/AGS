import { transformReply } from "./displayTransform.ts";
import type { DisplayRule } from "../../../packages/contracts/src/display.ts";
self.onmessage = (event: MessageEvent<{ text: string; rules: DisplayRule[] }>) => {
  try {
    self.postMessage({ text: transformReply(event.data.text, event.data.rules) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "치환을 완료하지 못했습니다." });
  }
};
self.postMessage({ ready: true });
