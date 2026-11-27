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
    const longReply = `공유할 문단\n${"검토에 보내지 않을 내용\n".repeat(700)}직접 연결 응답`;
    const fake = createServer(async (req, res) => {
      if (req.url?.startsWith("/anthropic/")) {
        assert.equal(req.headers.authorization, "Bearer anthropic-ui-fixture");
        assert.equal(req.headers["anthropic-version"], "2026-10-21");
        if (req.url === "/anthropic/v1/models") {
          res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({data:[
            {id:"claude-fixture",display_name:"Claude Fixture"}], has_more:false}));
          return;
        }
        assert.equal(req.url, "/anthropic/v1/messages");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.model, "claude-fixture");
        const review = body.system[0].text.startsWith("독립 검토자");
        if (review) {
          assert.deepEqual(body.messages, [{role:"user",content:"Claude 독립 검토 확인"}]);
          assert.equal(body.max_tokens, 1200);
        }
        const events = [{type:"message_start"}, {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
          {type:"content_block_delta",index:0,delta:{type:"text_delta",text:review ? "Claude 검토 완료" : "Claude 채팅 응답"}},
          {type:"content_block_stop",index:0}, {type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:7}}, {type:"message_stop"}];
        res.writeHead(200,{"content-type":"text/event-stream"}).end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
        return;
      }
      if (req.url?.startsWith("/gemini/")) {
        assert.equal(req.headers["x-goog-api-key"], "gemini-ui-fixture");
        assert.equal(req.headers.authorization, undefined);
        if (req.url === "/gemini/v1beta/models?pageSize=1000") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{name:"models/gemini-fixture", displayName:"Gemini Fixture", supportedGenerationMethods:["generateContent"]}]}));
          return;
        }
        assert.equal(req.url, "/gemini/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString());
        const review = request.systemInstruction.parts[0].text.startsWith("독립 검토자");
        if (review) {
          assert.deepEqual(request.contents, [{role:"user", parts:[{text:"선택한 문단 검토\n\n공유할 문단"}]}]);
          assert.equal(request.generationConfig.maxOutputTokens, 1200);
        }
        const text = review ? "선택 문단 검토 완료" : "Gemini 대화 응답";
        const frame = { candidates:[{content:{role:"model", parts:[{text}]}, finishReason:"STOP"}],usageMetadata:{totalTokenCount:29} };
        res.writeHead(200, {"content-type":"text/event-stream"}).end(`data: ${JSON.stringify(frame)}\n\n`);
        return;
      }
      if (req.url?.startsWith("/openai/")) {
        assert.equal(req.headers.authorization, "Bearer openai-ui-fixture");
        if (req.url === "/openai/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "ui/openai-text", object: "model" }] }));
          return;
        }
        assert.equal(req.url, "/openai/v1/chat/completions");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(payload.model, "ui/openai-text");
        assert.equal(payload.stream, true);
        assert.deepEqual(payload.stream_options, {include_usage: true});
        assert.ok(!("max_tokens" in payload));
        if (payload.messages[0].content.startsWith("독립 검토자")) {
          assert.match(payload.messages[0].content, /한국어로 답하세요/);
          assert.equal(payload.max_completion_tokens, 1200);
          assert.deepEqual(payload.messages.slice(1), [{ role: "user", content: "직접 연결 검토 확인" }]);
        }
        res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "openai-local-1" });
        const content = payload.messages[0].content.startsWith("독립 검토자") ? "직접 연결 응답" : longReply;
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: {"choices":[],"usage":{"total_tokens":24}}\n\ndata: [DONE]\n\n`);
        return;
      }
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
        res.end('data: {"choices":[{"delta":{"content":"복원 확인"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":32,"completion_tokens":8,"total_tokens":40,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}\n\ndata: [DONE]\n\n');
        return;
      }
      assert.equal(payload.model, "ui/test-model");
      assert.equal(payload.max_tokens, 123);
      assert.equal(payload.messages.length, 4);
      assert.match(payload.messages[0].content, /분야 프리셋: # History\nCheck the primary source\./);
      assert.match(payload.messages[0].content, /한국어로 답하세요/);
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
      const transport = new URL("./fixtures/provider-transport.mjs", import.meta.url).href;
      child = spawn(process.execPath, ["--import", transport, "dist/apps/server/src/main.js"], {
        env: {
          ...process.env,
          AGS_STATE_DIR: dir,
          AGS_PORT: String(port),
          AGS_LOCAL_TOKEN: token,
          AGS_OPENROUTER_API_KEY: "",
          AGS_OPENROUTER_MODEL: "",
          AGS_TEST_PROVIDER_PORT: String(fake.address().port),
          AGS_ANTHROPIC_API_KEY: "",
          AGS_ANTHROPIC_MODEL: "",
          AGS_GEMINI_API_KEY: "",
          AGS_GEMINI_MODEL: "",
          AGS_OPENAI_API_KEY: "",
          AGS_OPENAI_MODEL: "",
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
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(base);
    await page.getByLabel("로컬 인증 토큰").fill(token);
    await page.getByRole("button", { name: "작업실 열기" }).click();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "고급 기능" }).click();
    await page.getByText(dir, { exact: true }).waitFor();
    await page.getByRole("button", {name: "모델", exact: true}).click();
    await page.getByRole("button", {name: "분야 프리셋"}).click();
    const registeredPresets = page.getByRole("region", {name: "등록된 프리셋"});
    await registeredPresets.getByText("등록된 프리셋이 없습니다.").waitFor();
    await page.getByLabel("Markdown 파일 가져오기").setInputFiles({
      name: "History EN.md", mimeType: "text/markdown", buffer: Buffer.from("# History\r\nDistinguish evidence from inference."),
    });
    const profileText = page.getByLabel("분야 지침");
    await page.waitForFunction(() => document.querySelector("dialog textarea")?.value.startsWith("# History"));
    assert.equal(await page.getByLabel("프리셋 이름").inputValue(), "History EN");
    await profileText.fill("# History\nCheck the primary source.");
    await page.getByRole("button", {name: "프리셋 등록"}).click();
    await page.getByText(/‘History EN’ 등록 완료/).waitFor();
    const savedProfile = registeredPresets.getByText("History EN", {exact: true});
    await profileText.fill("작성 중인 새 지침");
    await savedProfile.click();
    const instructions = "# History\nCheck the primary source.";
    await registeredPresets.locator("pre").waitFor();
    assert.equal(await registeredPresets.locator("pre").textContent(), instructions);
    assert.equal(await profileText.inputValue(), "작성 중인 새 지침");
    await page.getByLabel("Markdown 파일 가져오기").setInputFiles({
      name: "History EN.md", mimeType: "text/markdown", buffer: Buffer.from(instructions.replaceAll("\n", "\r\n")),
    });
    const registration = page.waitForResponse(r => r.url().endsWith("/api/settings/presets") && r.request().method() === "POST");
    await page.getByRole("button", {name: "프리셋 등록"}).click();
    const response = await registration;
    assert.equal(response.status(), 200);
    assert.equal(response.request().postDataJSON().instructions, instructions);
    assert.equal(await registeredPresets.locator("summary").count(), 1);
    await page.getByRole("button", { name: "언어 지원" }).click();
    const language = page.getByLabel("기본 응답 언어");
    await language.selectOption("ko");
    await page.getByRole("button", {name: "저장", exact: true}).click();
    await page.getByText("기본 응답 언어를 저장했습니다.").waitFor();
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
    const selectProfile = page.waitForResponse(r => r.request().method() === "PATCH" && r.request().postDataJSON()?.preset?.startsWith("custom-"));
    await page.getByLabel("프리셋", {exact:true}).selectOption({label:"History EN"});
    assert.equal((await selectProfile).status(), 200);
    const picker = page.getByRole("combobox", { name: "프리셋", exact: true });
    const profileId = await picker.inputValue();
    const settingsButton = page.getByRole("button", { name: "설정", exact: true });
    const presetTab = page.getByRole("button", { name: "분야 프리셋" });
    await settingsButton.click();
    await presetTab.click();
    await savedProfile.click();
    await registeredPresets.getByRole("button", { name: "프리셋 보관" }).click();
    const archivedName = "History EN (보관됨)";
    await registeredPresets.getByText(archivedName, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await picker.getByRole("option", { name: archivedName }).waitFor({ state: "attached" });
    assert.equal(await picker.inputValue(), profileId);
    await page.getByRole("button", { name: /^다음 작업/ }).click();
    assert.equal(await picker.inputValue(), "general");
    assert.equal(await picker.locator(`option[value="${profileId}"]`).count(), 0);
    await settingsButton.click();
    await presetTab.click();
    await registeredPresets.getByText(archivedName, { exact: true }).click();
    await registeredPresets.getByRole("button", { name: "선택 목록에 복원" }).click();
    await savedProfile.waitFor();
    await page.keyboard.press("Escape");
    await picker.getByRole("option", { name: "History EN", exact: true }).waitFor({ state: "attached" });
    assert.equal(await picker.inputValue(), "general");
    await page.getByRole("button", { name: "첫 작업", exact: true }).click();
    assert.equal(await picker.inputValue(), profileId);
    await page.getByText("[mock · coding] 수신한 메시지: 첫 작업", { exact: true }).waitFor();
    assert.equal(await page.locator("article").count(), 1);
    await page.getByLabel("메시지").fill("오래 걸리는 요청");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "공용 프롬프트" }).click();
    await page.getByText("고정 지침 미리보기", {exact: true}).click();
    await page.locator(".context-preview pre").filter({hasText: "한국어로 답하세요."}).waitFor();
    await page.locator(".context-preview pre").filter({hasText: "Check the primary source."}).waitFor();
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
    await page.locator(".context-preview summary").filter({hasText: /^현재 입력$/}).click();
    await page.locator("pre").filter({ hasText: "오래 걸리는 요청" }).waitFor();
    await page.getByText("블록별 입력 예산", {exact:true}).click();
    const budgetTable = page.getByRole("table", { name: "블록별 입력 예산" });
    const memoryCells = budgetTable.getByRole("row", {name:/장기기억/}).getByRole("cell");
    assert.deepEqual((await memoryCells.allTextContents()).slice(1), ["1", "0"]);
    await page.getByLabel("입력 예산 (추정 토큰)").fill("1");
    await page.getByRole("button", { name: "전송 미리보기" }).click();
    await page.getByText(/입력 한도 1 · 입력 초과/).waitFor();
    await page.getByText("블록별 입력 예산", {exact:true}).click();
    assert.deepEqual(await memoryCells.allTextContents(), ["0", "0", "1"]);
    const inputCells = budgetTable.getByRole("row", {name:/현재 입력/}).getByRole("cell");
    assert.deepEqual((await inputCells.allTextContents()).slice(1), ["1", "0"]);
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
    assert.equal(await quick.getByRole("option", {name: "사용자 지정 API · ui/test-model", exact: true}).count(), 1);
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
    const projectName = `역사 자료 ${"긴이름".repeat(25)}`;
    await page.getByLabel("프로젝트 이름").fill(projectName);
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
    await page.getByText(`${projectName} / 사료 검토`, { exact: true }).waitFor();
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
    await page.setViewportSize({ width: 1010, height: 800 });
    await page.waitForFunction(() =>
      document.querySelector("#project-workspace")?.matches("[open]:not(:modal)"),
    );
    const panel = page.getByRole("dialog", { name: "프로젝트 · 파일" });
    async function assertSelectorsFit() {
      const box = await panel.boundingBox();
      for (const label of ["프로젝트 선택", "섹션 선택"]) {
        const select = await panel.getByLabel(label).boundingBox();
        assert.ok(box && select && select.x >= box.x && select.x + select.width <= box.x + box.width + 1);
      }
    }
    await assertSelectorsFit();
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
    await assertSelectorsFit();
    // Switch to the packaged example and complete the guide → source → compare → approve loop.
    const example = await mkdtemp(join(tmpdir(), "ags-p2-demo-"));
    t.after(() => rm(example, { recursive: true, force: true }));
    await cp("examples/P2-workspace", example, { recursive: true });
    const paragraphs = Array.from({length: 120}, (_, i) => `전시 안내 ${i + 1}`);
    await writeFile(join(example, "notes", "intro.md"), paragraphs.join("\n"));
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
    paragraphs[2] = "개관 안내\n토요일에 문을 엽니다.";
    paragraphs[109] = "폐관 안내";
    const revised = paragraphs.join("\n");
    await panel.getByLabel("수정안", { exact: true }).fill(revised);
    await panel.getByRole("button", { name: "변경 비교" }).click();
    const diff = panel.locator(".file-diff");
    await diff.getByRole("region", {name:"원본 3줄 · 수정안 3–4줄"}).getByText(/토요일/).waitFor();
    await diff.getByText("중간 106줄 동일").waitFor();
    await diff.getByRole("region", {name:"원본 110줄 · 수정안 111줄"}).getByText(/폐관 안내/).waitFor();
    assert.ok(!(await diff.innerText()).includes("전시 안내 60"));
    assert.equal(await readFile(join(example, "notes", "intro.md"), "utf8"), before);
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText("저장했습니다 · notes/intro.md", { exact: true }).waitFor();
    assert.equal(await readFile(join(example, "notes", "intro.md"), "utf8"), revised);
    await panel.getByRole("button", { name: "상위 폴더" }).click();
    await panel.getByRole("button", { name: "새 파일", exact: true }).click();
    await panel.getByLabel("새 파일 이름").fill("result.md");
    await panel.getByLabel("수정안", { exact: true }).fill("승인할 결과");
    await writeFile(join(example, "notes", "handoff.md"), "외부 편집기가 작성한 인계 문서");
    await panel.getByRole("button", { name: "폴더 목록 새로고침" }).click();
    await panel.getByRole("button", { name: "handoff.md", exact: true }).waitFor();
    await rm(join(example, "notes", "handoff.md"));
    await panel.getByRole("button", { name: "폴더 목록 새로고침" }).click();
    await panel.getByRole("button", { name: "handoff.md", exact: true }).waitFor({ state: "detached" });
    assert.equal(await panel.getByLabel("새 파일 이름").inputValue(), "result.md");
    assert.equal(await panel.getByLabel("수정안", { exact: true }).inputValue(), "승인할 결과");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.getByRole("button", { name: "승인하고 저장" }).waitFor();
    await assert.rejects(readFile(join(example, "notes", "result.md")), {
      code: "ENOENT",
    });
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText("저장했습니다 · notes/result.md", { exact: true }).waitFor();
    assert.equal(await readFile(join(example, "notes", "result.md"), "utf8"), "승인할 결과");
    await panel.getByRole("button", { name: "파일 수정", exact: true }).click();
    await panel.getByLabel("수정안", { exact: true }).fill("AGS에서 작성한 초안");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.getByRole("button", { name: "승인하고 저장" }).waitFor();
    await writeFile(join(example, "notes", "result.md"), "외부 변경");
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText(/원본 또는 폴더가 변경됐습니다/).waitFor();
    assert.equal(await readFile(join(example, "notes", "result.md"), "utf8"), "외부 변경");
    await panel.getByRole("button", { name: "최신 원본과 다시 비교" }).click();
    await panel.locator(".removed").filter({ hasText: "외부 변경" }).waitFor();
    await panel.locator(".added").filter({ hasText: "AGS에서 작성한 초안" }).waitFor();
    await panel.getByRole("button", { name: "초안을 다른 이름으로 저장" }).click();
    const copyName = panel.getByLabel("새 파일 이름");
    assert.equal(await copyName.inputValue(), "result-초안.md");
    assert.equal(await panel.getByLabel("수정안", { exact: true }).inputValue(), "AGS에서 작성한 초안");
    for (const invalid of ["result.md", "../moved.md"]) {
      await copyName.fill(invalid);
      assert.ok(await panel.getByRole("button", { name: "변경 비교" }).isDisabled());
    }
    await copyName.fill("result-초안.md");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.getByText("notes/result-초안.md · 변경 미리보기").waitFor();
    const occupied = join(example, "notes", "result-초안.md");
    await assert.rejects(readFile(occupied), { code: "ENOENT" });
    await writeFile(occupied, "다른 편집기가 먼저 저장");
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText(/원본 또는 폴더가 변경됐습니다/).waitFor();
    await panel.getByRole("button", { name: "수정안 편집" }).click();
    await copyName.fill("result-검토.md");
    await panel.getByRole("button", { name: "변경 비교" }).click();
    await panel.getByText("notes/result-검토.md · 변경 미리보기").waitFor();
    await panel.getByRole("button", { name: "승인하고 저장" }).click();
    await panel.getByText("저장했습니다 · notes/result-검토.md", { exact: true }).waitFor();
    assert.equal(await readFile(join(example, "notes", "result-검토.md"), "utf8"), "AGS에서 작성한 초안");
    assert.equal(await readFile(occupied, "utf8"), "다른 편집기가 먼저 저장");
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
    await openWorkspace();
    await panel.getByRole("button", { name: "STATUS.md", exact: true }).click();
    await panel.getByLabel("첨부 시작 줄").fill("1");
    await panel.getByLabel("첨부 끝 줄").fill("1");
    await panel.getByRole("button", { name: "현재 대화에 첨부" }).click();
    await panel.getByText("1–1줄을 첨부했습니다.", { exact: true }).waitFor();
    await panel.getByRole("button", {name:"작업공간 닫기"}).click();
    await writeFile(join(example,"STATUS.md"), "확인하지 않은 새 내용");
    const editor = page.locator("details:visible").filter({has:page.locator("summary").filter({hasText:/^다른 모델에 검토 요청$/})}).last();
    await editor.locator("summary").first().click();
    await editor.getByLabel("검토 모델에 보낼 내용").fill("안내문 표현을 검토해 주세요.");
    const chooseRef = editor.getByRole("checkbox", { name: /STATUS.md/ });
    assert.equal(await chooseRef.isChecked(), false);
    await chooseRef.check();
    await editor.getByText(/보낼 내용 미리보기/).click();
    const approvedText = await editor.locator(".review-preview").textContent();
    assert.ok(approvedText.includes("STATUS.md · 1–1줄 · 버전"));
    assert.ok(!approvedText.includes("확인하지 않은 새 내용"));
    await editor.getByRole("button",{name:"승인하고 검토 요청"}).click();
    const excerpt = editor.getByLabel("반영할 검토 내용");
    await excerpt.waitFor();
    assert.match(await excerpt.inputValue(),/안내문 표현/);
    const reviewed = await (await page.request.get(`${freshPath}/review`,{headers})).json();
    assert.notEqual(reviewed.reviewer, freshId);
    assert.equal(reviewed.message, approvedText);
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
    await editor.getByLabel("검토 모델에 보낼 내용").fill("두 번째 검토");
    assert.equal(await chooseRef.isChecked(), false);
    await editor.getByRole("button", {name:"승인하고 검토 요청"}).click();
    const reviewHistory = editor.getByText("검토 이력 2건", { exact: true });
    await reviewHistory.waitFor();
    const latestDraft = editor.locator(":scope > section").getByLabel("반영할 검토 내용");
    await latestDraft.fill("최근 검토에서 편집 중인 의견");
    const logIds = async () => (await (await page.request.get(`${base}/api/call-logs`, { headers })).json()).map(r => r.id);
    const beforeReuse = await logIds();
    const pastPath = `${freshPath}/review/${reviewed.id}`;
    assert.equal((await page.request.get(pastPath)).status(), 401);
    assert.equal((await page.request.get(`${base}/api/sessions/${sessionId}/review/${reviewed.id}`, { headers })).status(), 404);
    assert.equal((await page.request.post(pastPath, { headers })).status(), 405);
    await reviewHistory.click();
    const older = editor.getByRole("listitem").filter({ hasText: "안내문 표현" });
    const expandOlder = older.getByText("이전 검토 결과 사용", { exact: true });
    const fetched = page.waitForResponse(r => r.url() === pastPath && r.request().method() === "GET");
    await expandOlder.click();
    assert.deepEqual(await (await fetched).json(), reviewed);
    const oldDraft = older.getByLabel("반영할 검토 내용");
    assert.equal(await oldDraft.inputValue(), reviewed.reply);
    await oldDraft.fill("첫 검토에서 다시 고른 문장");
    await expandOlder.click();
    await expandOlder.click();
    assert.equal(await oldDraft.inputValue(), "첫 검토에서 다시 고른 문장");
    await older.getByRole("button", { name: "입력창에 추가" }).click();
    assert.equal(await page.getByLabel("메시지", { exact: true }).inputValue(), "기존 초안\n\n선택한 의견\n\n첫 검토에서 다시 고른 문장");
    assert.equal(await latestDraft.inputValue(), "최근 검토에서 편집 중인 의견");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ags-session")), freshId);
    assert.deepEqual(await logIds(), beforeReuse);
    await reviewHistory.click();
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
    await editor.locator("summary").first().click();
    await editor.getByText("검토 이력 2건", {exact:true}).click();
    await editor.getByRole("button", {name:/안내문 표현.*대화 열기/}).click();
    await page.waitForFunction(id => sessionStorage.getItem("ags-session") === id, reviewed.reviewer);
    assert.equal(await page.locator(".conversation:visible .user-message").first().textContent(), approvedText);
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
    const logPicker = page.getByLabel("호출 선택");
    const filters = page.getByRole("group", { name: "호출 필터" });
    const providerFilter = filters.getByLabel("공급자", { exact: true });
    const kindFilter = filters.getByLabel("호출 종류");
    const statusFilter = filters.getByLabel("종료 상태");
    await providerFilter.selectOption("custom");
    await kindFilter.selectOption("chat");
    await statusFilter.selectOption("completed");
    const matching = list.filter((row) => row.provider === "custom" && row.kind === "chat" && row.status === "completed");
    assert.ok(matching.length > 0 && matching.length < list.length);
    assert.deepEqual(await logPicker.locator("option").evaluateAll(options => options.map(o => o.value)), matching.map(r => r.id));
    await page.getByText(`${list.length}건 중 ${matching.length}건`, { exact: true }).waitFor();
    await logPicker.selectOption(sample.id);
    const refreshLogs = page.waitForResponse(r => r.url() === `${base}/api/call-logs` && r.request().method() === "GET");
    await page.getByRole("button", { name: "목록 새로고침" }).click();
    assert.equal((await refreshLogs).status(), 200);
    assert.equal(await logPicker.inputValue(), sample.id);
    const detail = page.getByRole("region", { name: "호출 상세" });
    await detail.getByText(/HTTP 200/).waitFor();
    await detail.getByText(new RegExp(`메시지 ${statePayload.length}개`)).waitFor();
    await detail.getByText("공급자 보고 토큰", { exact: true }).waitFor();
    await detail.getByText("입력 32 · 캐시 읽기 0 · 캐시 쓰기 3 · 출력 8 · 추론 2 · 합계 40", { exact: true }).waitFor();
    assert.ok(list.every((item) => !("usage" in item)));
    await detail.getByText("전송 시 입력 구성").waitFor();
    await detail.getByText("블록별 입력 예산", { exact: true }).click();
    const loggedBudget = detail.getByRole("table", { name: "블록별 입력 예산" });
    const memoryRow = loggedBudget.getByRole("row", { name: /장기기억/ });
    assert.equal(await memoryRow.getByRole("cell").nth(1).innerText(),
      String(restored.blockUsage.find((row) => row.block === "memory").includedMessages));
    await detail.locator("pre").filter({ hasText: "[DONE]" }).waitFor();
    assert.match(await detail.locator("pre").nth(0).innerText(), /text\/event-stream/);
    assert.equal(await detail.locator("pre").nth(2).innerText(), "복원 확인");
    const filteredButton = page.getByRole("button", { name: "필터 결과 JSON 다운로드" });
    for (const button of ["이 호출 JSON 다운로드", "필터 결과 JSON 다운로드", "전체 JSON 다운로드"]) {
      const file = page.waitForEvent("download");
      await page.getByRole("button", { name: button }).click();
      const downloaded = await file;
      const data = JSON.parse(await readFile(await downloaded.path(), "utf8"));
      if (button === "필터 결과 JSON 다운로드") {
        assert.match(downloaded.suggestedFilename(), /^AGS-calls-filtered-/);
        assert.ok(Array.isArray(data));
      }
      const row = Array.isArray(data) ? data.find((item) => item.id === sample.id) : data;
      assert.equal(row.answer, "복원 확인");
      assert.deepEqual(row.usage, {
        inputTokens: 32, outputTokens: 8, totalTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 3, reasoningTokens: 2,
      });
      assert.equal(row.contextBudget.estimatedInput, restored.estimatedInput);
      assert.deepEqual(row.contextBudget.blockUsage, restored.blockUsage);
      if (Array.isArray(data)) {
        const expected = button === "필터 결과 JSON 다운로드" ? matching : list;
        assert.deepEqual(data.map(item => item.id), expected.map(item => item.id));
        assert.ok(data.filter((item) => item.kind !== "chat" || item.provider === "mock")
          .every((item) => !("contextBudget" in item)));
      }
      assert.equal(row.request.contentBytes, statePayload.reduce((n, m) => n + Buffer.byteLength(m.content), 0));
      assert.ok(!JSON.stringify(row.request).includes("섹션 복원 검증"));
      assert.ok(row.body.includes("[DONE]"));
      assert.ok(!JSON.stringify(data).includes("fixture-only"));
    }
    await providerFilter.selectOption("mock");
    await statusFilter.selectOption("timeout");
    await page.getByText("조건에 맞는 호출이 없습니다.").waitFor();
    assert.ok(await filteredButton.isDisabled());
    assert.equal(await logPicker.count(), 0);
    assert.equal(await detail.count(), 0);
    await page.getByRole("button", { name: "필터 초기화" }).click();
    assert.equal(await filteredButton.count(), 0);
    assert.equal(await logPicker.locator("option").count(), list.length);
    await logPicker.selectOption(sample.id);
    const clear = page.getByRole("button", { name: "로그 전체 비우기" });
    page.once("dialog", (dialog) => dialog.dismiss());
    await clear.click();
    assert.equal(await page.getByLabel("호출 선택").inputValue(), sample.id);
    page.once("dialog", (dialog) => dialog.accept());
    await clear.click();
    await page.getByText("아직 기록된 호출이 없습니다.").waitFor();
    assert.equal(await detail.count(), 0);
    assert.ok(await page.getByLabel("새 호출 기록").isChecked());
    assert.deepEqual(await (await page.request.get(`${base}/api/call-logs/export`, { headers })).json(), []);
    await page.getByRole("button", { name: "모델", exact: true }).click();
    await page.getByRole("button", { name: "OpenAI", exact: true }).click();
    await page.getByLabel("API 키", { exact: true }).fill("openai-ui-fixture");
    assert.equal(await page.getByLabel("API 기본 주소").count(), 0);
    const previousSelection = await quick.inputValue();
    await page.route("**/api/settings/connections/openai", route =>
      route.fulfill({ status: 503, json: { error: "key_storage_failed" } }), { times: 1 });
    await page.getByRole("button", { name: "연결 저장" }).click();
    await page.getByText(/Windows에서 API 키를 암호화하지 못했습니다/).waitFor();
    assert.equal(await page.getByLabel("API 키", { exact: true }).inputValue(), "openai-ui-fixture");
    await page.getByRole("button", { name: "연결 저장" }).click();
    const modelRow = page.getByRole("button", { name: "ui/openai-text", exact: true });
    await modelRow.click();
    assert.equal(await page.getByLabel("API 키", { exact: true }).inputValue(), "");
    await page.getByLabel("API 키", { exact: true }).fill("unsaved-replacement-fixture");
    const defaultSaved = page.waitForRequest(r => r.url().endsWith("/connections/openai") && r.method() === "PUT");
    await page.getByRole("button", { name: "선택 모델을 기본값으로 저장" }).click();
    assert.equal(Object.hasOwn((await defaultSaved).postDataJSON(), "key"), false);
    await page.getByText("공급자 기본 모델 · ui/openai-text", {exact: true}).waitFor();
    assert.equal(await page.getByLabel("API 키", {exact: true}).inputValue(), "unsaved-replacement-fixture");
    await page.getByRole("button", { name: "기본값 해제" }).click();
    await page.getByText("공급자 기본 모델 · 미지정", {exact: true}).waitFor();
    await page.getByRole("button", { name: "선택 모델을 기본값으로 저장" }).click();
    await page.getByText("공급자 기본 모델 · ui/openai-text", {exact: true}).waitFor();
    await page.getByRole("button", { name: "설정 닫기" }).click();
    assert.equal(await quick.inputValue(), previousSelection);
    assert.equal(await quick.getByRole("option", {name:"OpenAI · ui/openai-text",exact:true}).count(), 1);
    await switchModel("openai", "ui/openai-text");
    await page.getByLabel("메시지", { exact: true }).fill("직접 연결 테스트");
    await page.getByRole("button", {name:"전송"}).click();
    await page.locator(".reply").filter({ hasText: "공유할 문단" }).waitFor();
    await switchModel("mock", "");
    await editor.locator("summary").first().click();
    await editor.getByRole("combobox").selectOption(JSON.stringify(["openai", "ui/openai-text"]));
    const chatDraft = page.getByLabel("메시지", {exact:true});
    await chatDraft.fill("탭 전환 전 채팅 초안");
    const reviewTarget = editor.getByRole("combobox");
    const reviewDraft = editor.getByLabel("검토 모델에 보낼 내용");
    await reviewDraft.fill("탭 전환 전 검토 초안");
    const other = await context.newPage();
    await other.goto(base);
    await other.getByLabel("로컬 인증 토큰").fill(token);
    await other.getByRole("button", {name:"작업실 열기"}).click();
    await other.getByRole("button", {name:"설정", exact:true}).click();
    await other.getByRole("button", {name:"OpenAI", exact:true}).click();
    await other.getByLabel("모델 ID", {exact:true}).fill("ui/alternate");
    await other.getByRole("button", {name:"선택 모델을 기본값으로 저장"}).click();
    await other.getByText("공급자 기본 모델 · ui/alternate", {exact:true}).waitFor();

    async function returnToChat() {
      await page.bringToFront();
      // Headless Chromium may keep multiple pages focused. Deliver the tab's window focus event explicitly.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    }
    await returnToChat();
    const alternate = quick.getByRole("option", {name:"OpenAI · ui/alternate", exact:true});
    await alternate.waitFor({state:"attached"});
    assert.equal(await quick.inputValue(), JSON.stringify(["mock", ""]));
    assert.equal(await reviewTarget.inputValue(), "");
    assert.equal(await reviewTarget.locator("option:checked").textContent(), "검토 모델을 다시 선택하세요");
    assert.ok(await editor.getByRole("button", {name:"승인하고 검토 요청"}).isDisabled());
    await reviewTarget.selectOption(JSON.stringify(["openai", "ui/alternate"]));
    await switchModel("openai", "ui/alternate");

    await other.bringToFront();
    await other.getByText("연결 설정", {exact:true}).click();
    await other.getByLabel("저장 시 기존 키 제거").check();
    await other.getByRole("button", {name:"연결 저장"}).click();
    await other.getByText("연결 설정을 저장했습니다.", {exact:true}).waitFor();
    await returnToChat();
    await page.waitForFunction(() => Array.from(document.querySelector(".quick-model").options)
      .some(option => option.value === JSON.stringify(["openai", "ui/alternate"]) && option.disabled));
    assert.equal(await reviewTarget.inputValue(), "");
    assert.equal(await reviewTarget.getByRole("option", {name:/ui\/alternate/}).count(), 0);
    assert.equal(await quick.inputValue(), JSON.stringify(["openai", "ui/alternate"]));
    assert.ok(await page.getByRole("button", {name:"전송 ↑", exact:true}).isDisabled());
    assert.equal(await chatDraft.inputValue(), "탭 전환 전 채팅 초안");
    assert.equal(await reviewDraft.inputValue(), "탭 전환 전 검토 초안");

    await other.bringToFront();
    await other.getByLabel("API 키", {exact:true}).fill("openai-ui-fixture");
    await other.getByLabel("기본 모델 ID").fill("ui/openai-text");
    await other.getByRole("button", {name:"연결 저장"}).click();
    await other.getByText("공급자 기본 모델 · ui/openai-text", {exact:true}).waitFor();
    await other.close();
    await returnToChat();
    await reviewTarget.selectOption(JSON.stringify(["openai", "ui/openai-text"]));
    await switchModel("mock", "");
    await chatDraft.fill("");
    await editor.getByLabel("검토 모델에 보낼 내용").fill("직접 연결 검토 확인");
    await editor.getByRole("button", { name: "승인하고 검토 요청" }).click();
    const directReply = editor.getByLabel("반영할 검토 내용");
    await directReply.waitFor();
    assert.equal(await directReply.inputValue(), "직접 연결 응답");
    const directLogs = await (await page.request.get(`${base}/api/call-logs/export`, { headers })).json();
    for (const kind of ["chat", "review", "catalog"]) {
      assert.ok(directLogs.some(row => row.provider === "openai" && row.kind === kind && row.status === "completed"));
    }
    const reviewLog = directLogs.find(row => row.kind === "review" && row.provider === "openai");
    assert.deepEqual(reviewLog.usage, {totalTokens: 24});
    assert.equal(reviewLog.request.maxTokens, 1200);
    assert.equal(reviewLog.headers["x-request-id"], "openai-local-1");
    assert.ok(reviewLog.body.includes("[DONE]"));
    assert.ok(reviewLog.body.includes('"total_tokens":24'));
    assert.ok(!JSON.stringify(directLogs).includes("openai-ui-fixture"));
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByRole("button", { name: "Google Gemini", exact: true }).click();
    await page.getByLabel("API 키", {exact:true}).fill("gemini-ui-fixture");
    await page.getByLabel("기본 모델 ID").fill("gemini-fixture");
    await page.getByRole("button", {name:"연결 저장"}).click();
    await page.getByRole("button", {name:/Gemini Fixture.*gemini-fixture/i}).click();
    await page.getByRole("button", {name:"gemini-fixture 즐겨찾기"}).click();
    await page.locator('.pin[aria-pressed="true"]').waitFor();
    await page.getByRole("button", {name:"적용",exact:true}).click();
    await page.getByRole("dialog").waitFor({state:"hidden"});
    assert.equal(await quick.inputValue(), JSON.stringify(["gemini","gemini-fixture"]));
    await page.getByLabel("메시지", {exact:true}).fill("Gemini 채팅 확인");
    await page.getByRole("button", {name:"전송"}).click();
    await page.getByText("Gemini 대화 응답", {exact:true}).waitFor();
    await switchModel("openai", "ui/openai-text");
    await editor.getByRole("combobox").selectOption(JSON.stringify(["gemini", "gemini-fixture"]));
    await reviewDraft.fill("선택한 문단 검토");
    await editor.getByText("대화 답변에서 발췌", { exact: true }).click();
    const source = editor.getByLabel("발췌할 답변");
    const sourceText = editor.getByLabel("답변 원문에서 보낼 부분 선택");
    const appendExcerpt = editor.getByRole("button", { name: "선택한 부분을 검토 초안에 추가" });
    assert.equal(await sourceText.inputValue(), "Gemini 대화 응답");
    const earlierId = await source.getByRole("option", { name: /직접 연결 테스트/ }).getAttribute("value");
    await source.selectOption(earlierId);
    assert.equal(await sourceText.inputValue(), longReply);
    assert.ok(longReply.length > 8000);
    await sourceText.press("Control+a");
    await appendExcerpt.click();
    await editor.getByText(/선택 범위나 초안을 줄이세요/).waitFor();
    assert.equal(await reviewDraft.inputValue(), "선택한 문단 검토");
    await sourceText.evaluate(field => {
      field.focus();
      field.setSelectionRange(0, "공유할 문단".length);
    });
    await appendExcerpt.click();
    assert.equal(await reviewDraft.inputValue(), "선택한 문단 검토\n\n공유할 문단");
    await editor.getByText("대화 답변에서 발췌", { exact: true }).click();
    const approved = page.waitForResponse(r => r.url().endsWith("/review") && r.request().method() === "POST");
    await editor.getByRole("button", {name:"승인하고 검토 요청"}).click();
    const independent = await (await approved).json();
    assert.equal(independent.provider, "gemini");
    assert.equal(independent.reply, "선택 문단 검토 완료");
    await editor.getByText("검토 이력 2건", {exact:true}).click();
    await editor.getByRole("button", {name:/선택한 문단 검토.*대화 열기/}).click();
    await page.waitForFunction(id => sessionStorage.getItem("ags-session") === id, independent.reviewer);
    await page.getByText("선택 문단 검토 완료", {exact:true}).waitFor();
    const nativeLogs = await (await page.request.get(`${base}/api/call-logs/export`, {headers})).json();
    for (const kind of ["catalog", "chat", "review"])
      assert.ok(nativeLogs.some(row => row.provider === "gemini" && row.kind === kind && row.status === "completed"));
    const nativeReview = nativeLogs.find(row => row.provider === "gemini" && row.kind === "review");
    assert.deepEqual(nativeReview.usage, {totalTokens: 29});
    assert.equal(nativeReview.answer, independent.reply);
    assert.equal(nativeReview.request.maxTokens, 1200);
    assert.match(nativeReview.body, /usageMetadata/);
    assert.ok(!JSON.stringify(nativeLogs).includes("gemini-ui-fixture"));
    await page.getByRole("button", {name:"설정",exact:true}).click();
    await page.getByRole("button", {name:"Anthropic (Claude)",exact:true}).click();
    await page.getByLabel("API 키", {exact:true}).fill("anthropic-ui-fixture");
    await page.getByLabel("기본 모델 ID").fill("claude-fixture");
    await page.getByRole("button", {name:"연결 저장"}).click();
    await page.getByRole("button", {name:/Claude Fixture.*claude-fixture/i}).click();
    await page.getByRole("button", {name:"claude-fixture 즐겨찾기"}).click();
    await page.locator('.pin[aria-pressed="true"]').waitFor();
    await page.getByRole("button", {name:"적용",exact:true}).click();
    await page.getByRole("dialog").waitFor({state:"hidden"});
    await page.getByLabel("메시지", {exact:true}).fill("Claude 채팅 확인");
    await page.getByRole("button", {name:"전송"}).click();
    await page.getByText("Claude 채팅 응답",{exact:true}).waitFor();
    await switchModel("gemini","gemini-fixture");
    await editor.locator("summary").first().click();
    await editor.getByRole("combobox").selectOption(JSON.stringify(["anthropic","claude-fixture"]));
    await editor.getByLabel("검토 모델에 보낼 내용").fill("Claude 독립 검토 확인");
    const claudeResult = page.waitForResponse(r => r.url().endsWith("/review") && r.request().method() === "POST");
    await editor.getByRole("button",{name:"승인하고 검토 요청"}).click();
    const claudeReview = await (await claudeResult).json();
    assert.equal(claudeReview.reply,"Claude 검토 완료");
    await editor.getByText("검토 이력 1건",{exact:true}).click();
    await editor.getByRole("button",{name:/Claude 독립 검토 확인.*대화 열기/}).click();
    await page.waitForFunction(id => sessionStorage.getItem("ags-session") === id, claudeReview.reviewer);
    const claudeLogs = await (await page.request.get(`${base}/api/call-logs/export`, {headers})).json();
    const logged = claudeLogs.find(row => row.provider === "anthropic" && row.kind === "review");
    assert.deepEqual(logged.usage, {outputTokens: 7});
    assert.equal(logged.answer, claudeReview.reply);
    assert.equal(logged.request.maxTokens,1200);
    assert.match(logged.body,/output_tokens/);
    assert.ok(!JSON.stringify(claudeLogs).includes("anthropic-ui-fixture"));
    assert.deepEqual(pageErrors, []);
  },
);
