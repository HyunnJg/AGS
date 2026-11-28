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
  const empty = db.create();
  assert.ok(db.rename(empty.id, empty.title, "새 대화"));
  db.setSessionArchived(empty.id, true);
  db.begin(session, "turn-1", "지난 작업");
  db.append("turn-1", "초안 내용");
  db.reserveCheckpoint(session.id, "turn-1", "turn-1", "saved.md", "fixture-version");
  db.finishCheckpoint("saved.md", true);
  const profile = db.addPreset("실험", "Compare evidence.");
  db.setPreset(session.id, profile.id);
  db.setPresetArchived(profile.id, true);
  assert.ok(db.setResponseLanguage("en", "auto"));
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
    assert.equal(reopened.get(session.id)?.preset, profile.id);
    assert.equal(reopened.get(empty.id)?.archived, true);
    assert.ok(reopened.begin(empty, "fixed", "첫 메시지"));
    assert.equal(reopened.get(empty.id)?.title, "새 대화");
    const definition = reopened.presetContent(profile.id);
    assert.ok(typeof definition === "object");
    assert.deepEqual({...definition}, profile);
    assert.deepEqual(reopened.customPresets(), []);
    assert.deepEqual(reopened.customPresets(true), [{ id: profile.id, name: profile.name, archived: true }]);
    assert.equal(reopened.promptSettings().responseLanguage, "en");
    assert.equal(reopened.project(project)?.writeGrant, null);
    assert.equal(reopened.get(session.id)?.sectionId, sectionId);
    assert.equal(reopened.recentCheckpoints(sectionId)[0]?.path, "saved.md");
    assert.deepEqual(
      reopened.favorites().map((row) => ({ ...row })),
      [{ provider: "openai", model: "fixture-model" }],
    );
    assert.equal(reopened.turns(session.id)[0]?.reply, "초안 내용");
    assert.equal(reopened.turns(session.id)[0]?.status, "interrupted");
    reopened.changeSessionSection(session.id, null, sectionId, 0);
  } finally {
    reopened.close();
  }
  const detachedBackup = join(dir, "연결 해제.ags-backup");
  const detachedTarget = join(dir, "연결 해제 복원");
  assert.equal(spawnSync(process.execPath, ["scripts/state-backup.ts", "export", detachedBackup], {
    env: { ...process.env, AGS_STATE_DIR: target },
  }).status, 0);
  assert.equal(run("restore", detachedBackup, detachedTarget).status, 0);
  const detached = new SessionStore(join(detachedTarget, "sessions.sqlite"));
  try {
    assert.equal(detached.get(session.id)?.sectionId, null);
    assert.equal(detached.get(session.id)?.sectionRevision, 1);
    assert.equal(detached.recentCheckpoints(sectionId)[0]?.path, "saved.md");
  } finally {
    detached.close();
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
  const currentRows = `["table","custom_presets",["id","name","instructions","archived"]]\n["row",1,"${profile.id}","실험","Compare evidence.",1]\n`;
  const legacyRows = `["table","custom_presets",["id","name","instructions"]]\n["row",1,"${profile.id}","실험","Compare evidence."]\n`;
  assert.ok(payload.includes(currentRows));
  const archiveRows = `["table","archived_sessions",["session_id"]]\n["row",1,"${empty.id}"]\n`;
  assert.ok(payload.includes(archiveRows));
  // Before v11 these two tables each had one fewer column, including their data rows.
  let trimLast = false;
  const preSections = payload.split("\n").map(line => {
    if (!line) return line;
    const row = JSON.parse(line);
    if (row[0] === "table") {
      trimLast = row[1] === "sessions" || row[1] === "checkpoints";
      if (trimLast) row[2].pop();
    } else if (trimLast && row[0] === "row") row.pop();
    return JSON.stringify(row);
  }).join("\n");
  const v10 = preSections.replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,10]');
  const preArchive = preSections.replace(archiveRows, "");
  const v9 = preArchive.replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,9]');
  const v7 = preArchive.replace(currentRows, legacyRows).replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,7]');
  const v8 = preArchive.replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,8]');
  const prePresets = preArchive.replace(currentRows, "").replaceAll(profile.id, "general");
  const v5 = prePresets.replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,5]')
    .replace('["table","shared_prompt",["id","prompt","responseLanguage"]]\n["row",1,1,"","en"]',
      '["table","shared_prompt",["id","prompt"]]\n["row",1,1,"기존 공용 지침"]');
  const v6 = prePresets.replace(`["AGS-private-state",1,${sessionSchemaVersion}]`, '["AGS-private-state",1,6]');
  for (const [version, contents] of [[5, v5], [6, v6], [7, v7], [8, v8], [9, v9], [10, v10]] as const) {
    const legacyFile = join(dir, `v${version}.ags-backup`), legacyDir = join(dir, `v${version}-restored`);
    const digest = createHash("sha256").update(contents).digest("hex");
    writeFileSync(legacyFile, `${contents}${JSON.stringify(["sha256", digest])}\n`);
    const legacyRestore = run("restore", legacyFile, legacyDir);
    assert.equal(legacyRestore.status, 0, legacyRestore.stderr);
    const legacy = new SessionStore(join(legacyDir, "sessions.sqlite"));
    try {
      assert.equal(legacy.get(session.id)?.preset, version >= 7 ? profile.id : "general");
      assert.deepEqual(legacy.customPresets(), version === 7 ? [{ id: profile.id, name: profile.name }] : []);
      assert.equal(legacy.get(empty.id)?.archived, version >= 10);
      assert.equal(legacy.recentCheckpoints(sectionId)[0]?.path, "saved.md");
      assert.ok(legacy.begin(empty, "first", "이전 빈 대화의 첫 메시지"));
      assert.equal(legacy.get(empty.id)?.title, version >= 9 ? "새 대화" : "이전 빈 대화의 첫 메시지");
      assert.equal(legacy.prompt(), version === 5 ? "기존 공용 지침" : "");
      assert.equal(legacy.promptSettings().responseLanguage, version === 5 ? "auto" : "en");
      assert.equal(legacy.turns(session.id)[0]?.reply, "초안 내용");
    } finally {
      legacy.close();
    }
  }
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
