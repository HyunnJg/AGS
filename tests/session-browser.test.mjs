import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, cp, readFile } from "node:fs/promises";
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
    let statePayload;
    const fake = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer fixture-only");
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
      if (payload.messages[0]?.content.startsWith("작업기억 초안")) {
        assert.equal(payload.messages.length,2);
        const sources = JSON.parse(payload.messages[1].content);
        assert.deepEqual(sources,[{번호:1,질문:"섹션 복원 검증",답변:"복원 확인"}]);
        res.writeHead(200, {"content-type":"text/event-stream"});
        res.end('data: {"choices":[{"delta":{"content":"[1] 다음 확인은 현장 검수."}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      if (payload.messages.some((m) => m.content === "섹션 복원 검증")) {
        statePayload = payload.messages;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"복원 확인"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
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
          AGS_CUSTOM_MODEL: "",
          AGS_CUSTOM_API_KEY: "",
          AGS_CUSTOM_BASE_URL: "",
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
    await page.getByLabel("API 기본 주소").fill(`http://127.0.0.1:${fake.address().port}/v1`);
    await page.getByLabel("기본 모델 ID").fill("ui/test-model");
    await page.getByLabel("API 키", { exact: true }).fill("fixture-only");
    await page.getByRole("button", { name: "연결 저장" }).click();
    await page.getByText("연결 설정을 저장했습니다.").waitFor();
    assert.equal(await page.getByLabel("API 키", { exact: true }).inputValue(), "");
    assert.equal(await page.getByLabel("모델 ID", { exact: true }).inputValue(), "ui/test-model");
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
    // Switch to the packaged example and complete the guide → source → compare → approve loop.
    const example = await mkdtemp(join(tmpdir(), "ags-p2-demo-"));
    t.after(() => rm(example, { recursive: true, force: true }));
    await cp("examples/P2-workspace", example, { recursive: true });
    await page.getByText("연결 폴더 변경", { exact: true }).click();
    await page.getByLabel("작업 폴더 절대 경로").fill(example);
    await page.getByLabel("승인형 저장 허용").check();
    await page.getByRole("button", { name: "승인형 저장으로 연결" }).click();
    await page.waitForFunction(() => document.querySelector(".file-write") !== null);
    await panel.getByRole("button", {name:"지식 안내도"}).click();
    const guide = panel.getByRole("region", {name:"지식 문서"});
    await guide.getByRole("button", {name:/전시 자료 조사 방법/}).click();
    await guide.getByRole("button", {name:/전시 연표의 날짜 검토/}).click();
    await guide.getByRole("button", {name:/대조할 원본 기록/}).click();
    await guide.getByText(/3–5 \/ 5줄/).waitFor();
    assert.deepEqual(await refs(), []);
    assert.equal(await guide.getByLabel("첨부 시작 줄").inputValue(), "3");
    assert.equal(await guide.getByLabel("첨부 끝 줄").inputValue(), "4");
    await panel.getByRole("button", {name:"활동 기록", exact:true}).click();
    await panel.getByRole("button", {name:"지식 안내도", exact:true}).click();
    assert.equal(await guide.getByLabel("첨부 끝 줄").inputValue(), "4");
    await guide.getByRole("button", {name:"지식 발췌 추가"}).click();
    await guide.getByText("3–4줄을 첨부했습니다.").waitFor();
    assert.ok((await previewRefs()).messages.some(m => m.content.includes("notes/register.md · 3–4줄")));
    await guide.getByRole("button", {name:"이전 문서"}).click();
    await guide.getByRole("button", {name:/대조할 원본 기록/}).waitFor();
    await guide.getByRole("button", {name:"처음 안내도"}).click();
    await guide.getByRole("button", {name:/전시 자료 조사 방법/}).waitFor();
    await panel.getByRole("button", {name:"작업공간 닫기"}).click();
    await page.getByRole("button", {name:"설정",exact:true}).click();
    await page.getByRole("button", {name:"토글형 모듈"}).click();
    const knowledgeToggle = page.getByLabel("외부 지식 참조");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("dialog label"))
      .find(label => label.textContent.trim() === "외부 지식 참조")?.querySelector("input:checked:enabled"));
    const toggleOff = page.waitForResponse(r => r.url().endsWith("/settings/knowledge") && r.request().method() === "PUT");
    await knowledgeToggle.click();
    await toggleOff;
    assert.ok(!(await previewRefs()).messages.some(m => m.content.includes("notes/register.md")));
    assert.equal((await refs())[0].paused, true);
    const toggleOn = page.waitForResponse(r => r.url().endsWith("/settings/knowledge") && r.request().method() === "PUT");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("dialog label"))
      .find(label => label.textContent.trim() === "외부 지식 참조")?.querySelector("input:not(:checked):enabled"));
    await knowledgeToggle.click();
    await toggleOn;
    assert.equal((await refs())[0].paused, false);
    await page.getByRole("button",{name:"설정 닫기"}).click();
    const attached = page.locator(".attached-references:visible");
    if (!(await attached.evaluate(el => el.open))) await attached.locator("summary").click();
    await attached.getByText(/발췌 당시와 같은 버전/).waitFor();
    await writeFile(join(example, "notes", "register.md"), "새 원본 기록");
    await attached.getByRole("button", {name:"원본 다시 확인"}).click();
    await attached.getByText(/원본 변경됨/).waitFor();
    assert.ok((await previewRefs()).messages.some(m => m.content.includes("11월 4일")));
    assert.ok(!(await previewRefs()).messages.some(m => m.content.includes("새 원본 기록")));
    await attached.locator("summary").click();
    await openWorkspace();
    await panel.getByRole("button", { name: "INDEX.md", exact: true }).click();
    await panel.getByRole("button", { name: "전시 안내 초안 · notes/intro.md" }).click();
    await panel.getByRole("button", { name: "파일 수정", exact: true }).click();
    await panel.getByRole("button", { name: "현재 대화의 마지막 답변 가져오기" }).click();
    await page.waitForFunction(() => document.querySelector(".file-write textarea")?.value.includes("옆에서 자료 확인"));
    const before = await readFile(join(example, "notes", "intro.md"), "utf8");
    await panel.getByLabel("수정안", { exact: true }).fill("# 확정 안내\n\n토요일에 문을 엽니다.\n");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.locator(".added").filter({ hasText: "토요일" }).waitFor();
    assert.equal(await readFile(join(example, "notes", "intro.md"), "utf8"), before);
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText("저장했습니다.", { exact: true }).waitFor();
    assert.match(await readFile(join(example, "notes", "intro.md"), "utf8"), /토요일/);
    await panel.getByRole("button", { name: "상위 폴더" }).click();
    await panel.getByRole("button", { name: "새 파일", exact: true }).click();
    await panel.getByLabel("새 파일 이름").fill("result.md");
    await panel.getByLabel("수정안", { exact: true }).fill("승인할 결과");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.getByRole("button", { name: "승인하고 저장" }).waitFor();
    await assert.rejects(readFile(join(example, "notes", "result.md")), {
      code: "ENOENT",
    });
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText("저장했습니다.", { exact: true }).waitFor();
    assert.equal(await readFile(join(example, "notes", "result.md"), "utf8"), "승인할 결과");
    await panel.getByRole("button", { name: "파일 수정", exact: true }).click();
    await panel.getByLabel("수정안", { exact: true }).fill("저장되지 않을 결과");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.getByRole("button", { name: "승인하고 저장" }).waitFor();
    await writeFile(join(example, "notes", "result.md"), "외부 변경");
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText(/원본 또는 폴더가 변경됐습니다/).waitFor();
    assert.equal(await readFile(join(example, "notes", "result.md"), "utf8"), "외부 변경");
    await panel.getByRole("button", { name: "최신 원본과 다시 비교" }).click();
    await panel.locator(".removed").filter({ hasText: "외부 변경" }).waitFor();
    await panel.locator(".added").filter({ hasText: "저장되지 않을 결과" }).waitFor();
    await panel.getByRole("button", { name: "취소", exact: true }).click();
    assert.equal(await readFile(join(example, "notes", "result.md"), "utf8"), "외부 변경");
    const writes = await (await page.request.get(`${projectPath}/activity`, { headers })).json();
    assert.ok(writes.some((r) => r.action === "create" && r.path === "notes/result.md" && !r.error));
    const changedFile = writes.find((r) => r.action === "write" && r.path === "notes/intro.md" && !r.error);
    assert.equal(await readFile(join(dir, "backups", changedFile.backup), "utf8"), before);
    await panel.getByRole("button", { name: "상위 폴더" }).click();
    await panel.getByRole("button", { name: "상위 폴더" }).click();
    await panel.getByRole("button", { name: "STATUS.md", exact: true }).click();
    await panel.getByText("섹션 현재 상태", { exact: true }).click();
    await panel.getByRole("button", { name: "현재 파일을 상태로 지정" }).click();
    await panel.getByText("섹션 현재 상태 · STATUS.md", { exact: true }).waitFor();
    await panel.getByRole("button", {name:"작업공간 닫기"}).click();
    const checkpointUI=page.locator(".checkpoint-editor:visible");
    await checkpointUI.getByText("구간 요약",{exact:true}).click();
    const draftResponse=page.waitForResponse(r=>r.url().endsWith("/checkpoint"));
    await checkpointUI.getByRole("button",{name:/요약 초안 만들기/}).click();
    const checkpoint=await (await draftResponse).json();
    await checkpointUI.getByLabel("구간 요약 초안").fill("[1] 결정: 연표 초안을 보존한다. 다음: 자료 대조.");
    await assert.rejects(readFile(join(example,checkpoint.path)),{code:"ENOENT"});
    await checkpointUI.getByRole("button",{name:"승인하고 요약 저장"}).click();
    await checkpointUI.getByText(/구간 요약을 저장했습니다/).waitFor();
    assert.match(await readFile(join(example,checkpoint.path),"utf8"),/다음: 자료 대조/);
    await checkpointUI.getByRole("button",{name:/요약 초안 만들기/}).click();
    await checkpointUI.getByText("아직 기록할 새 완료 턴이 없습니다.").waitFor();
    await openWorkspace();
    await panel.getByRole("button", { name: "섹션에서 새 대화" }).click();
    await panel.waitFor({ state: "hidden" });
    const freshId = await page.evaluate(() => sessionStorage.getItem("ags-session"));
    assert.notEqual(freshId, sessionId);
    const freshPath = `${base}/api/sessions/${freshId}`;
    const previewState = async () => (await page.request.post(`${freshPath}/context-preview`, {
      headers, data: { message: "섹션 복원 검증", limits: { turns: 0,inputBudget:null, outputBudget:null } },
    })).json();
    const restored = await previewState();
    assert.equal(restored.includedTurns, 0);
    assert.equal(restored.memoryUse.summaries,1);
    assert.ok(restored.messages.some(m=>m.content.includes("다음: 자료 대조")));
    assert.ok(restored.messages.some((m,i) => restored.blocks[i] === "memory" && m.content.includes("발굴 조사 연표")));
    const connectionPath = `${base}/api/settings/connections/custom`;
    const connection = await (await page.request.get(connectionPath, { headers })).json();
    assert.equal(connection.defaultModel, "ui/test-model");
    assert.equal(connection.hasKey, process.platform === "win32");
    if (!connection.hasKey) {
      const restored = await page.request.put(connectionPath, {
        headers, data: { revision: connection.revision, baseUrl: connection.baseUrl,
          defaultModel: connection.defaultModel, key: "fixture-only" },
      });
      assert.equal(restored.status(), 200);
    }
    assert.equal((await page.request.patch(freshPath, {headers, data:{provider:"custom",model:"ui/test-model"}})).status(),200);
    assert.equal((await page.request.post(`${freshPath}/chat`,{headers,data:{message:"섹션 복원 검증"}})).status(),200);
    assert.deepEqual(statePayload, restored.messages);
    const generated=await page.request.post(`${freshPath}/checkpoint`,{headers,data:{action:"draft",provider:"custom",model:"ui/test-model"}});
    assert.equal(generated.status(),200);
    assert.match((await generated.json()).summary,/현장 검수/);
    await page.getByRole("button", {name:"설정", exact:true}).click();
    await page.getByRole("button", {name:"토글형 모듈"}).click();
    const collab = page.getByLabel("AI 협업 허용");
    const allowReview = page.waitForResponse(r=>r.url().endsWith("/settings/collaboration") && r.request().method()==="PUT");
    await collab.click();
    assert.equal((await allowReview).status(),200);
    const updateToggle=page.getByLabel("작업기억 갱신");
    const updateResponse=page.waitForResponse(r=>r.url().endsWith("/settings/memory-update") && r.request().method()==="PUT");
    await updateToggle.click();
    assert.equal((await updateResponse).status(),200);
    const disabled=await page.request.post(`${freshPath}/checkpoint`,{headers,data:{action:"draft",provider:"custom",model:"ui/test-model"}});
    assert.equal(disabled.status(),403);
    assert.equal((await previewState()).memoryUse.summaries,1);
    const toggle = page.getByLabel("섹션 기억 참조");
    const flip = async () => {
      const changed = page.waitForResponse(r => r.url().endsWith("/settings/section-memory") && r.request().method()==="PUT");
      await toggle.click();
      assert.equal((await changed).status(), 200);
    };
    await flip();
    assert.equal((await previewState()).memoryUse.summaries,0);
    assert.ok(!(await previewState()).messages.some(m=>m.content.includes("발굴 조사 연표")));
    await flip();
    await page.getByRole("button", {name:"설정 닫기"}).click();
    await writeFile(join(example,"STATUS.md"), "확인하지 않은 새 내용");
    const editor = page.locator("details:visible").filter({has:page.locator("summary").filter({hasText:/^다른 모델에 검토 요청$/})}).last();
    await editor.locator("summary").first().click();
    await editor.getByLabel("검토 모델에 보낼 내용").fill("안내문 표현을 검토해 주세요.");
    await editor.getByRole("button",{name:"승인하고 검토 요청"}).click();
    const excerpt = editor.getByLabel("반영할 검토 내용");
    await excerpt.waitFor();
    assert.match(await excerpt.inputValue(),/안내문 표현/);
    const reviewed = await (await page.request.get(`${freshPath}/review`,{headers})).json();
    assert.notEqual(reviewed.reviewer, freshId);
    await page.getByLabel("메시지",{exact:true}).fill("기존 초안");
    await excerpt.fill("선택한 의견");
    await editor.getByRole("button",{name:"입력창에 추가"}).click();
    assert.equal(await page.getByLabel("메시지",{exact:true}).inputValue(),"기존 초안\n\n선택한 의견");
    await editor.getByRole("button",{name:"검토 결과 파일로 저장"}).click();
    await editor.getByRole("button",{name:"변경 비교"}).click();
    await editor.getByRole("button",{name:"승인하고 저장"}).waitFor();
    const resultFile = join(example,`AGS-검토-${reviewed.id}.md`);
    await assert.rejects(readFile(resultFile),{code:"ENOENT"});
    await editor.getByRole("button",{name:"승인하고 저장"}).click();
    await editor.getByText(/작업 폴더에 저장했습니다/).waitFor();
    assert.match(await readFile(resultFile,"utf8"),/안내문 표현/);
    await editor.locator("summary").first().click();
    const outdated = await previewState();
    assert.equal(outdated.stateStale, true);
    assert.ok(!outdated.messages.some(m=>m.content.includes("발굴 조사 연표") || m.content.includes("확인하지 않은 새 내용")));
    await openWorkspace();
    await panel.getByRole("button",{name:"STATUS.md",exact:true}).click();
    await panel.getByText("섹션 현재 상태 · STATUS.md",{exact:true}).click();
    await panel.getByRole("button",{name:"현재 버전으로 상태 갱신"}).click();
    await page.waitForFunction(() => document.querySelector(".section-state button")?.disabled);
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
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "호출 로그", exact: true }).click();
    const list = await (await page.request.get(`${base}/api/call-logs`, { headers })).json();
    for (const kind of ["chat", "review", "checkpoint", "catalog"])
      assert.ok(list.some((row) => row.kind === kind));
    const sample = list.find(
      (row) => row.kind === "chat" && row.provider === "custom" && row.status === "completed",
    );
    await page.getByLabel("호출 선택").selectOption(sample.id);
    const detail = page.getByRole("region", { name: "호출 상세" });
    await detail.getByText(/HTTP 200/).waitFor();
    await detail.locator("pre").filter({ hasText: "[DONE]" }).waitFor();
    assert.match(await detail.locator("pre").nth(0).innerText(), /text\/event-stream/);
    assert.equal(await detail.locator("pre").nth(2).innerText(), "복원 확인");
    for (const button of ["이 호출 JSON 다운로드", "전체 JSON 다운로드"]) {
      const file = page.waitForEvent("download");
      await page.getByRole("button", { name: button }).click();
      const data = JSON.parse(await readFile(await (await file).path(), "utf8"));
      const row = Array.isArray(data) ? data.find((item) => item.id === sample.id) : data;
      assert.equal(row.answer, "복원 확인");
      assert.ok(row.body.includes("[DONE]"));
      assert.ok(!JSON.stringify(data).includes("fixture-only"));
    }
    assert.deepEqual(pageErrors, []);
  },
);
