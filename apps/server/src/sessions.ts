import {
  defaultOrder,
  emptySources,
  type Block,
  type SessionSources,
  type PromptSettings,
} from "../../../packages/contracts/src/context.ts";
import { defaultLimits, type ContextLimits } from "../../../packages/contracts/src/context.ts";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "../../../packages/contracts/src/providers.ts";
import type { Preset, Session, Turn } from "../../../packages/contracts/src/sessions.ts";

export class SessionStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      // A second server must not mark the first server's live turns as interrupted.
      this.db.exec(`
        PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, preset TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          message TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
          preset TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS context_limits (session_id TEXT PRIMARY KEY REFERENCES sessions(id), turns INTEGER NOT NULL, inputBudget INTEGER, outputBudget INTEGER);
        CREATE TABLE IF NOT EXISTS shared_prompt (id INTEGER PRIMARY KEY CHECK(id=1), prompt TEXT NOT NULL);
        INSERT OR IGNORE INTO shared_prompt(id,prompt) VALUES(1,'');
        CREATE TABLE IF NOT EXISTS prompt_layout(id INTEGER PRIMARY KEY CHECK(id=1),block_order TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_sources(session_id TEXT PRIMARY KEY REFERENCES sessions(id),memory TEXT NOT NULL,retrieval TEXT NOT NULL,revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS favorite_models (provider TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(provider,model));
        CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn ON turns(session_id) WHERE status='streaming';
        UPDATE turns SET status='interrupted' WHERE status='streaming';
      `);
      // The first release stored only mock turns. Upgrade both tables in the same transaction.
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 0) {
        for (const table of ["sessions", "turns"]) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN provider TEXT NOT NULL DEFAULT 'mock';
            ALTER TABLE ${table} ADD COLUMN model TEXT NOT NULL DEFAULT '';`);
        }
        this.db.exec("PRAGMA user_version=1");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  favorites() {
    return this.db
      .prepare("SELECT provider,model FROM favorite_models ORDER BY provider,model")
      .all() as unknown as ModelSelection[];
  }
  setFavorite({ provider, model }: ModelSelection, pinned: boolean) {
    const sql = pinned
      ? "INSERT OR IGNORE INTO favorite_models(provider,model) VALUES (?,?)"
      : "DELETE FROM favorite_models WHERE provider=? AND model=?";
    this.db.prepare(sql).run(provider, model);
  }
  list() {
    return this.db.prepare("SELECT * FROM sessions ORDER BY rowid DESC").all() as unknown as Session[];
  }
  create(selection: ModelSelection = { provider: "mock", model: "" }) {
    const session: Session = { id: randomUUID(), title: "새 대화", preset: "general", ...selection };
    this.db
      .prepare("INSERT INTO sessions(id,title,preset,provider,model) VALUES (?, ?, ?, ?, ?)")
      .run(session.id, session.title, session.preset, session.provider, session.model);
    return session;
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as unknown as Session | undefined;
  }
  turns(id: string) {
    return this.db
      .prepare(
        "SELECT id,message,reply,status,preset,provider,model FROM turns WHERE session_id=? ORDER BY rowid",
      )
      .all(id) as unknown as Turn[];
  }
  limits(id: string): ContextLimits {
    return (
      (this.db
        .prepare("SELECT turns,inputBudget,outputBudget FROM context_limits WHERE session_id=?")
        .get(id) as unknown as ContextLimits) ?? defaultLimits
    );
  }
  setLimits(id: string, limits: ContextLimits) {
    this.db
      .prepare(
        "INSERT INTO context_limits VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET turns=excluded.turns,inputBudget=excluded.inputBudget,outputBudget=excluded.outputBudget",
      )
      .run(id, limits.turns, limits.inputBudget, limits.outputBudget);
  }
  prompt(): string {
    return String(this.db.prepare("SELECT prompt FROM shared_prompt WHERE id=1").get()?.prompt ?? "");
  }
  promptSettings(): PromptSettings {
    const row = this.db
      .prepare("SELECT prompt,block_order FROM shared_prompt LEFT JOIN prompt_layout USING(id) WHERE id=1")
      .get();
    return {
      prompt: String(row?.prompt ?? ""),
      order: row?.block_order ? JSON.parse(String(row.block_order)) : defaultOrder,
    };
  }
  setPromptSettings(value: PromptSettings, previous: string, previousOrder: Block[]) {
    const current = this.promptSettings();
    if (current.prompt !== previous || current.order.join() !== previousOrder.join()) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE shared_prompt SET prompt=? WHERE id=1").run(value.prompt);
      this.db
        .prepare(
          "INSERT INTO prompt_layout VALUES (1,?) ON CONFLICT(id) DO UPDATE SET block_order=excluded.block_order",
        )
        .run(JSON.stringify(value.order));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  sources(id: string): SessionSources {
    return (
      (this.db
        .prepare("SELECT memory,retrieval,revision FROM session_sources WHERE session_id=?")
        .get(id) as unknown as SessionSources) ?? emptySources
    );
  }
  setSources(id: string, value: SessionSources) {
    // The synchronous store owns this database exclusively.
    if (this.sources(id).revision !== value.revision) return false;
    this.db
      .prepare(
        "INSERT INTO session_sources VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET memory=excluded.memory,retrieval=excluded.retrieval,revision=excluded.revision",
      )
      .run(id, value.memory, value.retrieval, value.revision + 1);
    return true;
  }
  setPrompt(prompt: string, previous: string) {
    return (
      this.db.prepare("UPDATE shared_prompt SET prompt=? WHERE id=1 AND prompt=?").run(prompt, previous)
        .changes === 1
    );
  }
  isStreaming(id: string) {
    return !!this.db.prepare("SELECT 1 FROM turns WHERE session_id=? AND status='streaming' LIMIT 1").get(id);
  }
  history(id: string, count = defaultLimits.turns) {
    const rows = this.db
      .prepare(`SELECT message,reply FROM turns WHERE session_id=? AND status='completed'
      ORDER BY rowid DESC LIMIT ?`)
      .all(id, count) as unknown as Pick<Turn, "message" | "reply">[];
    return rows.reverse().flatMap((t) => [
      { role: "user" as const, content: t.message },
      { role: "assistant" as const, content: t.reply },
    ]);
  }
  setModel(id: string, selection: ModelSelection) {
    this.db
      .prepare("UPDATE sessions SET provider=?, model=? WHERE id=?")
      .run(selection.provider, selection.model, id);
  }
  setPreset(id: string, preset: Preset) {
    this.db.prepare("UPDATE sessions SET preset=? WHERE id=?").run(preset, id);
  }
  begin(session: Session, id: string, message: string) {
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(`INSERT INTO turns(id,session_id,message,status,preset,provider,model)
        SELECT ?,?,?,'streaming',?,?,? WHERE NOT EXISTS (SELECT 1 FROM turns WHERE session_id=? AND status='streaming')`)
        .run(id, session.id, message, session.preset, session.provider, session.model, session.id);
      if (result.changes) {
        this.db
          .prepare(`UPDATE sessions SET title=? WHERE id=? AND
          (SELECT count(*) FROM turns WHERE session_id=?)=1`)
          .run(Array.from(message.trim()).slice(0, 32).join(""), session.id, session.id);
      }
      this.db.exec("COMMIT");
      return Boolean(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  append(id: string, text: string) {
    this.db.prepare("UPDATE turns SET reply=reply||? WHERE id=? AND status='streaming'").run(text, id);
  }
  finish(id: string, status: Exclude<Turn["status"], "streaming">) {
    this.db.prepare("UPDATE turns SET status=? WHERE id=? AND status='streaming'").run(status, id);
  }
  close() {
    this.db.close();
  }
}
