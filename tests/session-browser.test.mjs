import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const preview = await page.request.post(`${base}/api/sessions/${id}/context-preview`, {
      headers: { authorization: `Bearer ${token}` },
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
    await page
      .getByText(/실행 시간을 초과했습니다/)
      .first()
      .waitFor();
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
    const folder = await mkdtemp(join(tmpdir(), "ags-project-ui-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const notes = Array.from({ length: 82 }, (_, i) => `근거 ${i + 1}`).join("\n");
    await writeFile(join(folder, "INDEX.md"), notes);
    await writeFile(join(folder, "tags.txt"), "TokenLookup");
    const openWorkspace = () => page.getByRole("button", { name: "프로젝트 · 파일" }).click();
    await openWorkspace();
    await page.getByLabel("프로젝트 이름").fill("역사 자료");
    await page.getByRole("button", { name: "프로젝트 만들기" }).click();
    await page.getByText("새 섹션", { exact: true }).click();
    await page.getByLabel("섹션 이름").fill("사료 검토");
    await page.getByRole("button", { name: "섹션 만들기" }).click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("dialog select")).some(
        (s) => s.selectedOptions[0]?.text === "사료 검토",
      ),
    );
    await page.getByLabel("작업 폴더 절대 경로").fill(`  "${folder}"  `);
    await page.getByRole("button", { name: "읽기 전용 연결" }).click();
    await page.getByRole("button", { name: "INDEX.md" }).click();
    await page.getByText("1–80 / 82줄").waitFor();
    await page.getByRole("button", { name: "다음 줄" }).click();
    await page.getByText("81–82 / 82줄").waitFor();
    assert.equal(await page.locator(".file-browser pre").innerText(), "근거 81\n근거 82");
    await page.getByText("파일 내용 검색", { exact: true }).click();
    await page.getByLabel("검색 문구").fill("근거 82");
    await page.getByRole("button", { name: "검색", exact: true }).click();
    await page.getByRole("button", { name: /INDEX.md · 82줄/ }).click();
    await page.getByText("82–82 / 82줄").waitFor();
    assert.equal(await page.locator(".file-browser pre").innerText(), "근거 82");
    await writeFile(join(folder, "INDEX.md"), `추가한 첫 줄\n${notes}`);
    await page.getByText("파일 내용 검색", { exact: true }).click();
    await page.getByRole("button", { name: /INDEX.md · 82줄/ }).click();
    await page.getByText(/검색 후 원본이 변경됐습니다/).waitFor();
    await page.getByRole("button", { name: "최신 파일 1줄부터 열기" }).click();
    await page.getByText("1–80 / 83줄").waitFor();
    assert.ok((await page.locator(".file-browser pre").innerText()).startsWith("추가한 첫 줄"));
    await page.getByText("파일 내용 검색", { exact: true }).click();
    await page.getByRole("button", { name: "검색", exact: true }).click();
    await page.getByRole("button", { name: /INDEX.md · 83줄/ }).click();
    await page.getByText("83–83 / 83줄").waitFor();
    await page.getByRole("button", { name: "섹션에서 새 대화" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByText("역사 자료 / 사료 검토", { exact: true }).waitFor();
    await page.getByLabel("메시지").fill("연표 확인");
    await page.getByRole("button", { name: "전송" }).click();
    await page.getByText("[mock] 수신한 메시지: 연표 확인", { exact: true }).waitFor();
    await stop();
    await start(new URL(base).port);
    await page.reload();
    await openWorkspace();
    await page.getByRole("dialog").getByRole("button", { name: "연표 확인" }).waitFor();
    assert.equal(await page.getByLabel("섹션 선택").locator("option:checked").innerText(), "사료 검토");
    await page.getByRole("button", { name: "INDEX.md" }).waitFor();
    assert.equal(
      await page.getByRole("dialog").getByRole("button", { name: "첫 작업", exact: true }).count(),
      0,
    );
    const projectId = await page.getByLabel("프로젝트 선택").inputValue();
    const projectPath = `${base}/api/projects/${projectId}`;
    const headers = { authorization: `Bearer ${token}` };
    // Resize the open mobile dialog and edit a chat draft with the desktop panel still open.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() =>
      document.querySelector("#project-workspace")?.matches("[open]:not(:modal)"),
    );
    const panel = page.getByRole("dialog", { name: "프로젝트 · 파일" });
    const chat = page.getByLabel("메시지");
    await panel.getByRole("button", { name: "INDEX.md", exact: true }).click();
    await panel.getByText("1–80 / 83줄").waitFor();
    const sessionId = await page.evaluate(() => sessionStorage.getItem("ags-session"));
    const refPath = `${base}/api/sessions/${sessionId}/references`;
    const refs = async () => await (await page.request.get(refPath, { headers })).json();
    assert.deepEqual(await refs(), []);
    await panel.getByLabel("첨부 시작 줄").fill("2");
    await panel.getByLabel("첨부 끝 줄").fill("3");
    await panel.getByRole("button", { name: "현재 대화에 첨부" }).click();
    await panel.getByText("2–3줄을 첨부했습니다.", { exact: true }).waitFor();
    assert.deepEqual(
      (await refs()).map((r) => [r.path, r.start, r.end, r.text]),
      [["INDEX.md", 2, 3, "근거 1\n근거 2"]],
    );
    await page.getByText("첨부 자료 1개", { exact: true }).click();
    await page.locator(".attached-references pre").filter({ hasText: "근거 2" }).waitFor();
    const previewRefs = async () =>
      await (
        await page.request.post(`${base}/api/sessions/${sessionId}/context-preview`, {
          headers,
          data: { message: "자료 확인", limits: { turns: 0, inputBudget: null, outputBudget: null } },
        })
      ).json();
    assert.ok(
      (await previewRefs()).messages.some((m) => m.role === "user" && m.content.endsWith("근거 1\n근거 2")),
    );
    // The file moved on after preview. A fresh attachment needs a fresh version, while the earlier snapshot stays intact.
    await writeFile(join(folder, "INDEX.md"), `변경된 줄\n${notes}`);
    await panel.getByRole("button", { name: "현재 대화에 첨부" }).click();
    await panel.getByRole("button", { name: "최신 파일 다시 열기" }).waitFor();
    assert.equal((await refs()).length, 1);
    await chat.fill("옆에서 자료 확인");
    await page.getByRole("button", { name: /^전송/ }).click();
    await page.getByText("[mock] 수신한 메시지: 옆에서 자료 확인", { exact: true }).waitFor();
    assert.ok((await panel.locator("pre").innerText()).startsWith("추가한 첫 줄"));
    await chat.fill("보존할 대화 초안");
    const panelBox = await panel.boundingBox(),
      chatBox = await chat.boundingBox();
    assert.ok(panelBox && chatBox && panelBox.x >= chatBox.x + chatBox.width);
    await page
      .getByRole("navigation", { name: "대화 목록" })
      .getByRole("button", { name: "첫 작업", exact: true })
      .click();
    await page.getByText(original, { exact: true }).waitFor();
    assert.equal(await page.getByLabel("섹션 선택").locator("option:checked").innerText(), "사료 검토");
    assert.equal(await page.getByText("첨부 자료 1개", { exact: true }).count(), 0);
    await page
      .getByRole("navigation", { name: "대화 목록" })
      .getByRole("button", { name: "연표 확인", exact: true })
      .click();
    await page.getByText("첨부 자료 1개", { exact: true }).click();
    await page.getByRole("button", { name: "첨부 빼기" }).click();
    await page.getByText("첨부 자료 1개", { exact: true }).waitFor({ state: "hidden" });
    assert.deepEqual(await refs(), []);
    assert.ok(!(await previewRefs()).messages.some((m) => m.content.includes("첨부 파일")));
    await panel.getByRole("button", { name: "활동 기록", exact: true }).click();
    await panel.getByText("INDEX.md · 83–83줄", { exact: true }).waitFor();
    const history = await (await page.request.get(`${projectPath}/activity`, { headers })).json();
    assert.ok(history.some((r) => r.error === "search_result_changed"));
    assert.ok(history.some((r) => r.action === "search" && r.error === null));
    assert.ok(!JSON.stringify(history).includes("근거 82") && !JSON.stringify(history).includes(folder));
    assert.equal((await page.request.get(`${projectPath}/activity`)).status(), 401);
    await panel.getByRole("button", { name: "파일", exact: true }).click();
    await panel.getByText("파일 내용 검색", { exact: true }).click();
    await panel.getByLabel("검색 문구").fill("tokenlookup");
    const searchRequest = page.waitForRequest((r) => r.url().endsWith("/search"));
    await panel.getByRole("button", { name: "검색", exact: true }).click();
    assert.equal((await searchRequest).postDataJSON().caseSensitive, false);
    await panel.getByRole("button", { name: /tags.txt · 1줄/ }).waitFor();
    await panel.getByLabel("대소문자 구분").check();
    await panel.getByRole("button", { name: "검색", exact: true }).click();
    await panel.getByText(/일치한 줄 0개/).waitFor();
    await panel.getByRole("button", { name: "작업공간 닫기" }).click();
    assert.equal(await chat.inputValue(), "보존할 대화 초안");
    await openWorkspace();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#project-workspace")?.matches(":modal"));
    const noToken = await page.request.post(`${projectPath}/entries`, { data: { path: "" } });
    assert.equal(noToken.status(), 401);
    const searchData = { path: "", query: "근거" };
    assert.equal((await page.request.post(`${projectPath}/search`, { data: searchData })).status(), 401);
    assert.equal(
      (
        await page.request.post(`${projectPath}/search`, { headers, data: { path: "", query: " " } })
      ).status(),
      400,
    );
    const stale = await page.request.put(`${projectPath}/root`, {
      headers,
      data: { path: null, previous: null },
    });
    assert.equal(stale.status(), 409);
    await page.getByText("연결 폴더 변경", { exact: true }).click();
    await page.getByRole("button", { name: "연결 해제" }).click();
    await page.getByRole("button", { name: "INDEX.md" }).waitFor({ state: "hidden" });
    const disconnected = await page.request.post(`${projectPath}/file`, {
      headers,
      data: { path: "INDEX.md" },
    });
    assert.equal(disconnected.status(), 409);
    assert.equal(
      (await page.request.post(`${projectPath}/search`, { headers, data: searchData })).status(),
      409,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "첫 작업", exact: true }).click();
    await page.getByText(original, { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
  },
);
