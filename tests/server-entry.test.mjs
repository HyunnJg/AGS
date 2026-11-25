import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/apps/server/src/main.js", import.meta.url));

test("빌드한 서버가 loopback에 바인딩하고 비밀값을 출력하지 않는다", { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "ags-entry-"));
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, AGS_PORT: "0", AGS_STATE_DIR: dir, AGS_LOCAL_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  t.after(async () => {
    child.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
    assert.ok(!output.includes(token));
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    closed.then(() => { throw new Error("서버가 시작 전에 종료됐습니다."); }),
  ]);
  const base = /^AGS (http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1];
  assert.ok(base);
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: "빌드 확인" }),
  });
  assert.equal(r.status, 200);
  const wire = await r.text();
  assert.match(wire, /빌드 확인/);
  assert.match(wire, /event: done\ndata: \{"type":"done"\}\n\n$/);
  assert.ok(!wire.includes(token));
});
