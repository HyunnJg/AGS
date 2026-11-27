import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { SessionStore, migrateUntitledSessions, sessionSchemaVersion } from "../apps/server/src/sessions.ts";
import { isConnectionId, isModelSelection } from "../packages/contracts/src/providers.ts";
import { customEndpoint, officialBaseUrls } from "../packages/providers/src/compatible.ts";

const format = "AGS-private-state";
const backupName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.bak$/;
class BackupError extends Error {}
const invalid = () => new BackupError("백업 형식 또는 무결성 검사에 실패했습니다.");

function schema(db: DatabaseSync) {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}
function tables(db: DatabaseSync) {
  const result = new Map<string, string[]>();
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all()) {
    if (typeof name !== "string" || !/^\w+$/.test(name)) throw invalid();
    const columns = db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name);
    result.set(
      name,
      columns.map((c) => String(c.name)),
    );
  }
  return result;
}

// Rebuild connection records from public fields. Never read environment keys or decrypt stored credentials.
function connection(id: unknown, record: Record<string, unknown>) {
  if (
    !isConnectionId(id) ||
    typeof record.defaultModel !== "string" ||
    typeof record.baseUrl !== "string" ||
    (record.defaultModel && !isModelSelection({ provider: id, model: record.defaultModel })) ||
    (record.source !== "none" && record.source !== "supplied" && record.source !== "environment")
  )
    throw invalid();
  const baseUrl = id === "custom" ? (customEndpoint(record.baseUrl) ?? "") : officialBaseUrls[id];
  return { revision: 0, baseUrl, defaultModel: record.defaultModel, source: record.source };
}

function exportState(source: string, destination: string) {
  const db = new DatabaseSync(join(source, "sessions.sqlite"), { readOnly: true });
  const temp = join(dirname(destination), `.ags-export-${randomUUID()}`);
  let fd: number | undefined;
  try {
    db.exec("BEGIN");
    const layout = tables(db);
    if (schema(db) !== sessionSchemaVersion)
      throw new BackupError("DB 버전을 확인하세요. 현재 AGS에서 작업실을 열고 종료한 뒤 다시 시도하세요.");
    if (
      !layout.has("sessions") ||
      !layout.has("turns") ||
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get()
    )
      throw invalid();
    const output = openSync(temp, "wx", 0o600);
    fd = output;
    const hash = createHash("sha256");
    function emit(...record: unknown[]) {
      const line = `${JSON.stringify(record)}\n`;
      writeFileSync(output, line);
      hash.update(line);
    }
    emit(format, 1, schema(db));
    for (const [table, columns] of layout) {
      emit("table", table, columns);
      for (const row of db.prepare(`SELECT rowid AS __rowid, * FROM "${table}" ORDER BY rowid`).iterate()) {
        emit(
          "row",
          row.__rowid,
          ...columns.map((c) => (table === "projects" && c === "writeGrant" ? null : row[c])),
        );
      }
    }
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const id = /^connection-(\w+)\.json$/.exec(entry.name)?.[1];
      if (!isConnectionId(id)) continue;
      if (!entry.isFile()) throw invalid();
      emit("connection", id, connection(id, JSON.parse(readFileSync(join(source, entry.name), "utf8"))));
    }
    const backups = join(source, "backups");
    if (existsSync(backups)) {
      if (!lstatSync(backups).isDirectory()) throw invalid();
      for (const entry of readdirSync(backups, { withFileTypes: true })) {
        if (!backupName.test(entry.name)) continue;
        if (!entry.isFile()) throw invalid();
        emit("original", entry.name, readFileSync(join(backups, entry.name)).toString("base64"));
      }
    }
    writeFileSync(output, `${JSON.stringify(["sha256", hash.digest("hex")])}\n`);
    fsyncSync(output);
    closeSync(output);
    fd = undefined;
    try {
      linkSync(temp, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw error;
      copyFileSync(temp, destination, constants.COPYFILE_EXCL);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    db.close();
  }
}

async function restoreInto(file: string, stage: string) {
  const path = join(stage, "sessions.sqlite");
  new SessionStore(path).close();
  const db = new DatabaseSync(path);
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const remaining = tables(db);
    db.exec("PRAGMA foreign_keys=ON; BEGIN; PRAGMA defer_foreign_keys=ON");
    for (const table of remaining.keys()) db.exec(`DELETE FROM "${table}"`);
    const hash = createHash("sha256");
    let legacyTitles = false;
    let header = false,
      verified = false;
    let insert: StatementSync | undefined;
    let grantIndex = -1;
    for await (const line of lines) {
      const record = JSON.parse(line);
      if (!Array.isArray(record) || verified) throw invalid();
      const [kind, key, value] = record;
      if (!header) {
        if (kind !== format || key !== 1 || (value !== 5 && value !== 6 && value !== 7 && value !== 8 && value !== schema(db)))
          throw new BackupError("이 AGS 버전에서 복원할 수 없는 백업 형식 또는 DB 버전입니다.");
        // v5 shared_prompt rows predate the language column. SQLite supplies its default on insert.
        if (value === 5 || value === 6) remaining.delete("custom_presets");
        if (value === 5) remaining.set("shared_prompt", ["id", "prompt"]);
        if (value === 7) remaining.set("custom_presets", ["id", "name", "instructions"]);
        legacyTitles = value < 9;
        header = true;
      } else if (kind === "sha256") {
        if (remaining.size || key !== hash.digest("hex")) throw invalid();
        verified = true;
        continue;
      } else if (kind === "table") {
        const columns = remaining.get(key);
        if (
          !columns ||
          !Array.isArray(value) ||
          value.length !== columns.length ||
          new Set(value).size !== columns.length ||
          !value.every((c) => columns.includes(c))
        )
          throw invalid();
        remaining.delete(key);
        grantIndex = key === "projects" ? value.indexOf("writeGrant") + 2 : -1;
        const fields = ["rowid", ...value.map((c) => `"${c}"`)];
        insert = db.prepare(
          `INSERT INTO "${key}" (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
        );
      } else if (kind === "row" && insert) {
        if (grantIndex >= 0) record[grantIndex] = null;
        insert.run(...record.slice(1));
      } else if (kind === "connection" && isConnectionId(key)) {
        writeFileSync(join(stage, `connection-${key}.json`), JSON.stringify(connection(key, value)), {
          flag: "wx",
          mode: 0o600,
        });
      } else if (
        kind === "original" &&
        typeof key === "string" &&
        backupName.test(key) &&
        typeof value === "string"
      ) {
        const backups = join(stage, "backups");
        mkdirSync(backups, { recursive: true, mode: 0o700 });
        writeFileSync(join(backups, key), Buffer.from(value, "base64"), { flag: "wx", mode: 0o600 });
      } else throw invalid();
      hash.update(`${line}\n`);
    }
    if (
      !verified ||
      db.prepare("PRAGMA foreign_key_check").get() ||
      db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw invalid();
    if (legacyTitles) migrateUntitledSessions(db);
    db.exec("COMMIT");
  } finally {
    lines.close();
    stream.destroy();
    db.close();
  }
}

async function restore(file: string, destination: string) {
  if (existsSync(destination)) throw new BackupError("복원 대상은 아직 존재하지 않는 새 폴더여야 합니다.");
  const stage = mkdtempSync(join(dirname(destination), ".ags-restore-"));
  try {
    await restoreInto(file, stage);
    if (existsSync(destination)) throw new BackupError("복원 대상이 이미 있습니다.");
    renameSync(stage, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const [command, file, target, extra] = process.argv.slice(2);
try {
  if (command === "export" && file && !target) {
    exportState(resolve(process.env.AGS_STATE_DIR || join(homedir(), ".ags", "private")), resolve(file));
    console.log("백업을 저장했습니다 ·", resolve(file));
  } else if (command === "restore" && file && target && !extra) {
    await restore(resolve(file), resolve(target));
    console.log("복원을 완료했습니다 ·", resolve(target));
  } else
    throw new BackupError(
      "사용법: state-backup export <새 백업 파일> 또는 restore <백업 파일> <새 상태 폴더>",
    );
} catch (error) {
  // Database and parser errors can contain private text or values from the backup.
  const safe = error instanceof BackupError;
  console.error(
    safe
      ? error.message
      : "작업을 완료하지 못했습니다. AGS를 종료하고 파일 경로·권한·백업 상태를 확인하세요.",
  );
  process.exitCode = 1;
}
