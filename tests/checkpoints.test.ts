import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointService } from "../apps/server/src/checkpoints.ts";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { loadCheckpoints } from "../apps/server/src/section-state.ts";
import { registerFolder } from "../apps/server/src/workspace-files.ts";
import { configureProviders } from "../packages/providers/src/compatible.ts";
import type { CheckpointDraft } from "../packages/contracts/src/checkpoints.ts";

test("체크포인트는 완료 턴 8개 단위로 전진하고 중복 승인과 발행 중단을 복구한다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ags-checkpoint-")),
    dir = join(base, "private"),
    folder = join(base, "demo");
  await mkdir(dir);
  await mkdir(folder);
  const database = join(dir, "test.sqlite");
  let db = new SessionStore(database);
  t.after(async () => {
    db.close();
    await rm(base, { recursive: true, force: true });
  });
  const project = db.addProject("전시"),
    section = db.addSection(project, "사료"),
    other = db.addSection(project, "사진");
  const session = db.create(undefined, section),
    root = await registerFolder(folder, dir);
  const service = new CheckpointService(),
    providers = configureProviders({});
  const run = (data: unknown) => service.run(db, session, data, providers, dir, new AbortController().signal);
  const draft = async () => (await run({ action: "draft", provider: "mock", model: "" })) as CheckpointDraft;
  const save = (d: CheckpointDraft) => run({ ...d, action: "save", approved: true });
  for (let i = 0; i < 10; i++) {
    const id = randomUUID();
    db.begin(session, id, `결정: 일정 ${i}`);
    db.append(id, "응답");
    db.finish(id, i === 1 ? "cancelled" : "completed");
  }
  db.linkRoot(project, null, root);
  await assert.rejects(draft(), /write_disabled/);
  db.linkRoot(project, root.path, root, true);
  const a = await draft();
  assert.equal(a.count, 8);
  assert.equal(a.sources[1]?.question, "결정: 일정 2");
  await assert.rejects(run({ ...a, action: "save", approved: false }), /invalid_checkpoint/);
  assert.equal(db.recentCheckpoints(section).length, 0);
  db.setUpdateMemoryEnabled(false);
  await assert.rejects(save(a), /checkpoint_disabled/);
  db.setUpdateMemoryEnabled(true);
  await save(a);
  await save(a);
  const file = await readFile(join(folder, a.path), "utf8");
  assert.match(file, /첫 턴/);
  assert.equal(db.recentCheckpoints(section).length, 1);
  assert.deepEqual(await loadCheckpoints(db, other), []);
  // Simulate shutdown between publishing the approved file and confirming its SQLite receipt.
  const entry = db.checkpoint(session.id, a.first);
  assert.ok(entry);
  db.close();
  const { DatabaseSync } = await import("node:sqlite");
  const edit = new DatabaseSync(database);
  edit.prepare("UPDATE checkpoints SET saved=0 WHERE path=?").run(a.path);
  edit.close();
  db = new SessionStore(database);
  const b = await draft();
  assert.equal(b.count, 1);
  assert.equal(db.checkpoint(session.id, a.first)?.saved, 1);
  // A reserved but never published file must not consume the range.
  db.reserveCheckpoint(session.id, b.first, b.last, b.path, entry.version);
  assert.equal((await draft()).first, b.first);
  await writeFile(join(folder, b.path), "별도 문서");
  await assert.rejects(save(b), /write_conflict/);
  assert.equal(await readFile(join(folder, b.path), "utf8"), "별도 문서");
  await writeFile(join(folder, a.path), "미확인 변경");
  assert.equal((await loadCheckpoints(db, section))[0]?.text, "");
  db.setMemoryEnabled(false);
  assert.deepEqual(await loadCheckpoints(db, section), []);
  db.linkRoot(project, root.path, null);
  db.linkRoot(project, null, root, true);
  await assert.rejects(save(b), /invalid_checkpoint/);
});
