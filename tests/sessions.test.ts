import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../apps/server/src/sessions.ts";

test("중복 활성 턴을 막고 비정상 종료된 턴의 부분 텍스트와 프리셋을 복원한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  const first = new SessionStore(path);
  const a = first.create();
  const b = first.create();
  first.setPreset(a.id, "coding");
  const configured = first.get(a.id);
  assert.ok(configured);
  assert.ok(first.begin(configured, "turn1", "첫 작업"));
  first.append("turn1", "받은 조각");
  assert.equal(first.begin(configured, "turn2", "중복"), false);
  assert.throws(() => new SessionStore(path));
  assert.equal(first.turns(a.id)[0]?.status, "streaming");
  first.close();
  const second = new SessionStore(path);
  try {
    assert.equal(second.get(a.id)?.preset, "coding");
    assert.equal(second.get(a.id)?.title, "첫 작업");
    assert.deepEqual(
      second.turns(a.id).map((row) => ({ ...row })),
      [
        {
          id: "turn1",
          message: "첫 작업",
          reply: "받은 조각",
          status: "interrupted",
          preset: "coding",
          provider: "mock",
          model: "",
        },
      ],
    );
    assert.deepEqual(second.turns(b.id), []);
    assert.ok(second.begin(configured, "turn3", "재개"));
  } finally {
    second.close();
  }
});
