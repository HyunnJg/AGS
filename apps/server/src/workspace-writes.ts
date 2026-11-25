import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { WritePreview } from "../../../packages/contracts/src/workspace.ts";
import type { SessionStore } from "./sessions.ts";
import { locate, readSnapshot, validPart, WorkspaceError, type RegisteredRoot } from "./workspace-files.ts";

type Plan = {
  id: string;
  project: string;
  grant: string;
  path: string;
  parentId: string;
  originalId: string | null;
  originalHash: string | null;
  bytes: Buffer;
  expires: number;
  published?: { receipt: number | bigint; backup: string | null };
  busy?: boolean;
};
const plansByStore = new WeakMap<SessionStore, Map<string, Plan>>();
function plansFor(store: SessionStore) {
  let plans = plansByStore.get(store);
  if (!plans) {
    plans = new Map();
    plansByStore.set(store, plans);
  }
  for (const [id, plan] of plans) if (!plan.busy && plan.expires < Date.now()) plans.delete(id);
  return plans;
}
function conflict(): never {
  throw new WorkspaceError(409, "write_conflict");
}
function hash(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
function targetParts(path: string) {
  const parts = path.split("/");
  if (parts.some((p) => !validPart(p))) throw new WorkspaceError(403, "outside_workspace");
  const name = parts.pop() as string;
  return { directory: parts.join("/"), name };
}
function getStamp(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return { stat, id: `${stat.dev}:${stat.ino}` };
}
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
function splitLines(text: string) {
  return text ? text.split(/\r\n|\n|\r/) : [];
}
function changes(before: string[], after: string[]) {
  let prefix = 0,
    suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return {
    first: prefix + 1,
    removed: before.slice(prefix, before.length - suffix),
    added: after.slice(prefix, after.length - suffix),
    suffix,
  };
}
// Reuse line endings from the original, including untouched lines after an insertion.
function encode(text: string, next: string, bom: boolean) {
  const before = splitLines(text),
    after = splitLines(next);
  const diff = changes(before, after);
  const endings = text.match(/\r\n|\r|\n/g) ?? [];
  const encoded = after
    .map((line, i) => {
      if (i + 1 === after.length) return line;
      const old = i >= after.length - diff.suffix ? i + before.length - after.length : i;
      return line + (endings[old] ?? endings[0] ?? "\n");
    })
    .join("");
  return { diff, bytes: Buffer.from((bom ? "\uFEFF" : "") + encoded) };
}
function checkGrant(store: SessionStore, id: string, grant: string, root: RegisteredRoot) {
  const p = store.project(id);
  if (p?.writeGrant !== grant || p.root !== root.path || p.identity !== root.identity)
    throw new WorkspaceError(409, "folder_changed");
}
async function original(root: RegisteredRoot, path: string) {
  try {
    return await readSnapshot(root, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") conflict();
    throw e;
  }
}
export async function workspaceWrite(
  store: SessionStore,
  project: string,
  root: RegisteredRoot,
  grant: string | null,
  action: string,
  body: Record<string, unknown>,
  privateDir: string,
) {
  if (!grant || !privateDir) throw new WorkspaceError(403, "write_disabled");
  if (typeof body.path !== "string" || body.path.length > 4096 || body.root !== root.path)
    throw new WorkspaceError(400, "invalid_path");
  const path = body.path;
  const { directory, name } = targetParts(path);
  const plans = plansFor(store);
  if (action === "approve") {
    const plan = typeof body.id === "string" ? plans.get(body.id) : undefined;
    if (
      body.approved !== true ||
      !plan ||
      plan.project !== project ||
      plan.path !== path ||
      plan.grant !== grant
    )
      throw new WorkspaceError(409, "invalid_proposal");
    if (plan.published) {
      store.finishApprovedWrite(plan.published.receipt, null, plan.published.backup);
      return { path };
    }
    if (plan.busy) throw new WorkspaceError(409, "write_busy");
    plan.busy = true;
    const operation = plan.originalId ? "write" : "create";
    let receipt: number | bigint | undefined;
    let backupName: string | null = null;
    try {
      const parent = await locate(root, directory);
      if (!parent.stat.isDirectory() || parent.id !== plan.parentId) conflict();
      const snap = plan.originalId ? await original(root, path) : null;
      if (snap && (snap.id !== plan.originalId || hash(snap.bytes) !== plan.originalHash)) conflict();
      checkGrant(store, project, grant, root);
      const target = join(parent.target, name);
      const verify = () => {
        if (
          getStamp(root.path).id !== root.identity ||
          relative(parent.target, realpathSync(parent.target)) !== "" ||
          getStamp(parent.target).id !== parent.id
        )
          conflict();
        if (!snap) {
          if (exists(target)) conflict();
          return;
        }
        if (!exists(target)) conflict();
        const current = getStamp(target);
        if (
          current.id !== snap.id ||
          current.stat.nlink !== 1n ||
          current.stat.ctimeNs !== snap.stat.ctimeNs ||
          current.stat.size !== snap.stat.size
        )
          conflict();
      };
      verify();
      if (snap) {
        const fd = openSync(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const st = fstatSync(fd, { bigint: true });
          if (st.ino !== snap.stat.ino || st.dev !== snap.stat.dev) conflict();
        } finally {
          closeSync(fd);
        }
      }
      // No event-loop yield during the final check and publication, including across projects sharing a folder.
      const temp = join(parent.target, `.ags-stage-${randomUUID()}`);
      receipt = store.beginApprovedWrite(project, operation, path);
      const fd = openSync(temp, "wx", 0o600);
      const tempStat = fstatSync(fd, { bigint: true });
      try {
        try {
          writeFileSync(fd, plan.bytes);
          if (snap && process.platform !== "win32") fchmodSync(fd, Number(snap.stat.mode & 0o777n));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        verify();
        if (snap) {
          const backups = join(privateDir, "backups");
          mkdirSync(backups, { recursive: true, mode: 0o700 });
          if (
            lstatSync(backups).isSymbolicLink() ||
            relative(realpathSync(privateDir), realpathSync(backups)) !== "backups"
          )
            throw new WorkspaceError(403, "outside_workspace");
          const backup = join(backups, `${plan.id}.bak`);
          const backupFd = openSync(backup, "wx", 0o600);
          try {
            writeFileSync(backupFd, snap.bytes);
            fsyncSync(backupFd);
          } finally {
            closeSync(backupFd);
          }
          backupName = `${plan.id}.bak`;
          verify();
          if (getStamp(temp).id !== `${tempStat.dev}:${tempStat.ino}`) conflict();
          renameSync(temp, target);
        } else {
          // Publishing a new file must never overwrite one created since preview.
          if (getStamp(temp).id !== `${tempStat.dev}:${tempStat.ino}`) conflict();
          try {
            linkSync(temp, target);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") conflict();
            throw e;
          }
        }
        plan.published = { receipt, backup: backupName };
      } finally {
        if (exists(temp) && getStamp(temp).id === `${tempStat.dev}:${tempStat.ino}`) unlinkSync(temp);
      }
      store.finishApprovedWrite(receipt, null, backupName);
      return { path };
    } catch (e) {
      const reason = e instanceof WorkspaceError ? e.message : "write_failed";
      if (receipt === undefined) store.recordFileActivity(project, operation, null, reason);
      else if (!plan.published) store.finishApprovedWrite(receipt, reason, backupName);
      throw e;
    } finally {
      plan.busy = false;
    }
  }
  const creating = body.version === null;
  if (!creating && (typeof body.version !== "string" || !/^[a-f0-9]{64}$/.test(body.version)))
    throw new WorkspaceError(400, "invalid_version");
  const parent = await locate(root, directory);
  if (!parent.stat.isDirectory()) throw new WorkspaceError(400, "not_directory");
  const snap = creating ? null : await original(root, path);
  if (creating && exists(join(parent.target, name))) conflict();
  if (snap && hash(snap.text) !== body.version) conflict();
  checkGrant(store, project, grant, root);
  if (action === "edit") return { text: snap?.text ?? "" };
  if (
    typeof body.text !== "string" ||
    Buffer.byteLength(body.text) > 1024 * 1024 ||
    Buffer.from(body.text).some((b) => b < 9 || (b > 13 && b < 32))
  )
    throw new WorkspaceError(400, "invalid_edit");
  const { diff, bytes } = encode(
    snap?.text ?? "",
    body.text,
    snap?.bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ?? false,
  );
  if (bytes.length > 1024 * 1024) throw new WorkspaceError(413, "file_too_large");
  if (snap && bytes.equals(snap.bytes)) throw new WorkspaceError(400, "no_changes");
  const id = randomUUID();
  if (plans.size >= 32) {
    const oldest = [...plans.values()].find((p) => !p.busy);
    if (oldest) plans.delete(oldest.id);
    else throw new WorkspaceError(409, "write_busy");
  }
  plans.set(id, {
    id,
    project,
    grant,
    path,
    parentId: parent.id,
    originalId: snap?.id ?? null,
    originalHash: snap ? hash(snap.bytes) : null,
    bytes,
    expires: Date.now() + 15 * 60_000,
  });
  return {
    id,
    path,
    action: creating ? "create" : "write",
    first: diff.first,
    removed: diff.removed,
    added: diff.added,
  } satisfies WritePreview;
}
