import { createChatServer } from "./server.ts";

try {
  const port = Number(process.env.AGS_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
  const server = createChatServer(process.env.AGS_LOCAL_TOKEN ?? "");
  server.once("error", () => {
    console.error("서버를 열 수 없습니다. 사용 중인 포트를 확인해 주세요.");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(`AGS http://127.0.0.1:${address.port}`);
  });
} catch {
  console.error("AGS_LOCAL_TOKEN과 AGS_PORT 설정을 확인해 주세요.");
  process.exitCode = 1;
}
