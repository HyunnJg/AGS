import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceRead } from "../packages/contracts/src/workspace.ts";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { listToolEntries, registerFolder } from "../apps/server/src/workspace-files.ts";
import { mockWorkspaceReply, mockWorkspaceRequest } from "../apps/server/src/workspace-tools.ts";

test("mock 검색은 숨김 문서와 다른 형식을 제외하고 중단·줄 길이 제한을 지킨다", async t => {
  const path = await mkdtemp(join(tmpdir(), "ags-mock-read-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = await registerFolder(path, "");
  assert.deepEqual(mockWorkspaceRequest('“인용 문구” 확인'), { tool: "search_workspace", query: "인용 문구" });
  assert.throws(() => mockWorkspaceRequest("가".repeat(121)), /invalid_tool_query/);
  await writeFile(join(path, ".private.txt"), "찾을 문구");
  await writeFile(join(path, "config.json"), "찾을 문구");
  const reads: WorkspaceRead[] = [];
  async function collect(onRead = (r: WorkspaceRead) => { reads.push(r); }, signal = new AbortController().signal) {
    const chunks = [];
    for await (const chunk of mockWorkspaceReply(root, mockWorkspaceRequest("찾을 문구"), () => signal.throwIfAborted(), onRead)) chunks.push(chunk);
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

test("mock 폴더 목록은 지정한 폴더의 이름만 반환하고 건수·바이트·중단을 기록한다", async t => {
  const path = await mkdtemp(join(tmpdir(), "ags-mock-list-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = await registerFolder(path, "");
  const reads: WorkspaceRead[] = [];
  async function list(message: string, check = () => {}) {
    const chunks = [];
    for await (const text of mockWorkspaceReply(root, mockWorkspaceRequest(message), check, row => reads.push(row)))
      chunks.push(text);
    return chunks.join("");
  }
  await mkdir(join(path, "자료"));
  for (const name of ["dist", ".hidden", "node_modules"]) await mkdir(join(path, name));
  await writeFile(join(path, "settings.json"), "private");
  await writeFile(join(path, "INDEX.md"), "본문 생략 확인");
  const [heading, ...entries] = (await list("폴더 목록")).split("\n");
  assert.equal(heading, "폴더 목록 · 작업 폴더");
  assert.deepEqual(entries.sort(), ["INDEX.md", "자료/"]);
  assert.deepEqual(reads.at(-1), { tool: "list_entries", path: "", count: 2, limited: false });
  assert.match(await list('폴더 목록 "자료"'), /표시할 폴더나 문서가 없습니다/);
  assert.throws(() => mockWorkspaceRequest('폴더 목록 "dist"'), /invalid_tool_folder/);
  assert.deepEqual(mockWorkspaceRequest('“폴더 목록” 찾아줘'), { tool: "search_workspace", query: "폴더 목록" });
  for (let i = 0; i < 32; i++) await writeFile(join(path, "자료", `문서${i}.txt`), "내용");
  const listed = await list("폴더 목록 “자료”");
  assert.match(listed, /일부 항목만/);
  assert.equal(listed.split("\n").filter(line => line.endsWith(".txt")).length, 30);
  assert.deepEqual(reads.at(-1), { tool: "list_entries", path: "자료", count: 30, limited: true });
  const small = await listToolEntries(root, "자료", () => {}, 160);
  assert.ok(small.entries.length > 0 && small.entries.length < 30);
  assert.equal(small.limited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 160);
  let checks = 0;
  await assert.rejects(list("폴더 목록", () => { if (++checks === 2) throw new Error("중단"); }), /중단/);
  assert.deepEqual(reads.at(-1), { tool: "list_entries", path: "", failed: true });
});
