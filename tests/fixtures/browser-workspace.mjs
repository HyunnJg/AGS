import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright";

export async function openBrowserWorkspace(t, providerPort) {
  const dir = await mkdtemp(join(tmpdir(), "ags-browser-"));
  const token = randomBytes(32).toString("hex");
  let browser;
  let child;
  let closed;
  async function start(port) {
    const transport = new URL("./provider-transport.mjs", import.meta.url).href;
    child = spawn(process.execPath, ["--import", transport, "dist/apps/server/src/main.js"], {
      env: {
        ...process.env,
        AGS_STATE_DIR: dir,
        AGS_PORT: String(port),
        AGS_LOCAL_TOKEN: token,
        AGS_OPENROUTER_API_KEY: "",
        AGS_OPENROUTER_MODEL: "",
        AGS_TEST_PROVIDER_PORT: providerPort === undefined ? "" : String(providerPort),
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
  async function stop(signal = "SIGTERM") {
    if (child) {
      child.kill(signal);
      await closed;
      child = undefined;
    }
  }
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await stop();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
  browser = await chromium.launch({ executablePath: process.env.AGS_TEST_CHROMIUM || undefined });
  const base = await start(0);
  const context = await browser.newContext();
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base);
  await page.getByLabel("로컬 인증 토큰").fill(token);
  await page.getByRole("button", { name: "작업실 열기" }).click();
  await page.getByRole("navigation", { name: "대화 목록" }).waitFor();
  return { dir, token, start, stop, base, context, page, pageErrors };
}
