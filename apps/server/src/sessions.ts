import { CallCapture } from "../../../packages/providers/src/capture.ts";
import type { CallKind, CallLog, CallSummary } from "../../../packages/contracts/src/calls.ts";
import type { Review, ReviewHistoryItem } from "../../../packages/contracts/src/reviews.ts";
import { maxReferences, type FileReference } from "../../../packages/contracts/src/workspace.ts";
import type { FileActivity, FileAction } from "../../../packages/contracts/src/workspace.ts";
import type { Section, WorkspaceCatalog } from "../../../packages/contracts/src/workspace.ts";
import { WorkspaceError, type RegisteredRoot } from "./workspace-files.ts";
import type { DisplaySettings, DisplayRule } from "../../../packages/contracts/src/display.ts";
import {
  defaultOrder,
  emptySources,
  type Block,
  type ContextBudget,
  type SessionSources,
  type PromptSettings,
  type ResponseLanguage,
  isResponseLanguage,
} from "../../../packages/contracts/src/context.ts";
import { defaultLimits, type ContextLimits } from "../../../packages/contracts/src/context.ts";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToServer } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "../../../packages/contracts/src/providers.ts";
import { maxTurnSearchResults, type TurnSearchHit, type TurnSearchResponse } from "../../../packages/contracts/src/sessions.ts";
import { defaultSessionTitle, isBuiltinPreset, normalizePresetText, type CustomPresetSummary, type CustomPreset, type CustomPresetId, type Preset, type Session, type Turn } from "../../../packages/contracts/src/sessions.ts";

export const sessionSchemaVersion = 11;

// Before v9, an untouched session stored its placeholder as a real title.
export function migrateUntitledSessions(db: DatabaseSync) {
  db.prepare("UPDATE sessions SET title='' WHERE title=? AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id=sessions.id)")
    .run(defaultSessionTitle);
}

export function migrateCheckpointSections(db: DatabaseSync) {
  db.exec("UPDATE checkpoints SET sectionId=(SELECT sectionId FROM sessions WHERE id=checkpoints.session)");
}

const displayedTitle = `COALESCE(NULLIF(sessions.title,''),'${defaultSessionTitle}')`;
const sessionQuery = `SELECT sessions.id,${displayedTitle} AS title,preset,provider,model,sectionId,sectionRevision, projects.name || ' / ' || sections.name AS sectionLabel,
  EXISTS(SELECT 1 FROM archived_sessions WHERE session_id=sessions.id) AS archived
  FROM sessions LEFT JOIN sections ON sessions.sectionId=sections.id
  LEFT JOIN projects ON sections.projectId=projects.id`;

function sessionFromRow(row: Record<string, unknown>): Session {
  return { ...row, archived: Boolean(row.archived) } as unknown as Session;
}

export class SessionStore {
  private db: DatabaseSync;
  private deleteConfirmations = new Map<string, { token: string; snapshot: string }>();
  protectCall?: (capture: CallCapture) => void;

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
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT,identity TEXT);
        CREATE TABLE IF NOT EXISTS file_references(
          id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id), project TEXT NOT NULL REFERENCES projects(id),
          path TEXT NOT NULL, version TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL,
          UNIQUE(session,project,path,version,start,end)
        );
        CREATE TABLE IF NOT EXISTS file_activity(
          id INTEGER PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), time INTEGER NOT NULL,
          action TEXT NOT NULL, path TEXT, start INTEGER, end INTEGER, error TEXT
        );
        CREATE INDEX IF NOT EXISTS activity_by_project ON file_activity(project,id);
        CREATE TRIGGER IF NOT EXISTS trim_file_activity AFTER INSERT ON file_activity BEGIN
          DELETE FROM file_activity WHERE project=NEW.project AND id <= (
            SELECT id FROM file_activity WHERE project=NEW.project ORDER BY id DESC LIMIT 1 OFFSET 100
          );
        END;
        CREATE TABLE IF NOT EXISTS sections(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS section_state_source(section TEXT PRIMARY KEY REFERENCES sections(id),
          key TEXT NOT NULL, path TEXT NOT NULL, version TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO memory_settings VALUES(1,1);
        CREATE TRIGGER IF NOT EXISTS clear_state_sources AFTER UPDATE OF root,identity ON projects
        WHEN OLD.root IS NOT NEW.root OR OLD.identity IS NOT NEW.identity BEGIN
          DELETE FROM section_state_source WHERE section IN (SELECT id FROM sections WHERE projectId=NEW.id);
        END;
        CREATE TABLE IF NOT EXISTS knowledge_setting(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO knowledge_setting VALUES(1,1);
        CREATE TABLE IF NOT EXISTS checkpoint_setting(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO checkpoint_setting VALUES(1,1);
        CREATE TABLE IF NOT EXISTS checkpoints(
          session TEXT NOT NULL REFERENCES sessions(id), first TEXT NOT NULL REFERENCES turns(id),
          last TEXT NOT NULL REFERENCES turns(id), path TEXT NOT NULL UNIQUE, version TEXT NOT NULL,
          saved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session,first)
        );
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          message TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
          preset TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS call_log(id TEXT PRIMARY KEY, summary TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS trim_call_log AFTER INSERT ON call_log BEGIN
          DELETE FROM call_log WHERE rowid <= (SELECT rowid FROM call_log ORDER BY rowid DESC LIMIT 1 OFFSET 100);
        END;
        CREATE TABLE IF NOT EXISTS call_log_setting(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO call_log_setting VALUES(1,1);
        CREATE TABLE IF NOT EXISTS collaboration_setting(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO collaboration_setting VALUES(1,0);
        CREATE TABLE IF NOT EXISTS reviews(
          id TEXT PRIMARY KEY REFERENCES turns(id), requester TEXT NOT NULL REFERENCES sessions(id)
        );
        CREATE INDEX IF NOT EXISTS reviews_by_requester ON reviews(requester);
        CREATE TABLE IF NOT EXISTS context_limits (session_id TEXT PRIMARY KEY REFERENCES sessions(id), turns INTEGER NOT NULL, inputBudget INTEGER, outputBudget INTEGER);
        CREATE TABLE IF NOT EXISTS shared_prompt (id INTEGER PRIMARY KEY CHECK(id=1), prompt TEXT NOT NULL);
        INSERT OR IGNORE INTO shared_prompt(id,prompt) VALUES(1,'');
        CREATE TABLE IF NOT EXISTS prompt_layout(id INTEGER PRIMARY KEY CHECK(id=1),block_order TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS display_settings (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,rules TEXT NOT NULL);
        INSERT OR IGNORE INTO display_settings VALUES(1,0,'[]');
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
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 1) {
        this.db.exec(
          "ALTER TABLE sessions ADD COLUMN sectionId TEXT REFERENCES sections(id); PRAGMA user_version=2",
        );
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 2) {
        this.db.exec(
          "ALTER TABLE projects ADD COLUMN writeGrant TEXT; ALTER TABLE file_activity ADD COLUMN backup TEXT; PRAGMA user_version=3",
        );
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 3) {
        this.db.exec("ALTER TABLE file_references ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'; PRAGMA user_version=4");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 4) {
        this.db.exec("ALTER TABLE reviews ADD COLUMN selectionKey TEXT; PRAGMA user_version=5");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 5) {
        this.db.exec("ALTER TABLE shared_prompt ADD COLUMN responseLanguage TEXT NOT NULL DEFAULT 'auto'; PRAGMA user_version=6");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 6) {
        this.db.exec("CREATE TABLE custom_presets (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, instructions TEXT NOT NULL); PRAGMA user_version=7");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 7) {
        this.db.exec("ALTER TABLE custom_presets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)); PRAGMA user_version=8");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 8) {
        migrateUntitledSessions(this.db);
        this.db.exec("PRAGMA user_version=9");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 9) {
        this.db.exec("CREATE TABLE IF NOT EXISTS archived_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id)); PRAGMA user_version=10");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 10) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN sectionRevision INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE checkpoints ADD COLUMN sectionId TEXT REFERENCES sections(id);
          DROP TRIGGER IF EXISTS clear_checkpoints;
          CREATE TRIGGER clear_checkpoints AFTER UPDATE OF root,identity ON projects
          WHEN OLD.root IS NOT NEW.root OR OLD.identity IS NOT NEW.identity BEGIN
            DELETE FROM checkpoints WHERE sectionId IN (SELECT id FROM sections WHERE projectId=NEW.id);
          END;`);
        migrateCheckpointSections(this.db);
        this.db.exec("PRAGMA user_version=11");
      }
      if (this.db.prepare("PRAGMA user_version").get()?.user_version !== sessionSchemaVersion)
        throw new Error("unsupported_session_schema");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  references(session: string): FileReference[] {
    const rows = this.db
      .prepare(`SELECT r.id,p.name AS project,r.path,r.start,r.end,r.text,r.kind,r.version FROM file_references r
      JOIN projects p ON p.id=r.project WHERE r.session=? ORDER BY r.rowid`)
      .all(session) as unknown as Omit<FileReference, "paused">[];
    const enabled = this.knowledgeEnabled();
    return rows.map(row => ({ ...row, paused: row.kind === "knowledge" && !enabled }));
  }
  knowledgeSource(session: string, id: string) {
    return this.db.prepare(
      "SELECT project,path,version FROM file_references WHERE session=? AND id=? AND kind='knowledge'",
    ).get(session, id) as { project: string; path: string; version: string } | undefined;
  }
  addReference(
    session: string,
    project: string,
    path: string,
    version: string,
    start: number,
    end: number,
    text: string,
    kind: FileReference["kind"] = "file",
  ) {
    this.requireSession(session);
    if (kind === "knowledge" && !this.knowledgeEnabled()) throw new WorkspaceError(409, "knowledge_disabled");
    const prior = this.db
      .prepare(
        "SELECT id,kind FROM file_references WHERE session=? AND project=? AND path=? AND version=? AND start=? AND end=?",
      )
      .get(session, project, path, version, start, end);
    if (prior && prior.kind !== kind) throw new WorkspaceError(409, "reference_kind_conflict");
    if (prior) return String(prior.id);
    const size = this.db.prepare("SELECT count(*) AS n FROM file_references WHERE session=?").get(session);
    if (Number(size?.n) >= maxReferences) return null;
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO file_references(id,session,project,path,version,start,end,text,kind) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(id, session, project, path, version, start, end, text, kind);
      this.recordFileActivity(project, "attach", path, null, start, end);
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  removeReference(session: string, id: string) {
    this.db.prepare("DELETE FROM file_references WHERE session=? AND id=?").run(session, id);
  }

  beginApprovedWrite(project: string, action: "write" | "create", path: string) {
    return this.db
      .prepare("INSERT INTO file_activity(project,time,action,path,error) VALUES(?,?,?,?,?)")
      .run(project, Date.now(), action, path, "write_pending").lastInsertRowid;
  }
  finishApprovedWrite(id: number | bigint, error: string | null, backup: string | null) {
    this.db.prepare("UPDATE file_activity SET error=?,backup=? WHERE id=?").run(error, backup, id);
  }
  recordFileActivity(
    project: string,
    action: FileAction,
    path: string | null,
    error: string | null,
    start: number | null = null,
    end: number | null = null,
  ) {
    this.db
      .prepare("INSERT INTO file_activity(project,time,action,path,start,end,error) VALUES(?,?,?,?,?,?,?)")
      .run(project, Date.now(), action, path, start, end, error);
  }
  fileActivity(project: string): FileActivity[] {
    return this.db
      .prepare(
        "SELECT id,time,action,path,start,end,error,backup FROM file_activity WHERE project=? ORDER BY id DESC LIMIT 100",
      )
      .all(project) as unknown as FileActivity[];
  }

  catalog(): WorkspaceCatalog {
    return {
      projects: this.db
        .prepare("SELECT id,name,root, writeGrant IS NOT NULL AS writable FROM projects ORDER BY rowid")
        .all()
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          root: row.root as string | null,
          writable: !!row.writable,
        })),
      sections: this.db
        .prepare(
          `SELECT s.id,s.projectId,s.name,f.key AS stateKey,f.path AS statePath,f.version AS stateVersion
          FROM sections s LEFT JOIN section_state_source f ON f.section=s.id ORDER BY s.rowid`,
        )
        .all() as unknown as Section[],
    };
  }
  addProject(name: string) {
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run(id, name);
      this.addSection(id, "일반");
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  addSection(projectId: string, name: string) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sections VALUES(?,?,?)").run(id, projectId, name);
    return id;
  }
  project(id: string) {
    return this.db.prepare("SELECT root,identity,writeGrant FROM projects WHERE id=?").get(id) as
      | { root: string | null; identity: string | null; writeGrant: string | null }
      | undefined;
  }
  memoryEnabled() {
    return this.db.prepare("SELECT enabled FROM memory_settings WHERE id=1").get()?.enabled === 1;
  }
  setMemoryEnabled(enabled: boolean) {
    this.db.prepare("UPDATE memory_settings SET enabled=? WHERE id=1").run(Number(enabled));
  }
  knowledgeEnabled() {
    return this.db.prepare("SELECT enabled FROM knowledge_setting WHERE id=1").get()?.enabled === 1;
  }
  setKnowledgeEnabled(enabled: boolean) {
    this.db.prepare("UPDATE knowledge_setting SET enabled=? WHERE id=1").run(Number(enabled));
  }
  logsEnabled() {
    return this.db.prepare("SELECT enabled FROM call_log_setting WHERE id=1").get()?.enabled === 1;
  }
  setLogsEnabled(enabled: boolean) {
    this.db.prepare("UPDATE call_log_setting SET enabled=? WHERE id=1").run(Number(enabled));
  }
  clearCallLogs() {
    return Number(this.db.prepare("DELETE FROM call_log").run().changes);
  }
  startCall(kind: CallKind, selection: ModelSelection, session: string | null, budget?: ContextBudget) {
    try {
      if (!this.logsEnabled()) return;
    } catch {
      return;
    }
    // Project only numeric accounting and block IDs. The assembled context also contains input text.
    const contextBudget = budget && {
      estimatedInput: budget.estimatedInput,
      inputCeiling: budget.inputCeiling,
      blockUsage: budget.blockUsage,
    };
    const capture = new CallCapture(kind, selection, session, (log) => {
      const { request, usage, headers, body, bodyLimited, answer, answerLimited, ...summary } = log;
      this.db
        .prepare("INSERT INTO call_log VALUES(?,?,?)")
        .run(
          log.id,
          JSON.stringify(summary),
          JSON.stringify({ request, usage, contextBudget, headers, body, bodyLimited, answer, answerLimited }),
        );
    });
    this.protectCall?.(capture);
    return capture;
  }
  callList(includeUsage = false): CallSummary[] {
    const columns = includeUsage ? "summary, json_extract(detail, '$.usage') AS usage" : "summary";
    return this.db.prepare(`SELECT ${columns} FROM call_log ORDER BY rowid DESC`).all().map((row) => {
      const summary: CallSummary = JSON.parse(String(row.summary));
      if (typeof row.usage === "string") summary.usage = JSON.parse(row.usage);
      return summary;
    });
  }
  callDetails(selection?: string | readonly string[]): CallLog[] {
    const ids = typeof selection === "string" ? [selection] : selection;
    const rows = ids
      ? this.db.prepare(`SELECT summary,detail FROM call_log
          WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC`).all(JSON.stringify(ids))
      : this.db.prepare("SELECT summary,detail FROM call_log ORDER BY rowid DESC").all();
    return rows.map((row) => ({ ...JSON.parse(String(row.summary)), ...JSON.parse(String(row.detail)) }));
  }
  collaborationEnabled() {
    return this.db.prepare("SELECT enabled FROM collaboration_setting WHERE id=1").get()?.enabled === 1;
  }
  setCollaborationEnabled(enabled: boolean) {
    this.db.prepare("UPDATE collaboration_setting SET enabled=? WHERE id=1").run(Number(enabled));
  }
  review(requester: string, id?: string) {
    return this.db.prepare(`SELECT t.id,t.session_id AS reviewer,t.message,t.reply,t.status,t.provider,t.model
      FROM reviews r JOIN turns t ON r.id=t.id WHERE r.requester=? AND (? IS NULL OR r.id=?)
      ORDER BY r.rowid DESC LIMIT 1`).get(requester,id ?? null,id ?? null) as unknown as Review | undefined;
  }
  reviewHistory(requester: string) {
    return this.db.prepare(`SELECT t.id,t.session_id AS reviewer,substr(t.message,1,48) AS title,t.status,t.provider,t.model
      FROM reviews r JOIN turns t ON r.id=t.id WHERE r.requester=? ORDER BY r.rowid DESC`)
      .all(requester) as unknown as ReviewHistoryItem[];
  }
  reviewSelectionKey(id: string) {
    return this.db.prepare("SELECT selectionKey FROM reviews WHERE id=?").get(id)?.selectionKey ?? null;
  }
  startReview(requester: string, id: string, target: ModelSelection, message: string, selectionKey: string | null = null) {
    if (this.db.prepare("SELECT 1 FROM turns WHERE id=?").get(id)) throw new WorkspaceError(409, "review_id_conflict");
    if (this.review(requester)?.status === "streaming") throw new WorkspaceError(409, "review_busy");
    this.db.exec("BEGIN");
    try {
      const reviewer = this.create(target);
      this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(`검토 · ${Array.from(message).slice(0,24).join("")}`, reviewer.id);
      this.db.prepare(`INSERT INTO turns(id,session_id,message,status,preset,provider,model)
        VALUES(?,?,?,'streaming','general',?,?)`).run(id,reviewer.id,message,target.provider,target.model);
      this.db.prepare("INSERT INTO reviews(id,requester,selectionKey) VALUES(?,?,?)").run(id,requester,selectionKey);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finishReview(id: string, reply: string) {
    this.db.prepare("UPDATE turns SET reply=?,status='completed' WHERE id=? AND status='streaming'").run(reply,id);
  }
  updateMemoryEnabled() {
    return this.db.prepare("SELECT enabled FROM checkpoint_setting WHERE id=1").get()?.enabled === 1;
  }
  setUpdateMemoryEnabled(enabled: boolean) {
    this.db.prepare("UPDATE checkpoint_setting SET enabled=? WHERE id=1").run(Number(enabled));
  }
  sectionProject(id: string) {
    return this.db.prepare("SELECT projectId FROM sections WHERE id=?").get(id)?.projectId as
      | string
      | undefined;
  }
  checkpointTurns(session: string, limit: number) {
    return this.db
      .prepare(`SELECT id,substr(message,1,3001) AS message,substr(reply,1,3001) AS reply FROM turns
      WHERE session_id=? AND status='completed' AND rowid > COALESCE((SELECT MAX(t.rowid) FROM turns t
      JOIN checkpoints c ON c.last=t.id WHERE c.session=? AND c.saved=1),0) ORDER BY rowid LIMIT ?`)
      .all(session, session, limit) as unknown as Pick<Turn, "id" | "message" | "reply">[];
  }
  checkpoint(session: string, first?: string) {
    return (
      first
        ? this.db.prepare("SELECT * FROM checkpoints WHERE session=? AND first=?").get(session, first)
        : this.db.prepare("SELECT * FROM checkpoints WHERE session=? AND saved=0").get(session)
    ) as { sectionId: string; path: string; first: string; last: string; version: string; saved: number } | undefined;
  }
  reserveCheckpoint(session: string, first: string, last: string, path: string, version: string) {
    const result = this.db.prepare(`INSERT INTO checkpoints(session,first,last,path,version,sectionId)
      SELECT id,?,?,?,?,sectionId FROM sessions WHERE id=? AND sectionId IS NOT NULL`)
      .run(first, last, path, version, session);
    if (!result.changes) throw new WorkspaceError(409, "session_section_changed");
  }
  finishCheckpoint(path: string, saved: boolean) {
    if (saved) this.db.prepare("UPDATE checkpoints SET saved=1 WHERE path=?").run(path);
    else this.db.prepare("DELETE FROM checkpoints WHERE path=? AND saved=0").run(path);
  }
  recentCheckpoints(section: string) {
    return this.db
      .prepare(`SELECT path,version FROM checkpoints
      WHERE sectionId=? AND saved=1 ORDER BY rowid DESC LIMIT 3`)
      .all(section) as unknown as { path: string; version: string }[];
  }
  activeState(section: string) {
    return this.db
      .prepare(`SELECT f.key,f.path,f.version,p.root,p.identity FROM section_state_source f
      JOIN sections s ON f.section=s.id JOIN projects p ON s.projectId=p.id
      WHERE f.section=? AND p.root IS NOT NULL AND (SELECT enabled FROM memory_settings WHERE id=1)=1`)
      .get(section) as
      | { key: string; path: string; version: string; root: string; identity: string }
      | undefined;
  }
  setStateSource(
    project: string,
    section: string,
    previous: string | null,
    path: string,
    version: string | null,
  ) {
    const row = this.db
      .prepare(`SELECT f.key FROM sections s LEFT JOIN section_state_source f ON s.id=f.section
      WHERE s.id=? AND s.projectId=?`)
      .get(section, project);
    if (!row || row.key !== previous) return false;
    if (version === null) this.db.prepare("DELETE FROM section_state_source WHERE section=?").run(section);
    else
      this.db
        .prepare(`INSERT INTO section_state_source(section,key,path,version) VALUES(?,?,?,?)
      ON CONFLICT(section) DO UPDATE SET key=excluded.key,path=excluded.path,version=excluded.version`)
        .run(section, randomUUID(), path, version);
    return true;
  }
  sectionExists(id: string) {
    return !!this.db.prepare("SELECT 1 FROM sections WHERE id=?").get(id);
  }
  linkRoot(id: string, previous: string | null, root: RegisteredRoot | null, writable = false) {
    return (
      this.db
        .prepare("UPDATE projects SET root=?,identity=?,writeGrant=? WHERE id=? AND root IS ?")
        .run(root?.path ?? null, root?.identity ?? null, root && writable ? randomUUID() : null, id, previous)
        .changes === 1
    );
  }
  displaySettings(): DisplaySettings {
    const row = this.db.prepare("SELECT revision,rules FROM display_settings WHERE id=1").get();
    return { revision: Number(row?.revision), rules: JSON.parse(String(row?.rules)) };
  }
  setDisplayRules(revision: number, rules: DisplayRule[]) {
    return (
      this.db
        .prepare("UPDATE display_settings SET revision=revision+1,rules=? WHERE id=1 AND revision=?")
        .run(JSON.stringify(rules), revision).changes === 1
    );
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
    return this.db.prepare(`${sessionQuery} ORDER BY sessions.rowid DESC`).all().map(sessionFromRow);
  }
  create(selection: ModelSelection = { provider: "mock", model: "" }, sectionId: string | null = null) {
    const session: Session = {
      id: randomUUID(),
      title: defaultSessionTitle,
      preset: "general",
      provider: selection.provider,
      model: selection.model,
      sectionId,
    };
    this.db
      .prepare("INSERT INTO sessions(id,title,preset,provider,model,sectionId) VALUES (?, ?, ?, ?, ?, ?)")
      .run(session.id, "", session.preset, session.provider, session.model, sectionId);
    return this.get(session.id) ?? session;
  }
  get(id: string) {
    const row = this.db.prepare(`${sessionQuery} WHERE sessions.id=?`).get(id);
    return row && sessionFromRow(row);
  }
  requireSession(id: string) {
    const session = this.get(id);
    if (!session) throw new WorkspaceError(404, "unknown_session");
    return session;
  }
  changeSessionSection(id: string, sectionId: string | null, previous: string | null, revision: number) {
    if (sectionId !== null && !this.sectionExists(sectionId)) throw new WorkspaceError(400, "invalid_section");
    if (this.isStreaming(id)) throw new WorkspaceError(409, "session_busy");
    const changed = this.db.prepare(`UPDATE sessions SET sectionId=?, sectionRevision=sectionRevision+1
      WHERE id=? AND sectionId IS ? AND sectionRevision=?`).run(sectionId, id, previous, revision);
    if (!changed.changes) throw new WorkspaceError(409, "session_section_changed");
    return this.get(id);
  }
  setSessionArchived(id: string, archived: boolean) {
    if (this.isStreaming(id)) throw new WorkspaceError(409, "archive_streaming");
    const sql = archived
      ? "INSERT OR IGNORE INTO archived_sessions(session_id) VALUES (?)"
      : "DELETE FROM archived_sessions WHERE session_id=?";
    if (!this.db.prepare(sql).run(id).changes) throw new WorkspaceError(409, "archive_changed");
    this.deleteConfirmations.delete(id);
  }
  private deletionState(id: string) {
    const session = this.requireSession(id);
    if (!session.archived) throw new WorkspaceError(409, "delete_requires_archive");
    const activeReview = this.db.prepare(`SELECT 1 FROM reviews JOIN turns ON turns.id=reviews.id
      WHERE requester=? AND status='streaming' LIMIT 1`).get(id);
    if (this.isStreaming(id) || activeReview)
      throw new WorkspaceError(409, "delete_busy");
    const details = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM turns WHERE session_id=?) AS turns,
      (SELECT group_concat(id) FROM file_references WHERE session=?) AS attachments,
      (SELECT group_concat(path) FROM checkpoints WHERE session=?) AS summaries,
      (SELECT count(*) FROM checkpoints WHERE session=? AND saved=1) AS savedSummaries,
      (SELECT group_concat(id) FROM reviews WHERE requester=?) AS reviews`).get(id, id, id, id, id);
    return {
      title: session.title, turns: Number(details?.turns), savedSummaries: Number(details?.savedSummaries),
      snapshot: JSON.stringify([session, details, this.sources(id).revision, this.limits(id)]),
    };
  }
  prepareDeletion(id: string) {
    const { title, turns, savedSummaries, snapshot } = this.deletionState(id);
    const token = randomUUID();
    this.deleteConfirmations.set(id, { token, snapshot });
    return { title, turns, savedSummaries, confirmation: token };
  }
  deleteArchivedSession(id: string, token: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { snapshot } = this.deletionState(id);
      const pending = this.deleteConfirmations.get(id);
      if (!pending || pending.token !== token || pending.snapshot !== snapshot)
        throw new WorkspaceError(409, "delete_changed");
      this.db.prepare("DELETE FROM reviews WHERE requester=? OR id IN (SELECT id FROM turns WHERE session_id=?)").run(id, id);
      this.db.prepare("DELETE FROM checkpoints WHERE session=?").run(id);
      this.db.prepare("DELETE FROM file_references WHERE session=?").run(id);
      this.db.prepare("DELETE FROM call_log WHERE json_extract(summary,'$.session')=?").run(id);
      for (const table of ["context_limits", "session_sources", "archived_sessions", "turns"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
      }
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.db.exec("COMMIT");
      this.deleteConfirmations.delete(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  turns(id: string) {
    return this.db
      .prepare(
        "SELECT id,message,reply,status,preset,provider,model FROM turns WHERE session_id=? ORDER BY rowid",
      )
      .all(id) as unknown as Turn[];
  }
  async searchTurns(query: string, disconnected: () => boolean = () => false): Promise<TurnSearchResponse> {
    const needle = query.normalize("NFC");
    const results: TurnSearchHit[] = [];
    const batch = this.db.prepare(`SELECT turns.rowid AS sequence, turns.id, session_id, message, reply,
      ${displayedTitle} AS title FROM turns JOIN sessions ON sessions.id=turns.session_id
      WHERE turns.rowid <= ? ORDER BY turns.rowid DESC LIMIT 32`);
    const ordinal = this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id=? AND rowid<=?");
    let through = Number(this.db.prepare("SELECT MAX(rowid) AS n FROM turns").get()?.n);
    // End the SQLite statement before yielding so long searches can coexist with streaming writes.
    while (through > 0 && !disconnected()) {
      const ceiling = through;
      through = 0;
      for (const row of batch.iterate(ceiling)) {
        through = Number(row.sequence) - 1;
        for (const field of ["message", "reply"] as const) {
          const text = String(row[field]).normalize("NFC");
          const match = text.indexOf(needle);
          if (match === -1) continue;
          if (results.length === maxTurnSearchResults) return { results, truncated: true };
          const start = Math.max(0, match - 48);
          const end = Math.min(text.length, match + needle.length + 48);
          const excerpt = text.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
          results.push({
            sessionId: String(row.session_id), title: String(row.title), turnId: String(row.id),
            turnNumber: Number(ordinal.get(String(row.session_id), Number(row.sequence))?.n), field,
            snippet: (start ? "…" : "") + excerpt + (end < text.length ? "…" : ""),
          });
        }
      }
      if (through > 0) await yieldToServer();
    }
    return { results, truncated: false };
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
      .prepare("SELECT prompt,responseLanguage,block_order FROM shared_prompt LEFT JOIN prompt_layout USING(id) WHERE id=1")
      .get();
    return {
      prompt: String(row?.prompt ?? ""),
      responseLanguage: isResponseLanguage(row?.responseLanguage) ? row.responseLanguage : "auto",
      order: row?.block_order ? JSON.parse(String(row.block_order)) : defaultOrder,
    };
  }
  setResponseLanguage(language: ResponseLanguage, previous: ResponseLanguage) {
    return this.db.prepare("UPDATE shared_prompt SET responseLanguage=? WHERE id=1 AND responseLanguage=?")
      .run(language, previous).changes === 1;
  }
  setPromptSettings(value: Pick<PromptSettings, "prompt" | "order">, previous: string, previousOrder: Block[]) {
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
  customPresets(includeArchived = false): CustomPresetSummary[] {
    const rows = this.db
      .prepare("SELECT id,name,archived FROM custom_presets WHERE archived=0 OR ?=1 ORDER BY name,id")
      .all(Number(includeArchived));
    return rows.map((row) => ({
      id: row.id as CustomPresetId,
      name: String(row.name),
      ...(includeArchived && { archived: row.archived === 1 }),
    }));
  }
  setPresetArchived(id: CustomPresetId, archived: boolean) {
    const result = this.db.prepare("UPDATE custom_presets SET archived=? WHERE id=?").run(Number(archived), id);
    if (!result.changes) throw new WorkspaceError(404, "unknown_preset");
  }
  presetContent(id: Preset) {
    if (isBuiltinPreset(id)) return id;
    const row = this.db.prepare("SELECT id,name,instructions FROM custom_presets WHERE id=?").get(id);
    if (!row) throw new WorkspaceError(404, "unknown_preset");
    return row as unknown as CustomPreset;
  }
  addPreset(name: string, text: string): CustomPreset {
    const instructions = normalizePresetText(text);
    const existing = this.db.prepare("SELECT * FROM custom_presets WHERE name=?").get(name);
    if (existing) {
      if (normalizePresetText(String(existing.instructions)) !== instructions) throw new WorkspaceError(409, "preset_name_taken");
      return {
        id: existing.id as CustomPresetId,
        name,
        instructions: String(existing.instructions),
        ...(existing.archived === 1 && { archived: true }),
      };
    }
    const id: CustomPresetId = `custom-${randomUUID()}`;
    this.db.prepare("INSERT INTO custom_presets(id,name,instructions) VALUES(?,?,?)").run(id, name, instructions);
    return { id, name, instructions };
  }
  rename(id: string, previous: string, title: string) {
    return this.db.prepare(`UPDATE sessions SET title=? WHERE id=? AND (${displayedTitle}=? OR title=?)`)
      .run(title, id, previous, title).changes === 1;
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
          .prepare("UPDATE sessions SET title=? WHERE id=? AND title=''")
          .run(Array.from(message.trim()).slice(0, 32).join(""), session.id);
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
