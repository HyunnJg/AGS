import assert from "node:assert/strict";
import test from "node:test";
import { parseReplyMarkdown, replyLink } from "../apps/web/src/replyMarkdown.ts";

test("답변 서식은 평문을 보존하고 절대 HTTP(S) 링크만 연다", () => {
  assert.equal(parseReplyMarkdown("일반 답변"), null);
  assert.equal(parseReplyMarkdown(`# ${"가".repeat(65536)}`), null);
  assert.equal(parseReplyMarkdown("## 제목")?.[0]?.type, "heading");
  const raw = parseReplyMarkdown("<script type=text/plain>sample</script>")?.[0];
  assert.equal(raw?.type, "html");
  assert.equal(raw?.raw, "<script type=text/plain>sample</script>");
  assert.equal(parseReplyMarkdown(`${"|열".repeat(200)}|\n${"|---".repeat(200)}|\n${"|값|\n".repeat(200)}`), null);
  for (const href of ["/api/sessions", "//example.org", "javascript:void(0)", "data:text/plain,test"]) {
    assert.equal(replyLink(href), undefined);
  }
  assert.equal(replyLink("https://example.org/a"), "https://example.org/a");
});
