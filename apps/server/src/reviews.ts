import { callStatus } from "../../../packages/providers/src/capture.ts";
import { isModelSelection } from "../../../packages/contracts/src/providers.ts";
import { reviewInputLimit, reviewOutputTokens } from "../../../packages/contracts/src/reviews.ts";
import { ProviderError, type configureProviders } from "../../../packages/providers/src/compatible.ts";
import { streamMock } from "../../../packages/providers/src/mock.ts";
import { messageCost } from "./context.ts";
import type { SessionStore } from "./sessions.ts";
import { WorkspaceError } from "./workspace-files.ts";

export async function runReview(
  db: SessionStore,
  requester: string,
  body: unknown,
  providers: ReturnType<typeof configureProviders>,
  signal: AbortSignal,
  started?: (id: string) => void,
) {
  if (
    !body ||
    typeof body !== "object" ||
    !("approved" in body) ||
    body.approved !== true ||
    !("id" in body) ||
    typeof body.id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.id) ||
    !("target" in body) ||
    !isModelSelection(body.target) ||
    !("message" in body) ||
    typeof body.message !== "string" ||
    !body.message.trim() ||
    body.message.length > reviewInputLimit
  )
    throw new WorkspaceError(400, "invalid_review");
  const { id, target } = body;
  const message = body.message.trim();
  const existing = db.review(requester, id);
  if (existing) {
    if (
      existing.message !== message ||
      existing.provider !== target.provider ||
      existing.model !== target.model
    )
      throw new WorkspaceError(409, "review_id_conflict");
    return existing;
  }
  if (!db.collaborationEnabled()) throw new WorkspaceError(403, "review_disabled");
  if (!providers.options.find((o) => o.id === target.provider)?.enabled)
    throw new WorkspaceError(400, "review_target_unavailable");
  const messages = [
    {
      role: "system" as const,
      content:
        "독립 검토자로서 요청된 범위 안에서 검토하세요. 발견사항과 근거, 불확실성 및 개선 제안을 구분하세요.",
    },
    { role: "user" as const, content: message },
  ];
  const window = providers.contextWindow(target.provider, target.model);
  if (window && messages.reduce((size, m) => size + messageCost(m.content), reviewOutputTokens) > window)
    throw new WorkspaceError(422, "review_budget");
  signal.throwIfAborted();
  db.startReview(requester, id, target, message);
  const capture = db.startCall("review", target, requester);
  try {
    started?.(id);
    const stream =
      target.provider === "mock"
        ? streamMock(message, signal)
        : providers.stream(target, messages, signal, undefined, reviewOutputTokens, capture);
    let result = "";
    for await (const part of stream) {
      capture?.answer(part);
      result += part;
      if (result.length > 16000) throw new WorkspaceError(422, "review_too_long");
    }
    signal.throwIfAborted();
    if (!result.trim()) throw new WorkspaceError(502, "review_empty");
    db.finishReview(id, result);
    capture?.finish("completed");
  } catch (error) {
    capture?.finish(callStatus(signal));
    db.finish(id, signal.aborted ? "cancelled" : "failed");
    if (signal.aborted) throw new WorkspaceError(408, "review_cancelled");
    if (error instanceof ProviderError) throw new WorkspaceError(502, error.code);
    throw error;
  }
  return db.review(requester, id);
}
