import { stateText } from "./section-state.ts";
import { workspaceWrite } from "./workspace-writes.ts";
import { maxReferenceChars } from "../../../packages/contracts/src/workspace.ts";
import type { IncomingMessage } from "node:http";
import type { SessionStore } from "./sessions.ts";
import {
  WorkspaceError,
  listEntries,
  readLines,
  registerFolder,
  searchWorkspace,
} from "./workspace-files.ts";

type Json = (value: unknown, status?: number) => void;
export async function workspaceApi(
  path: string,
  req: IncomingMessage,
  store: SessionStore,
  privateDir: string,
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>,
  json: Json,
  allow: (methods: string) => void,
) {
  const route =
    /^\/api\/projects(?:\/([a-f0-9-]{36})\/(sections|root|entries|file|search|activity|attach|state-source|edit|propose|approve))?$/.exec(
      path,
    );
  if (!route) throw new WorkspaceError(404, "unknown_route");
  const [, id, action] = route;
  if (!id && req.method === "GET") return json(store.catalog());
  const project = id ? store.project(id) : undefined;
  if (id && !project) throw new WorkspaceError(404, "unknown_project");
  if (action === "activity" && id) return req.method === "GET" ? json(store.fileActivity(id)) : allow("GET");
  const method = action === "root" ? "PUT" : "POST";
  if (req.method !== method) return allow(id ? method : "GET, POST");
  const body = await readBody(req, action === "propose" ? 6 * 1024 * 1024 + 8192 : undefined);
  if (!body || typeof body !== "object") throw new WorkspaceError(400, "invalid_workspace_request");
  if (!id || action === "sections") {
    if (!("name" in body) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)
      throw new WorkspaceError(400, "invalid_name");
    const name = body.name.trim();
    return json({ id: id ? store.addSection(id, name) : store.addProject(name) }, 201);
  }
  if (!project) throw new WorkspaceError(404, "unknown_project");
  try {
    if (action === "root") {
      if (
        ("writable" in body && typeof body.writable !== "boolean") ||
        !("previous" in body) ||
        (body.previous !== null && typeof body.previous !== "string") ||
        !("path" in body) ||
        (body.path !== null && (typeof body.path !== "string" || !body.path || body.path.length > 4096))
      )
        throw new WorkspaceError(400, "invalid_folder");
      const root = body.path === null ? null : await registerFolder(body.path, privateDir);
      if (!store.linkRoot(id, body.previous, root, "writable" in body && body.writable === true))
        throw new WorkspaceError(409, "folder_changed");
      return json({ root: root?.path ?? null });
    }
    if (!project.root || !project.identity) throw new WorkspaceError(409, "no_workspace_folder");
    if (!("path" in body) || typeof body.path !== "string" || body.path.length > 4096)
      throw new WorkspaceError(400, "invalid_path");
    if ("root" in body && body.root !== project.root) throw new WorkspaceError(409, "folder_changed");
    const root = { path: project.root, identity: project.identity };
    if (action === "edit" || action === "propose" || action === "approve")
      return json(
        await workspaceWrite(
          store,
          id,
          root,
          project.writeGrant,
          action,
          body as Record<string, unknown>,
          privateDir,
        ),
      );
    const checkActive = () => {
      if (req.socket.destroyed) throw new WorkspaceError(409, "search_cancelled");
      const current = store.project(id);
      if (current?.root !== root.path || current.identity !== root.identity)
        throw new WorkspaceError(409, "folder_changed");
    };
    if (action === "state-source") {
      if (
        !("section" in body) ||
        typeof body.section !== "string" ||
        !("root" in body) ||
        !("previous" in body) ||
        !(body.previous === null || typeof body.previous === "string") ||
        !("version" in body) ||
        !(body.version === null || (typeof body.version === "string" && /^[a-f0-9]{64}$/.test(body.version)))
      )
        throw new WorkspaceError(400, "invalid_state_file");
      if (body.version !== null) await stateText(root, body.path, body.version);
      checkActive();
      if (!store.setStateSource(id, body.section, body.previous, body.path, body.version))
        throw new WorkspaceError(409, "state_source_changed");
      return json({ saved: true });
    }
    if (action === "attach") {
      if (!("session" in body) || typeof body.session !== "string" || !store.get(body.session))
        throw new WorkspaceError(404, "unknown_session");
      if (
        !("root" in body) ||
        !("version" in body) ||
        typeof body.version !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.version)
      )
        throw new WorkspaceError(400, "invalid_version");
      if (
        !("start" in body) ||
        !("end" in body) ||
        typeof body.start !== "number" ||
        typeof body.end !== "number" ||
        !Number.isSafeInteger(body.start) ||
        !Number.isSafeInteger(body.end) ||
        body.start < 1 ||
        body.end < body.start ||
        body.end - body.start >= 80
      )
        throw new WorkspaceError(400, "invalid_range");
      const page = await readLines(root, body.path, body.start, body.version, body.end - body.start + 1);
      if (page.end !== body.end || !page.text.trim()) throw new WorkspaceError(400, "invalid_range");
      if (page.clipped || page.text.length > maxReferenceChars)
        throw new WorkspaceError(413, "reference_too_large");
      checkActive();
      const reference = store.addReference(
        body.session,
        id,
        body.path,
        body.version,
        page.start,
        page.end,
        page.text,
      );
      if (!reference) throw new WorkspaceError(409, "reference_limit");
      return json({ id: reference });
    }
    if (action === "search") {
      if (
        ("caseSensitive" in body && typeof body.caseSensitive !== "boolean") ||
        !("query" in body) ||
        typeof body.query !== "string" ||
        !body.query.trim() ||
        body.query.length > 120 ||
        /[\r\n]/.test(body.query)
      )
        throw new WorkspaceError(400, "invalid_search");
      const result = await searchWorkspace(
        root,
        body.path,
        body.query,
        checkActive,
        !("caseSensitive" in body) || body.caseSensitive === true,
      );
      checkActive();
      store.recordFileActivity(id, "search", body.path, null);
      return json(result);
    }
    const listing = action === "entries";
    const n = listing ? ("offset" in body ? body.offset : 0) : "start" in body ? body.start : 1;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < (listing ? 0 : 1))
      throw new WorkspaceError(400, "invalid_range");
    const version = "version" in body ? body.version : undefined;
    if (version !== undefined && (typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version)))
      throw new WorkspaceError(400, "invalid_version");
    const result = listing
      ? await listEntries(root, body.path, n)
      : await readLines(root, body.path, n, version);
    checkActive();
    if ("start" in result)
      store.recordFileActivity(
        id,
        "file",
        body.path,
        null,
        result.total ? result.start : null,
        result.total ? result.end : null,
      );
    else store.recordFileActivity(id, "entries", body.path, null);
    return json(result);
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    let error = e;
    if (["ENOENT", "ENOTDIR", "ESTALE"].includes(code)) error = new WorkspaceError(404, "path_unavailable");
    if (["EACCES", "EPERM", "ELOOP"].includes(code)) error = new WorkspaceError(403, "outside_workspace");
    if (action === "entries" || action === "file" || action === "search" || action === "attach")
      store.recordFileActivity(
        id,
        action,
        null,
        error instanceof WorkspaceError ? error.message : "internal_error",
      );
    throw error;
  }
}
