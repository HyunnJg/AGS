import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isModelSelection,
  type ConnectionId,
  type ConnectionView,
} from "../../../packages/contracts/src/providers.ts";
import { configureProviders, customEndpoint, officialBaseUrls } from "../../../packages/providers/src/compatible.ts";

const ids = ["custom", "openrouter", "openai", "gemini", "anthropic"] as const;
const windows = process.platform === "win32";

interface RecordData {
  revision: number;
  baseUrl: string;
  defaultModel: string;
  // Only Windows stores a supplied key on disk, encrypted for the current OS user.
  source: "environment" | "none" | "supplied";
  encrypted?: string;
}

function dpapi(operation: "Protect" | "Unprotect", values: string[]): string[] {
  // Each input line is one base64 value. Preserve its position even if one old key is unreadable.
  const script = `
    $ErrorActionPreference='Stop'
    Add-Type -AssemblyName System.Security
    $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
    while ($null -ne ($line=[Console]::In.ReadLine())) {
      try {
        $bytes=[Convert]::FromBase64String($line)
        $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,$scope)
        [Console]::WriteLine([Convert]::ToBase64String($result))
      } catch { [Console]::WriteLine('-') }
    }`;
  const result = spawnSync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: values.join("\n"), encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout) throw new Error("key_storage_failed");
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  if (lines.length !== values.length || (operation === "Protect" && lines.includes("-")))
    throw new Error("key_storage_failed");
  return lines;
}

export class ConnectionError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export class Connections {
  private readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly records = new Map<ConnectionId, RecordData>();
  private readonly keys = new Map<ConnectionId, string>();
  adapters: ReturnType<typeof configureProviders>;

  constructor(directory: string, env: NodeJS.ProcessEnv) {
    this.directory = directory;
    this.env = { ...env };
    for (const id of ids) {
      const path = this.path(id);
      if (!existsSync(path)) continue;
      const record: RecordData = JSON.parse(readFileSync(path, "utf8"));
      this.records.set(id, record);
    }
    const encrypted = [...this.records].flatMap(([id, record]) =>
      record.source === "supplied" && record.encrypted && /^[A-Za-z0-9+/]+=*$/.test(record.encrypted)
        ? [{ id, value: record.encrypted }]
        : [],
    );
    if (windows && encrypted.length) {
      try {
        const keys = dpapi("Unprotect", encrypted.map(item => item.value));
        encrypted.forEach(({ id }, index) => {
          const value = keys[index];
          if (value && value !== "-") this.keys.set(id, Buffer.from(value, "base64").toString("utf8"));
        });
      } catch {
        // Keep the settings available for key replacement if DPAPI cannot start.
      }
    }
    this.adapters = this.configure();
  }

  private path(id: ConnectionId) {
    return join(this.directory, `connection-${id}.json`);
  }
  private defaults(id: ConnectionId): RecordData {
    return {
      revision: 0,
      baseUrl: id === "custom" ? (customEndpoint(this.env.AGS_CUSTOM_BASE_URL) ?? "") : officialBaseUrls[id],
      defaultModel: this.env[`AGS_${id.toUpperCase()}_MODEL`]?.trim() ?? "",
      source: "environment",
    };
  }
  private key(id: ConnectionId, record: RecordData) {
    if (record.source === "supplied") return this.keys.get(id);
    if (record.source === "environment" && record.baseUrl === this.defaults(id).baseUrl)
      return this.env[`AGS_${id.toUpperCase()}_API_KEY`];
  }
  private configure() {
    const env: NodeJS.ProcessEnv = {};
    for (const id of ids) {
      const record = this.records.get(id) ?? this.defaults(id);
      const prefix = `AGS_${id.toUpperCase()}`;
      const key = this.key(id, record);
      env[`${prefix}_MODEL`] = record.defaultModel;
      env[`${prefix}_API_KEY`] = key;
      if (id === "custom" && (record.source !== "supplied" || key)) env.AGS_CUSTOM_BASE_URL = record.baseUrl;
    }
    return configureProviders(env);
  }
  view(id: ConnectionId): ConnectionView {
    const record = this.records.get(id) ?? this.defaults(id);
    return {
      revision: record.revision,
      defaultModel: record.defaultModel,
      baseUrl: record.baseUrl,
      hasKey: Boolean(this.key(id, record)),
      needsKey: record.source === "supplied" && !this.key(id, record),
      persistentKeys: windows,
    };
  }
  save(id: ConnectionId, body: unknown) {
    const old = this.records.get(id) ?? this.defaults(id);
    if (
      !body ||
      typeof body !== "object" ||
      !("revision" in body) ||
      typeof body.revision !== "number" ||
      !("defaultModel" in body) ||
      typeof body.defaultModel !== "string" ||
      (body.defaultModel !== "" && !isModelSelection({ provider: id, model: body.defaultModel })) ||
      !("baseUrl" in body) ||
      typeof body.baseUrl !== "string" ||
      body.baseUrl.length > 2048
    )
      throw new ConnectionError(400, "invalid_connection");
    if (body.revision !== old.revision) throw new ConnectionError(409, "settings_changed");
    const input = "key" in body ? body.key : undefined;
    if (
      input !== undefined &&
      input !== null &&
      (typeof input !== "string" || !/^[!-~]{1,4096}$/.test(input))
    )
      throw new ConnectionError(400, "invalid_connection");
    let baseUrl = id === "custom" ? "" : officialBaseUrls[id];
    if (id === "custom") {
      try {
        baseUrl = customEndpoint(body.baseUrl) ?? "";
      } catch {
        throw new ConnectionError(400, "invalid_connection_url");
      }
    }
    if (baseUrl !== old.baseUrl && this.key(id, old) && input === undefined)
      throw new ConnectionError(400, "new_endpoint_key");
    if (!baseUrl && typeof input === "string") throw new ConnectionError(400, "invalid_connection_url");
    const record: RecordData = {
      ...old,
      revision: old.revision + 1,
      baseUrl,
      defaultModel: body.defaultModel,
    };
    if (input !== undefined || baseUrl !== old.baseUrl) {
      record.source = typeof input === "string" ? "supplied" : "none";
      delete record.encrypted;
      if (windows && typeof input === "string") {
        const [encrypted] = dpapi("Protect", [Buffer.from(input).toString("base64")]);
        if (!encrypted) throw new Error("key_storage_failed");
        record.encrypted = encrypted;
      }
    }
    const dest = this.path(id);
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx", flush: true });
      renameSync(temp, dest);
    } finally {
      rmSync(temp, { force: true });
    }
    if (typeof input === "string") this.keys.set(id, input);
    else if (record.source !== "supplied") this.keys.delete(id);
    this.records.set(id, record);
    this.adapters = this.configure();
    return this.view(id);
  }
}
