import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connections } from "../apps/server/src/connections.ts";

test("connection changes keep credentials bound to their endpoint and never return them", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-connections-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { AGS_CUSTOM_BASE_URL: "https://original.example/v1", AGS_CUSTOM_API_KEY: "env-fixture" };
  const connections = new Connections(dir, env);
  const original = connections.view("custom");
  assert.equal(original.hasKey, true);
  const update = { ...original, defaultModel: "my/model", baseUrl: "https://new.example/v1" };
  await assert.rejects(() => connections.save("custom", update), /new_endpoint_key/);
  await assert.rejects(
    () => connections.save("custom", { ...update, baseUrl: "http://remote.example" }),
    /invalid_connection_url/,
  );
  assert.deepEqual(connections.view("custom"), original);
  const saved = await connections.save("custom", { ...update, key: "replacement-fixture" });
  assert.equal(saved.hasKey, true);
  assert.equal(saved.baseUrl, "https://new.example/v1/");
  assert.doesNotMatch(
    JSON.stringify(saved) + readFileSync(join(dir, "connection-custom.json"), "utf8"),
    /replacement-fixture|env-fixture/,
  );
  await assert.rejects(() => connections.save("custom", update), /settings_changed/);
  assert.equal((await connections.save("custom", { ...saved, defaultModel: "another" })).hasKey, true);
  const reopened = new Connections(dir, env);
  const current = reopened.view("custom");
  assert.equal(current.defaultModel, "another");
  assert.equal(current.hasKey, process.platform === "win32");
  assert.equal(reopened.adapters.options.find((option) => option.id === "custom")?.enabled, current.hasKey);
  await reopened.save("custom", { ...current, key: null });
  assert.equal(new Connections(dir, env).view("custom").hasKey, false);
  assert.equal(reopened.adapters.options.find((option) => option.id === "custom")?.enabled, true);
  const router = reopened.view("openrouter");
  assert.equal(reopened.adapters.options.find((option) => option.id === "openrouter")?.enabled, false);
  await reopened.save("openrouter", { ...router, key: "router-fixture", defaultModel: "other/model" });
  assert.equal(reopened.adapters.options.find((option) => option.id === "openrouter")?.enabled, true);
});

test("OpenAI 연결은 독립 설정을 저장하고 재시작 후 원래 모델과 키 저장 방식을 복원한다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-openai-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    AGS_OPENAI_API_KEY: "direct-env",
    AGS_OPENAI_MODEL: "direct/model",
    AGS_OPENROUTER_API_KEY: "router-env",
  };
  const connections = new Connections(dir, env);
  const view = connections.view("openai");
  assert.equal(view.hasKey, true);
  assert.equal(view.defaultModel, "direct/model");
  const saved = await connections.save("openai", {
    ...view,
    baseUrl: "https://alternate.example",
    key: "direct-input",
    defaultModel: "changed",
  });
  assert.equal(saved.baseUrl, "https://api.openai.com/v1/");
  assert.doesNotMatch(
    JSON.stringify(saved) + readFileSync(join(dir, "connection-openai.json"), "utf8"),
    /direct-env|direct-input|router-env/,
  );
  const restored = new Connections(dir, env);
  assert.equal(restored.view("openai").hasKey, process.platform === "win32");
  assert.equal(restored.view("openai").defaultModel, "changed");
  assert.equal(restored.view("openrouter").hasKey, true);
  await restored.save("openai", { ...restored.view("openai"), key: null });
  assert.equal(new Connections(dir, env).view("openai").hasKey, false);
});

test("Windows 일괄 키 복원은 손상된 항목만 건너뛴다", { skip: process.platform !== "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-dpapi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Connections(dir, {});
  for (const id of ["openai", "gemini", "anthropic"] as const)
    await first.save(id, { ...first.view(id), key: `fixture-${id}`, defaultModel: "fixture" });
  const path = join(dir, "connection-gemini.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, encrypted: "YWJjZA==" }));
  const next = new Connections(dir, {});
  assert.equal(next.view("anthropic").hasKey, true);
  assert.equal(next.view("openai").hasKey, true);
  assert.equal(next.view("gemini").needsKey, true);
});

test("Windows 키 암호화 대기 중 같은 연결을 변경하면 먼저 저장된 버전을 유지한다", { skip: process.platform !== "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-key-revision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connections = new Connections(dir, {});
  const original = connections.view("openai");
  const pending = connections.save("openai", { ...original, key: "stale-fixture" });
  const conflict = assert.rejects(pending, /settings_changed/);
  const saved = await connections.save("openai", { ...original, defaultModel: "chosen/model" });
  await conflict;
  assert.equal(saved.hasKey, false);
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(new Connections(dir, {}).view("openai"), saved);
});
