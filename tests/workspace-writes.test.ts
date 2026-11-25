import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { registerFolder, readLines } from "../apps/server/src/workspace-files.ts";
import { workspaceWrite } from "../apps/server/src/workspace-writes.ts";
import type { WritePreview } from "../packages/contracts/src/workspace.ts";

test("승인된 수정의 원본 바이트를 백업하고 재승인·동시 수정·연결 해제를 구분한다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ags-approval-"));
  const state = join(base, "private"),
    folder = join(base, "project");
  await mkdir(state);
  await mkdir(folder);
  const db = new SessionStore(join(state, "sessions.sqlite"));
  t.after(async () => {
    db.close();
    await rm(base, { recursive: true, force: true });
  });
  const project = db.addProject("예제"),
    root = await registerFolder(folder, state),
    path = "작업.md";
  const run = (action: string, data: Record<string, unknown>) =>
    workspaceWrite(
      db,
      project,
      root,
      db.project(project)?.writeGrant ?? null,
      action,
      { root: root.path, path, ...data },
      state,
    );
  const propose = async (text: string, version: string | null) =>
    (await run("propose", { text, version })) as WritePreview;
  const approve = (proposal: WritePreview) => run("approve", { id: proposal.id, approved: true });
  const bytes = Buffer.from("\uFEFF첫 줄\r\nold\r\n끝\n");
  await writeFile(join(folder, path), bytes);
  const version = (await readLines(root, path, 1)).version;
  db.linkRoot(project, null, root);
  await assert.rejects(propose("new", version), /write_disabled/);
  db.linkRoot(project, root.path, root, true);
  const a = await propose("첫 줄\nnew\n끝\n", version),
    b = await propose("다른 내용", version);
  assert.deepEqual([a.removed, a.added], [["old"], ["new"]]);
  await assert.rejects(run("approve", { id: a.id }), /invalid_proposal/);
  assert.deepEqual(await readFile(join(folder, path)), bytes);
  await approve(a);
  await approve(a);
  assert.deepEqual(await readFile(join(state, "backups", `${a.id}.bak`)), bytes);
  assert.equal(await readFile(join(folder, path), "utf8"), "\uFEFF첫 줄\r\nnew\r\n끝\n");
  await assert.rejects(approve(b), /write_conflict/);
  assert.equal(db.fileActivity(project).filter((r) => r.action === "write" && !r.error).length, 1);
  const c = (await run("propose", { path: "new.md", version: null, text: "결과" })) as WritePreview;
  await writeFile(join(folder, "new.md"), "외부 생성");
  await assert.rejects(run("approve", { path: c.path, id: c.id, approved: true }), /write_conflict/);
  assert.equal(await readFile(join(folder, "new.md"), "utf8"), "외부 생성");
  const d = (await run("propose", { path: "fresh.md", version: null, text: "새 문서" })) as WritePreview;
  db.linkRoot(project, root.path, null);
  db.linkRoot(project, null, root, true);
  await assert.rejects(run("approve", { path: d.path, id: d.id, approved: true }), /invalid_proposal/);
  await assert.rejects(run("propose", { path: "../invalid", version: null, text: "x" }), /outside_workspace/);
});
