import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceRead } from "../packages/contracts/src/workspace.ts";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { registerFolder } from "../apps/server/src/workspace-files.ts";
import { mockWorkspaceReply, searchPhrase } from "../apps/server/src/workspace-tools.ts";

test("mock 검색은 숨김 문서와 다른 형식을 제외하고 중단·줄 길이 제한을 지킨다", async t => {
  const path = await mkdtemp(join(tmpdir(), "ags-mock-read-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = await registerFolder(path, "");
  assert.equal(searchPhrase('“인용 문구” 확인'), "인용 문구");
  assert.throws(() => searchPhrase("가".repeat(121)), /invalid_tool_query/);
  await writeFile(join(path, ".private.txt"), "찾을 문구");
  await writeFile(join(path, "config.json"), "찾을 문구");
  const reads: WorkspaceRead[] = [];
  async function collect(onRead = (r: WorkspaceRead) => { reads.push(r); }, signal = new AbortController().signal) {
    const chunks = [];
    for await (const chunk of mockWorkspaceReply(root, "찾을 문구", () => signal.throwIfAborted(), onRead)) chunks.push(chunk);
    return chunks;
  }
  assert.match((await collect()).join(""), /찾지 못했습니다/);
  assert.equal(reads.length, 1);
  const file = join(path, "guide.md");
  await writeFile(file, "찾을 문구".padEnd(2100, "가"));
  await assert.rejects(collect(), /tool_result_limit/);
  assert.equal(reads.at(-1)?.failed, true);
  await writeFile(file, "찾을 문구");
  const abort = new AbortController();
  await assert.rejects(collect(r => {
    reads.push(r);
    if (r.tool === "search_workspace") abort.abort();
  }, abort.signal), { name: "AbortError" });
  const last = reads.at(-1);
  assert.ok(last?.tool === "read_file" && last.failed);
  assert.match(last.version, /^[a-f0-9]{64}$/);
});

test("로컬 원문은 대화에 보관하고 이후 모델 입력과 구간 요약에서는 제외한다", t => {
  const store = new SessionStore(":memory:");
  t.after(() => store.close());
  const project = store.addProject("테스트");
  const session = store.create();
  assert.ok(store.begin(session, "local", "문서 확인"));
  store.recordToolRead("local", project, 1, { tool: "read_file", path: "guide.md", version: "v", start: 1, end: 1 });
  store.append("local", "합성 원문");
  store.finish("local", "completed");
  assert.equal(store.turns(session.id)[0]?.reply, "합성 원문");
  assert.equal(store.history(session.id)[0]?.content, "문서 확인");
  assert.doesNotMatch(JSON.stringify(store.history(session.id)), /합성 원문/);
  assert.doesNotMatch(JSON.stringify(store.checkpointTurns(session.id, 1)), /합성 원문/);
});
