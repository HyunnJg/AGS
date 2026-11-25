import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { chromium } from "playwright";

test(
  "브라우저에서 두 세션 생성·프리셋 선택·전송·중단 후 서버 재시작으로 복원",
  { timeout: 60_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ags-browser-"));
    const token = randomBytes(32).toString("hex");
    const browser = await chromium.launch({ executablePath: process.env.AGS_TEST_CHROMIUM || undefined });
    const fake = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            data: [
              { id: "ui/other-model", name: "First model" },
              { id: "ui/test-model", name: "Second model", context_length: 16384 },
            ],
          }),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(payload.model, "ui/test-model");
      assert.equal(payload.max_tokens, 123);
      assert.equal(payload.messages.length, 4);
      assert.match(payload.messages[0].content, /테스트 공용 지침\n- 실제 줄바꿈/);
      assert.deepEqual(
        payload.messages.slice(1).map((m) => m.content),
        [
          "장기기억 (참고 자료)\n유지할 메모",
          "오래 걸리는 요청",
          "검색·임베딩 자료 (참고 자료)\n찾아낸 자료",
        ],
      );
      assert.ok(payload.messages.slice(1).every((m) => m.role === "user"));
      assert.match(payload.messages[0].content, /테스트 공용 지침/);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"독립 세션 응답"}}]}\n\n');
      // The browser test controls when this active request is cancelled.
    });
    fake.listen(0, "127.0.0.1");
    await once(fake, "listening");
    t.after(() => {
      fake.close();
      fake.closeAllConnections();
    });
    let child;
    let closed;
    async function start(port) {
      child = spawn(process.execPath, ["dist/apps/server/src/main.js"], {
        env: {
          ...process.env,
          AGS_STATE_DIR: dir,
          AGS_PORT: String(port),
          AGS_LOCAL_TOKEN: token,
          AGS_OPENROUTER_API_KEY: "",
          AGS_OPENROUTER_MODEL: "",
          AGS_CUSTOM_MODEL: "ui/test-model",
          AGS_CUSTOM_API_KEY: "fixture-only",
          AGS_CUSTOM_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      closed = once(child, "close");
      const lines = createInterface({ input: child.stdout });
      const [line] = await Promise.race([
        once(lines, "line"),
        closed.then(() => {
          throw new Error("Server exited");
        }),
      ]);
      assert.match(line, /^AGS http:\/\/127\.0\.0\.1:\d+$/);
      return line.slice(4);
    }
    async function stop() {
      if (child) {
        child.kill();
        await closed;
        child = undefined;
      }
    }
    t.after(async () => {
      await browser.close();
      await stop();
      await rm(dir, { recursive: true, force: true });
    });
    const base = await start(0);
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(base);
    await page.getByLabel("로컬 인증 토큰").fill(token);
    await page.getByRole("button", { name: "작업실 열기" }).click();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "고급 기능" }).click();
    await page.getByText(dir, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "첫 대화 시작" }).click();
    await page.getByLabel("프리셋").selectOption("coding");
    await page.getByLabel("메시지").fill("첫 작업");
    await page.getByRole("button", { name: "전송" }).click();
    await page.getByText("[mock · coding] 수신한 메시지: 첫 작업", { exact: true }).waitFor();
    await page.getByRole("button", { name: "새 대화" }).click();
    await page.getByRole("heading", { name: "새 대화", exact: true }).waitFor();
    const long = "다음 작업 ".repeat(150);
    await page.getByLabel("메시지").fill(long);
    await page.getByRole("button", { name: "전송" }).click();
    await page.locator(".reply").filter({ hasText: /mock/ }).waitFor();
    await page.getByRole("button", { name: "중단" }).click();
    await page.getByText("중단됨", { exact: true }).waitFor();
    const partial = await page.locator(".reply").innerText();
    assert.ok(partial.length > 0 && partial.length < long.length);
    await stop();
    await start(new URL(base).port);
    await page.reload();
    await page.getByText("중단됨", { exact: true }).waitFor();
    assert.equal(await page.locator(".reply").innerText(), partial);
    assert.equal(await page.getByLabel("프리셋").inputValue(), "general");
    await page.getByRole("button", { name: "첫 작업", exact: true }).click();
    await page.getByText("[mock · coding] 수신한 메시지: 첫 작업", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("프리셋").inputValue(), "coding");
    assert.equal(await page.locator("article").count(), 1);
    await page.getByLabel("메시지").fill("오래 걸리는 요청");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "공용 프롬프트" }).click();
    await page.getByLabel("모든 대화의 공용 지침").fill("테스트 공용 지침\n- 실제 줄바꿈");
    await page.getByRole("button", { name: "현재 입력 위로" }).click();
    const otherEdit = await page.request.put(`${base}/api/settings/prompt`, {
      headers: { authorization: `Bearer ${token}` },
      data: { prompt: "다른 창의 지침", previous: "" },
    });
    assert.equal(otherEdit.status(), 200);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await page.getByRole("button", { name: "최신 내용 불러오기" }).click();
    await page.getByText("다른 창의 지침", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("모든 대화의 공용 지침").inputValue(),
      "테스트 공용 지침\n- 실제 줄바꿈",
    );
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector("dialog textarea")?.disabled &&
        document.querySelector("dialog button[type=submit]")?.disabled,
    );
    await page.getByRole("button", { name: "컨텍스트 제어" }).click();
    await page.getByLabel("최근 완료 대화 (턴)").fill("0");
    await page.getByLabel("최대 출력 토큰").fill("123");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await page.getByText("이 대화의 참고 자료", { exact: true }).click();
    await page.getByLabel("장기기억 메모").fill("유지할 메모");
    await page.getByLabel("검색·임베딩 자료 (직접 입력)", { exact: true }).fill("찾아낸 자료");
    const savedSources = page.waitForResponse(
      (r) => r.url().endsWith("/sources") && r.request().method() === "PUT" && r.status() === 200,
    );
    await page.getByRole("button", { name: "참고 자료 저장" }).click();
    await savedSources;
    await page.getByRole("button", { name: "전송 미리보기" }).click();
    await page.getByText(/포함된 대화 0턴/).waitFor();
    await page.getByText(/사용자 역할 메시지가 연속됩니다/).waitFor();
    await page.getByText("현재 입력", { exact: true }).click();
    await page.locator("pre").filter({ hasText: "오래 걸리는 요청" }).waitFor();
    await page.getByRole("button", { name: "공급사 · 모델" }).click();
    await page.getByRole("button", { name: "사용자 지정 API", exact: true }).click();
    await page.getByLabel("모델 검색").fill("Second");
    await page.getByRole("button", { name: "목록 새로고침" }).click();
    await page.getByRole("button", { name: /Second model/ }).click();
    await page.getByRole("button", { name: "ui/test-model 즐겨찾기" }).click();
    await page.locator('.pin[aria-pressed="true"]').waitFor();
    await page.getByRole("button", { name: "적용", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.match(await page.getByLabel("등록 모델 선택").inputValue(), /ui\/test-model/);
    const quick = page.getByLabel("등록 모델 선택");
    const switchModel = async (provider, model) => {
      const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && r.status() === 200);
      await quick.selectOption(JSON.stringify([provider, model]));
      await patched;
    };
    await switchModel("mock", "");
    await switchModel("custom", "ui/test-model");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByLabel("메시지").fill("오래 걸리는 요청");
    await page.getByRole("button", { name: "전송" }).click();
    await page.getByText("독립 세션 응답", { exact: true }).waitFor();

    await page.getByRole("button", { name: "설정", exact: true }).click();
    assert.ok(await page.getByRole("button", { name: "적용", exact: true }).isDisabled());
    await page.getByRole("button", { name: "고급 기능" }).click();
    await page.getByText(dir, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "＋ 새 대화", exact: true }).click();
    await page.getByRole("heading", { name: "새 대화", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "메시지" }).fill("별도 세션");
    await page.getByRole("button", { name: "전송" }).click();
    await page.getByText("[mock] 수신한 메시지: 별도 세션", { exact: true }).waitFor();
    await page.getByRole("button", { name: "첫 작업 · 응답 중", exact: true }).click();
    await page.getByRole("button", { name: "중단" }).click();
    await page.getByText("중단됨", { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel("등록 모델 선택").waitFor();
    assert.match(await page.getByLabel("등록 모델 선택").inputValue(), /ui\/test-model/);
    await page.getByText("독립 세션 응답", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.locator('.pin[aria-pressed="true"]').waitFor();
    assert.match(await page.getByRole("listitem").first().innerText(), /ui\/test-model/);
    assert.ok(await page.locator("dialog").evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "정규식", exact: true }).click();
    await page.getByRole("button", { name: "규칙 추가" }).click();
    await page.getByLabel("이름", { exact: true }).fill("응답 머리말");
    await page.getByLabel("패턴", { exact: true }).fill("수신한 (메시지)");
    await page.getByLabel("치환문", { exact: true }).fill("새 $1");
    await page.getByLabel("테스트 문장").fill("수신한 메시지");
    await page
      .getByLabel("치환 결과")
      .filter({ hasText: /^새 메시지$/ })
      .waitFor();
    const savedRules = page.waitForResponse(
      (r) => r.url().endsWith("/display-rules") && r.request().method() === "PUT" && r.ok(),
    );
    await page.getByRole("button", { name: "규칙 저장" }).click();
    await savedRules;
    await page.keyboard.press("Escape");
    const original = "[mock · coding] 수신한 메시지: 첫 작업";
    const displayed = "[mock · coding] 새 메시지: 첫 작업";
    await page.getByText(displayed, { exact: true }).waitFor();
    await page.getByRole("button", { name: "원문 보기" }).click();
    await page.getByText(original, { exact: true }).waitFor();
    await page.getByRole("button", { name: "치환 결과 보기" }).click();
    await page.getByText(displayed, { exact: true }).waitFor();
    await stop();
    await start(new URL(base).port);
    await page.reload();
    await page.getByText(displayed, { exact: true }).waitFor();
    const id = await page.evaluate(() => sessionStorage.getItem("ags-session"));
    const preview = await page.request.post(base + "/api/sessions/" + id + "/context-preview", {
      headers: { authorization: "Bearer " + token },
      data: {
        message: "원문 확인",
        limits: { turns: 1, inputBudget: null, outputBudget: null },
      },
    });
    assert.equal(preview.status(), 200);
    assert.ok((await preview.json()).messages.some((m) => m.role === "assistant" && m.content === original));
    // A worker that announces readiness but never answers exercises the deadline deterministically.
    await page.addInitScript(() => {
      window.Worker = class extends EventTarget {
        constructor() {
          super();
          setTimeout(() => this.onmessage?.({ data: { ready: true } }), 0);
        }
        postMessage() {}
        terminate() {}
      };
    });
    await page.reload();
    await page.getByText(/실행 시간을 초과했습니다/).first().waitFor();
    await page.getByText(original, { exact: true }).waitFor();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "정규식", exact: true }).click();
    await page.getByLabel("사용", { exact: true }).uncheck();
    const disabledRule = page.waitForResponse(
      (r) => r.url().endsWith("/display-rules") && r.request().method() === "PUT" && r.ok(),
    );
    await page.getByRole("button", { name: "규칙 저장" }).click();
    await disabledRule;
    await page.keyboard.press("Escape");
    await page.getByText(original, { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
  },
);
