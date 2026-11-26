import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connections } from "../apps/server/src/connections.ts";
import { SessionStore, sessionSchemaVersion } from "../apps/server/src/sessions.ts";

test("백업은 키와 쓰기 권한을 분리하고 새 폴더에 대화·설정·원본 사본을 복원한다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "기존 작업실"),
    target = join(dir, "새 작업실"),
    file = join(dir, "백업.ags-backup");
  mkdirSync(source);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/state-backup.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, AGS_STATE_DIR: source, AGS_LOCAL_TOKEN: "token-fixture" },
    });
  const db = new SessionStore(join(source, "sessions.sqlite"));
  const project = db.addProject("전시 준비");
  db.linkRoot(project, null, { path: dir, identity: "fixture" }, true);
  const sectionId = db.catalog().sections.find((section) => section.projectId === project)?.id;
  assert.ok(sectionId);
  assert.ok(db.project(project)?.writeGrant);
  const session = db.create({ provider: "mock", model: "" }, sectionId);
  db.begin(session, "turn-1", "지난 작업");
  db.append("turn-1", "초안 내용");
  db.setFavorite({ provider: "openai", model: "fixture-model" }, true);
  assert.notEqual(run("export", file).status, 0);
  assert.equal(existsSync(file), false);
  db.close();
  const original = `${randomUUID()}.bak`;
  mkdirSync(join(source, "backups"));
  writeFileSync(join(source, "backups", original), Buffer.from([239, 187, 191, 65, 13, 10]));
  writeFileSync(
    join(source, "connection-openai.json"),
    JSON.stringify({
      revision: 8,
      baseUrl: "https://api.openai.com/v1/",
      defaultModel: "fixture-model",
      source: "supplied",
      encrypted: "encrypted-fixture",
      key: "plaintext-fixture",
    }),
  );
  const exported = run("export", file);
  assert.equal(exported.status, 0, exported.stderr);
  const raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /plaintext-fixture|encrypted-fixture|token-fixture/);
  assert.notEqual(run("export", file).status, 0);
  assert.equal(readFileSync(file, "utf8"), raw);
  const restored = run("restore", file, target);
  assert.equal(restored.status, 0, restored.stderr);
  const reopened = new SessionStore(join(target, "sessions.sqlite"));
  try {
    assert.equal(reopened.catalog().projects.find((item) => item.id === project)?.name, "전시 준비");
    assert.equal(reopened.project(project)?.writeGrant, null);
    assert.equal(reopened.get(session.id)?.sectionId, sectionId);
    assert.deepEqual(
      reopened.favorites().map((row) => ({ ...row })),
      [{ provider: "openai", model: "fixture-model" }],
    );
    assert.equal(reopened.turns(session.id)[0]?.reply, "초안 내용");
    assert.equal(reopened.turns(session.id)[0]?.status, "interrupted");
  } finally {
    reopened.close();
  }
  const view = new Connections(target, {}).view("openai");
  assert.equal(view.defaultModel, "fixture-model");
  assert.equal(view.needsKey, true);
  assert.equal(view.hasKey, false);
  assert.deepEqual(
    readFileSync(join(target, "backups", original)),
    readFileSync(join(source, "backups", original)),
  );
  assert.notEqual(run("restore", file, target).status, 0);
  const bad = join(dir, "bad"),
    incomplete = join(dir, "미완성");
  const payload = raw.slice(0, raw.lastIndexOf('["sha256"'));
  const orphan = payload.replace(`"turn-1","${session.id}"`, '"turn-1","missing-session"');
  assert.notEqual(orphan, payload);
  for (const damaged of [
    raw.replace("초안 내용", "다른 내용"),
    payload,
    `${orphan + JSON.stringify(["sha256", createHash("sha256").update(orphan).digest("hex")])}\n`,
    raw.replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,999]'),
    raw.replace('["AGS-private-state",1,', '["AGS-private-state",99,'),
  ]) {
    writeFileSync(bad, damaged);
    assert.notEqual(run("restore", bad, incomplete).status, 0);
    assert.equal(existsSync(incomplete), false);
    assert.ok(!readdirSync(dir).some((name) => name.startsWith(".ags-restore-")));
  }
});
