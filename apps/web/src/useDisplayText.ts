import { useEffect, useState } from "react";
import { maxText, type DisplayRule } from "../../../packages/contracts/src/display.ts";

type Result = { text?: string; error?: string };
let worker: Worker | undefined;
let queue = Promise.resolve();
function execute(text: string, rules: DisplayRule[], signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.resolve({});
  return new Promise((resolve) => {
    const starting = !worker;
    const current = worker ?? new Worker(new URL("./display.worker.ts", import.meta.url), { type: "module" });
    worker = current;
    let timer: ReturnType<typeof setTimeout>;
    function finish(result: Result, terminate = false) {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      current.onmessage = null;
      current.onerror = null;
      if (terminate) {
        current.terminate();
        worker = undefined;
      }
      resolve(result);
    }
    function cancel() {
      finish({}, true);
    }
    function run() {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ error: "실행 시간을 초과했습니다." }, true), 250);
      try {
        current.postMessage({ text, rules });
      } catch {
        finish({ error: "치환 요청을 전달하지 못했습니다." }, true);
      }
    }
    signal.addEventListener("abort", cancel, { once: true });
    current.onerror = () => finish({ error: "치환 처리를 시작하지 못했습니다." }, true);
    current.onmessage = ({ data }) => {
      if (data.ready) run();
      else finish(data);
    };
    if (starting) timer = setTimeout(() => finish({ error: "치환 처리를 시작하지 못했습니다." }, true), 5000);
    else run();
  });
}

export function useDisplayText(text: string, rules: DisplayRule[], enabled: boolean) {
  const [result, setResult] = useState<{ input: string; rules: DisplayRule[]; value: Result }>();
  const active = enabled && rules.some((r) => r.enabled) && !!text;
  useEffect(() => {
    if (!active || text.length > maxText) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      queue = queue.then(async () => {
        if (controller.signal.aborted) return;
        const value = await execute(text, rules, controller.signal).catch(() => ({
          error: "치환 처리를 시작하지 못했습니다.",
        }));
        if (!controller.signal.aborted) setResult({ input: text, rules, value });
      });
    }, 40);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [text, rules, active]);
  if (active && text.length > maxText) return { text, error: "텍스트 길이 제한을 넘었습니다." };
  const current = active && result?.input === text && result.rules === rules ? result.value : undefined;
  return { text: current?.text ?? text, error: current?.error };
}
