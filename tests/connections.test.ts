import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connections } from "../apps/server/src/connections.ts";

test("connection changes keep credentials bound to their endpoint and never return them", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ags-connections-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { AGS_CUSTOM_BASE_URL: "https://original.example/v1", AGS_CUSTOM_API_KEY: "env-fixture" };
  const connections = new Connections(dir, env);
  const original = connections.view("custom");
  assert.equal(original.hasKey, true);
  const update = { ...original, defaultModel: "my/model", baseUrl: "https://new.example/v1" };
  assert.throws(() => connections.save("custom", update), /new_endpoint_key/);
  assert.throws(
    () => connections.save("custom", { ...update, baseUrl: "http://remote.example" }),
    /invalid_connection_url/,
  );
  assert.deepEqual(connections.view("custom"), original);
  const saved = connections.save("custom", { ...update, key: "replacement-fixture" });
  assert.equal(saved.hasKey, true);
  assert.equal(saved.baseUrl, "https://new.example/v1/");
  assert.doesNotMatch(
    JSON.stringify(saved) + readFileSync(join(dir, "connection-custom.json"), "utf8"),
    /replacement-fixture|env-fixture/,
  );
  assert.throws(() => connections.save("custom", update), /settings_changed/);
  assert.equal(connections.save("custom", { ...saved, defaultModel: "another" }).hasKey, true);
  const reopened = new Connections(dir, env);
  const current = reopened.view("custom");
  assert.equal(current.defaultModel, "another");
  assert.equal(current.hasKey, process.platform === "win32");
  assert.equal(reopened.adapters.options.find((option) => option.id === "custom")?.enabled, current.hasKey);
  reopened.save("custom", { ...current, key: null });
  assert.equal(new Connections(dir, env).view("custom").hasKey, false);
  assert.equal(reopened.adapters.options.find((option) => option.id === "custom")?.enabled, true);
  const router = reopened.view("openrouter");
  assert.equal(reopened.adapters.options.find((option) => option.id === "openrouter")?.enabled, false);
  reopened.save("openrouter", { ...router, key: "router-fixture", defaultModel: "other/model" });
  assert.equal(reopened.adapters.options.find((option) => option.id === "openrouter")?.enabled, true);
});

test("OpenAI 연결은 독립 설정을 저장하고 재시작 후 원래 모델과 키 저장 방식을 복원한다", (t) => {
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
  const saved = connections.save("openai", {
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
  restored.save("openai", { ...restored.view("openai"), key: null });
  assert.equal(new Connections(dir, env).view("openai").hasKey, false);
});
