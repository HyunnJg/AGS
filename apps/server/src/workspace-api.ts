import type { IncomingMessage } from "node:http";
import type { SessionStore } from "./sessions.ts";
import { WorkspaceError, listEntries, readLines, registerFolder } from "./workspace-files.ts";

type Json = (value: unknown, status?: number) => void;
export async function workspaceApi(
  path: string,
  req: IncomingMessage,
  store: SessionStore,
  privateDir: string,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: Json,
  allow: (methods: string) => void,
) {
  const route = /^\/api\/projects(?:\/([a-f0-9-]{36})\/(sections|root|entries|file))?$/.exec(path);
  if (!route) throw new WorkspaceError(404, "unknown_route");
  const [, id, action] = route;
  if (!id && req.method === "GET") return json(store.catalog());
  const project = id ? store.project(id) : undefined;
  if (id && !project) throw new WorkspaceError(404, "unknown_project");
  const method = action === "root" ? "PUT" : "POST";
  if (req.method !== method) return allow(id ? method : "GET, POST");
  const body = await readBody(req);
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
        !("previous" in body) ||
        (body.previous !== null && typeof body.previous !== "string") ||
        !("path" in body) ||
        (body.path !== null && (typeof body.path !== "string" || !body.path || body.path.length > 4096))
      )
        throw new WorkspaceError(400, "invalid_folder");
      const root = body.path === null ? null : await registerFolder(body.path, privateDir);
      if (!store.linkRoot(id, body.previous, root)) throw new WorkspaceError(409, "folder_changed");
      return json({ root: root?.path ?? null });
    }
    if (!project.root || !project.identity) throw new WorkspaceError(409, "no_workspace_folder");
    if (!("path" in body) || typeof body.path !== "string" || body.path.length > 4096)
      throw new WorkspaceError(400, "invalid_path");
    if ("root" in body && body.root !== project.root) throw new WorkspaceError(409, "folder_changed");
    const root = { path: project.root, identity: project.identity };
    const listing = action === "entries";
    const n = listing ? ("offset" in body ? body.offset : 0) : "start" in body ? body.start : 1;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < (listing ? 0 : 1))
      throw new WorkspaceError(400, "invalid_range");
    const result = listing ? await listEntries(root, body.path, n) : await readLines(root, body.path, n);
    const current = store.project(id);
    if (current?.root !== root.path || current.identity !== root.identity)
      throw new WorkspaceError(409, "folder_changed");
    return json(result);
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    if (e && typeof e === "object" && "code" in e && ["ENOENT", "ENOTDIR", "ESTALE"].includes(String(e.code)))
      throw new WorkspaceError(404, "path_unavailable");
    if (e && typeof e === "object" && "code" in e && ["EACCES", "EPERM", "ELOOP"].includes(String(e.code)))
      throw new WorkspaceError(403, "outside_workspace");
    throw e;
  }
}
