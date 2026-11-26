import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connections } from "./connections.ts";
import { localPort } from "./port.ts";
import { createChatServer } from "./server.ts";
import { SessionStore } from "./sessions.ts";

function timeoutValue(raw: string | undefined, fallback: number) {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new Error("invalid_timeout");
  return n;
}

try {
  const port = localPort(process.env.AGS_PORT);
  const directory = resolve(process.env.AGS_STATE_DIR || join(homedir(), ".ags", "private"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const connections = new Connections(directory, process.env);
  const store = new SessionStore(join(directory, "sessions.sqlite"));
  const server = createChatServer(
    process.env.AGS_LOCAL_TOKEN ?? "",
    undefined,
    timeoutValue(process.env.AGS_IDLE_TIMEOUT_MS, 60_000),
    store,
    connections.adapters,
    { totalTimeoutMs: timeoutValue(process.env.AGS_TIMEOUT_MS, 600_000), stateDirectory: directory, connections },
  );
  server.once("error", () => {
    store.close();
    console.error("서버를 열 수 없습니다. 사용 중인 포트를 확인해 주세요.");
    process.exitCode = 1;
  });
  server.on("close", () => store.close());
  const shutdown = () => {
    server.stopStreams();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(`AGS http://127.0.0.1:${address.port}`);
  });
} catch {
  console.error("공급자 설정, 로컬 인증 토큰, 포트와 데이터 폴더의 사용 가능 여부를 확인해 주세요.");
  process.exitCode = 1;
}
