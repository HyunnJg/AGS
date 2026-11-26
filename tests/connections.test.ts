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
