import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { configureProviders } from "../packages/providers/src/compatible.ts";
import { SessionStore } from "../apps/server/src/sessions.ts";
import { runReview } from "../apps/server/src/reviews.ts";

test("독립 검토는 승인한 내용만 한 번 보내며 실패·취소·재시작 후에도 원래 대화를 보존한다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-review-"));
  const path = join(dir, "state.sqlite");
  let db = new SessionStore(path);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = db.create();
  const first = randomUUID();
  db.begin(source, first, "원래 대화의 비공개 메모");
  db.append(first, "비공개 답변");
  db.finish(first, "completed");
  const original = db.turns(source.id);
  const body = {
    id: randomUUID(),
    approved: true,
    target: { provider: "custom", model: "fixture" },
    message: "이 문장만 검토",
  };
  let count = 0,
    fail = false;
  const adapters = configureProviders({ AGS_CUSTOM_BASE_URL: "http://localhost/v1" }, async (_url, init) => {
    count++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.messages.length, 2);
    assert.deepEqual(payload.messages[1], { role: "user", content: body.message });
    assert.ok(!JSON.stringify(payload).includes("비공개"));
    assert.equal(payload.max_tokens, 4096);
    if (fail) return new Response("", { status: 503 });
    return new Response('data: {"choices":[{"delta":{"content":"검토 의견"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const run = (input: unknown, signal = new AbortController().signal) =>
    runReview(db, source.id, input, adapters, signal);
  await assert.rejects(run(body), /review_disabled/);
  db.setCollaborationEnabled(true);
  await assert.rejects(
    runReview(db, source.id, body, { ...adapters, contextWindow: () => 4096 }, new AbortController().signal),
    /review_budget/,
  );
  await assert.rejects(run({ ...body, approved: false }), /invalid_review/);
  assert.equal(count, 0);
  const running = run(body);
  await assert.rejects(run({ ...body, id: randomUUID() }), /review_busy/);
  const review = await running;
  assert.ok(review);
  assert.notEqual(review.reviewer, source.id);
  assert.equal(review.reply, "검토 의견");
  assert.equal(db.get(review.reviewer)?.sectionId, null);
  assert.equal(db.turns(review.reviewer).length, 1);
  assert.equal((await run(body))?.id, body.id);
  await assert.rejects(run({ ...body, message: "다른 검토" }), /review_id_conflict/);
  assert.equal(count, 1);
  fail = true;
  const failed = { ...body, id: randomUUID() };
  await assert.rejects(run(failed), /provider_failed/);
  assert.equal(db.review(source.id, failed.id)?.status, "failed");
  assert.equal((await run(failed))?.status, "failed");
  const controller = new AbortController();
  const cancelled = { ...body, id: randomUUID(), target: { provider: "mock", model: "" } };
  const wait = run(cancelled, controller.signal);
  controller.abort();
  await assert.rejects(wait, /review_cancelled/);
  assert.equal(db.review(source.id, cancelled.id)?.status, "cancelled");
  const interrupted = randomUUID();
  db.startReview(source.id, interrupted, body.target as { provider: "custom"; model: string }, body.message);
  db.close();
  // A v4 database already contained standalone reviews, without a selection key.
  const old = new DatabaseSync(path);
  old.exec("DROP TRIGGER clear_checkpoints; ALTER TABLE checkpoints DROP COLUMN sectionId; ALTER TABLE sessions DROP COLUMN sectionRevision; DROP TABLE custom_presets; ALTER TABLE shared_prompt DROP COLUMN responseLanguage; ALTER TABLE reviews DROP COLUMN selectionKey; PRAGMA user_version=4");
  old.close();
  db = new SessionStore(path);
  assert.ok(db.reviewHistory(source.id).some(item => item.id === body.id));
  assert.equal(db.collaborationEnabled(), true);
  assert.equal(db.review(source.id)?.status, "interrupted");
  assert.deepEqual(await run(body), review);
  assert.deepEqual(db.turns(source.id), original);
});

test("검토는 현재 대화에서 선택한 스냅샷만 보내고 재시도와 이력을 독립적으로 복원한다", async (t) => {
  const db = new SessionStore(":memory:");
  t.after(() => db.close());
  const a = db.create(),
    b = db.create(),
    project = db.addProject("사료");
  const version = "b".repeat(64);
  const file = db.addReference(a.id, project, "notes.md", version, 1, 1, "승인된 파일 한 줄");
  const knowledge = db.addReference(
    a.id,
    project,
    "guide.md",
    version,
    2,
    2,
    "승인된 지식 한 줄",
    "knowledge",
  );
  const foreign = db.addReference(b.id, project, "other.md", version, 1, 1, "다른 대화의 메모");
  const extra = db.addReference(a.id, project, "long.md", version, 1, 1, "가".repeat(6000));
  assert.ok(file && knowledge && foreign && extra);
  const sent: string[] = [];
  const adapters = configureProviders({ AGS_CUSTOM_BASE_URL: "http://localhost/v1" }, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    sent.push(payload.messages[1].content);
    return new Response('data: {"choices":[{"delta":{"content":"검토 완료"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  db.setCollaborationEnabled(true);
  const request = {
    id: randomUUID(),
    target: { provider: "custom", model: "fixture" },
    approved: true,
    message: "두 기록 비교",
    referenceIds: [knowledge, file],
  };
  const run = (body: unknown) => runReview(db, a.id, body, adapters, new AbortController().signal);
  await assert.rejects(run({ ...request, referenceIds: [foreign] }), /review_reference_unavailable/);
  await assert.rejects(run({ ...request, referenceIds: [file, file] }), /invalid_review/);
  await assert.rejects(
    run({ ...request, message: "가".repeat(2000), referenceIds: [extra] }),
    /review_input_limit/,
  );
  db.setKnowledgeEnabled(false);
  await assert.rejects(run(request), /review_reference_unavailable/);
  assert.equal(sent.length, 0);
  db.setKnowledgeEnabled(true);
  const review = await run(request);
  assert.ok(review);
  assert.equal(
    sent[0],
    `두 기록 비교\n\n[지식 발췌 · 사료 / guide.md · 2–2줄 · 버전 ${version}]\n승인된 지식 한 줄\n\n[파일 발췌 · 사료 / notes.md · 1–1줄 · 버전 ${version}]\n승인된 파일 한 줄`,
  );
  assert.equal(review.message, sent[0]);
  db.removeReference(a.id, knowledge);
  db.setKnowledgeEnabled(false);
  assert.deepEqual(await run(request), review);
  assert.equal(sent.length, 1);
  await assert.rejects(run({ ...request, referenceIds: [file] }), /review_id_conflict/);
  await assert.rejects(run({ ...request, id: randomUUID() }), /review_reference_unavailable/);
  const next = await run({ ...request, id: randomUUID(), referenceIds: [], message: "다음 검토" });
  assert.ok(next);
  assert.deepEqual(
    db.reviewHistory(a.id).map((item) => item.reviewer),
    [next.reviewer, review.reviewer],
  );
  assert.deepEqual(db.reviewHistory(b.id), []);
  assert.equal(db.turns(review.reviewer)[0]?.message, sent[0]);
  assert.equal(db.turns(a.id).length, 0);
});
