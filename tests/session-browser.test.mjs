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
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(payload.model, "ui/test-model");
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
    await page.getByRole("button", { name: "모델 설정" }).click();
    await page.getByLabel("공급자", { exact: true }).selectOption("custom");
    await page.getByRole("button", { name: "적용", exact: true }).click();
    await page.getByLabel("메시지").fill("오래 걸리는 요청");
    await page.getByRole("button", { name: "전송" }).click();
    await page.getByText("독립 세션 응답", { exact: true }).waitFor();

    await page.getByRole("button", { name: "＋ 새 대화", exact: true }).click();
    await page.getByRole("heading", { name: "새 대화", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "메시지" }).fill("별도 세션");
    await page.getByRole("button", { name: "전송" }).click();
    await page.getByText("[mock] 수신한 메시지: 별도 세션", { exact: true }).waitFor();
    await page.getByRole("button", { name: "첫 작업 · 응답 중", exact: true }).click();
    await page.getByRole("button", { name: "중단" }).click();
    await page.getByText("중단됨", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "모델 설정" }).waitFor();
    assert.match(await page.getByRole("button", { name: "모델 설정" }).innerText(), /ui\/test-model/);
    await page.getByText("독립 세션 응답", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(pageErrors, []);
  },
);
