import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(payload.max_tokens, 1200);
    if (fail) return new Response("", { status: 503 });
    return new Response('data: {"choices":[{"delta":{"content":"검토 의견"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const run = (input: unknown, signal = new AbortController().signal) =>
    runReview(db, source.id, input, adapters, signal);
  await assert.rejects(run(body), /review_disabled/);
  db.setCollaborationEnabled(true);
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
  db = new SessionStore(path);
  assert.equal(db.collaborationEnabled(), true);
  assert.equal(db.review(source.id)?.status, "interrupted");
  assert.deepEqual(await run(body), review);
  assert.deepEqual(db.turns(source.id), original);
});
