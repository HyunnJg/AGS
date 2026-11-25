import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../dist/apps/server/src/main.js", import.meta.url));
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 22 || (minor === 22 && patch < 3)) {
  console.error("Node.js 24.22.3 이상 24.x 버전을 설치하세요.");
  process.exit(1);
}
if (!existsSync(entry) || !existsSync(new URL("../dist/web/index.html", import.meta.url))) {
  console.error(
    "빌드가 필요합니다. 소스 폴더에서는 pnpm install --frozen-lockfile 및 pnpm build를 실행하세요.",
  );
  process.exit(1);
}

const check = process.argv.includes("--check");
const token = process.env.AGS_LOCAL_TOKEN || randomBytes(32).toString("hex");
const server = spawn(process.execPath, [entry], {
  cwd: root,
  env: { ...process.env, AGS_LOCAL_TOKEN: token },
  stdio: ["ignore", "pipe", "inherit"],
});
const lines = createInterface({ input: server.stdout });
let ready = false;
lines.once("line", async (line) => {
  const match = /^AGS (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
  if (!match) return server.kill();
  const url = match[1];
  try {
    const site = await fetch(url);
    const sessions = await fetch(`${url}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
    if (!site.ok || !(await site.text()).includes('id="root"') || !sessions.ok) throw new Error();
    if (check) {
      ready = true;
      console.log("AGS 패키지 실행 확인");
      server.kill();
      return;
    }
    if (spawnSync("clip.exe", [], { input: token, windowsHide: true }).status !== 0) throw new Error();
    ready = true;
    console.log(
      `작업실 ${url}\n로컬 토큰을 복사했습니다. 접속 화면에 붙여 넣으세요. 종료하려면 Ctrl+C를 누르세요.`,
    );
    const open = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      stdio: "ignore",
      windowsHide: true,
    });
    open.once("error", () => console.error("위 주소를 브라우저에서 여세요."));
  } catch {
    console.error("시작할 수 없습니다. 포트·웹 빌드·클립보드를 확인하세요.");
    server.kill();
  }
});
server.on("error", () => {
  console.error("Node 서버를 실행할 수 없습니다.");
  process.exitCode = 1;
});
server.on("exit", (code) => {
  process.exitCode = !ready ? 1 : check ? 0 : (code ?? 0);
});
process.on("SIGINT", () => server.kill());
process.on("SIGTERM", () => server.kill());
