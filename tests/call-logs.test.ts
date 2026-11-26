import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../apps/server/src/sessions.ts";

test("호출별 본문과 답변은 독립적으로 제한되며 비밀값 제거 후 재시작까지 유지된다", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "ags-logs-"));
  const path = join(folder, "sessions.sqlite");
  let db = new SessionStore(path);
  t.after(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });
  const start = () => db.startCall("chat", { provider: "custom", model: "fixture" }, null);
  const a = start(),
    b = start();
  assert.ok(a && b);
  a.protect("fixture-password");
  a.bytes(Buffer.from(`${"a".repeat(65533)}fix`));
  a.bytes(Buffer.from("ture-password"));
  a.answer("답".repeat(70000));
  b.answer("두 번째 호출");
  b.finish("cancelled");
  a.finish("timeout");
  const [first, second] = db.callDetails();
  assert.ok(first && second);
  assert.equal(first.bodyLimited, true);
  assert.ok(!first.body.endsWith("fix"));
  assert.equal(first.answerLimited, true);
  assert.equal(first.answer.length, 65536);
  assert.equal(second.answer, "두 번째 호출");
  assert.equal(second.status, "cancelled");
  assert.ok(!("body" in (db.callList()[0] ?? {})));
  db.setLogsEnabled(false);
  assert.equal(start(), undefined);
  db.close();
  db = new SessionStore(path);
  assert.equal(db.logsEnabled(), false);
  assert.equal(db.callDetails(first.id)[0]?.body, first.body);
  db.setLogsEnabled(true);
  for (let n = 0; n < 101; n++) start()?.finish("completed");
  assert.equal(db.callList().length, 100);
  assert.deepEqual(db.callDetails(first.id), []);
});
