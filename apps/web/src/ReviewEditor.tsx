import { useEffect, useRef, useState } from "react";
import { providerNames, type ModelSelection } from "../../../packages/contracts/src/providers.ts";
import {
  reviewInputLimit,
  reviewMessage,
  type ReviewHistoryItem,
  reviewOutputTokens,
  type Review,
} from "../../../packages/contracts/src/reviews.ts";
import type { Session, Turn } from "../../../packages/contracts/src/sessions.ts";
import type { FileReference, Project, WorkspaceCatalog } from "../../../packages/contracts/src/workspace.ts";
import { api } from "./api.ts";
import { FileWrite } from "./FileWrite.tsx";

const states = {
  streaming: "검토 중",
  completed: "검토 완료",
  cancelled: "중단됨",
  interrupted: "서버 종료로 중단됨",
  failed: "검토 실패",
};

function ReviewResult({
  token,
  review,
  project,
  insert,
}: {
  token: string;
  review: Review;
  project: Project | undefined;
  insert: (value: string) => void;
}) {
  const [excerpt, setExcerpt] = useState(review.reply);
  const [notice, setNotice] = useState("");
  return (
    <section>
      <small>
        {providerNames[review.provider]} {review.model} · {states[review.status]}
      </small>
      <details>
        <summary>보낸 요청</summary>
        <pre>{review.message}</pre>
      </details>
      {review.status === "completed" && (
        <>
          <label>
            반영할 검토 내용
            <textarea rows={4} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={!excerpt.trim()}
            onClick={() => {
              insert(excerpt.trim());
              setNotice("현재 대화 입력창에 추가했습니다.");
            }}
          >
            입력창에 추가
          </button>
          {(!project?.root || !project.writable) && (
            <small>
              프로젝트 섹션에서 작업 폴더를 승인형 저장으로 연결하면 검토 결과를 파일로 저장할 수 있습니다.
            </small>
          )}
          {project?.root && project.writable && (
            <FileWrite
              key={project.root}
              token={token}
              project={project}
              path=""
              version={null}
              session={undefined}
              initialFile={{
                name: `AGS-검토-${review.id}.md`,
                text: `# 검토 결과\n\n요청 ID: ${review.id}\n검토 대화: ${review.reviewer}\n모델: ${providerNames[review.provider]} ${review.model}\n\n## 요청\n\n${review.message}\n\n## 결과\n\n${review.reply}\n`,
              }}
              saved={(path) => setNotice(`작업 폴더에 저장했습니다 · ${path}`)}
            />
          )}
        </>
      )}
      {notice && <output>{notice}</output>}
    </section>
  );
}

function ReplyExcerpt({ turns, draft, references, insert }: {
  turns: Turn[];
  draft: string;
  references: FileReference[];
  insert: (value: string) => void;
}) {
  const replies = turns.filter(turn => turn.status === "completed" && turn.reply).reverse();
  const [sourceId, setSourceId] = useState(replies[0]?.id ?? "");
  const field = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState("");
  const source = replies.find(turn => turn.id === sourceId) ?? replies[0];
  if (!source) return <small>완료된 답변이 없습니다.</small>;
  function append() {
    if (!field.current) return;
    const { value, selectionStart, selectionEnd } = field.current;
    const excerpt = value.slice(selectionStart, selectionEnd);
    if (!excerpt.trim()) {
      setNotice("원문에서 검토할 부분을 선택하세요.");
      return;
    }
    const next = draft ? `${draft}\n\n${excerpt}` : excerpt;
    if (next.length > reviewInputLimit || reviewMessage(next, references).length > reviewInputLimit) {
      setNotice("첨부 자료를 포함해 8,000자 이내가 되도록 선택 범위나 초안을 줄이세요.");
      return;
    }
    insert(next);
    setNotice("선택한 부분을 검토 초안에 추가했습니다.");
  }
  return (
    <>
      <label>
        발췌할 답변
        <select value={source.id} onChange={e => {
          setSourceId(e.target.value);
          setNotice("");
        }}>
          {replies.map((turn, index) => (
            <option key={turn.id} value={turn.id}>
              {replies.length - index}. {turn.message.slice(0, 60)} · {providerNames[turn.provider]} {turn.model}
            </option>
          ))}
        </select>
      </label>
      <label>
        답변 원문에서 보낼 부분 선택
        <textarea key={source.id} ref={field} rows={5} readOnly value={source.reply} />
      </label>
      <button type="button" onClick={append}>선택한 부분을 검토 초안에 추가</button>
      {notice && <output>{notice}</output>}
    </>
  );
}

export function ReviewEditor({
  token,
  session,
  choices,
  references,
  turns,
  insert,
  onCreated,
}: {
  token: string;
  session: Session;
  choices: ModelSelection[];
  references: FileReference[];
  turns: Turn[];
  insert: (value: string) => void;
  onCreated: (id: string, open?: boolean) => void;
}) {
  const route = `/api/sessions/${session.id}/review`;
  const [open, setOpen] = useState(false);
  const [excerptOpen, setExcerptOpen] = useState(false);
  const lastReply = turns.findLast(turn => turn.status === "completed")?.reply ?? "";
  const [enabled, setEnabled] = useState(false);
  const [project, setProject] = useState<Project>();
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState(JSON.stringify(["mock", ""]));
  const [review, setReview] = useState<Review | null>(null);
  const [history, setHistory] = useState<ReviewHistoryItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = selectedIds.flatMap((id) => references.filter((r) => r.id === id && !r.paused));
  const missing = selected.length !== selectedIds.length;
  const preview = reviewMessage(message, selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [latest, refresh] = useState({ route });
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const [r, items] = await Promise.all([
          api(token, latest.route, "GET", undefined, c.signal).then((res) => res.json()),
          api(token, `${latest.route}/history`, "GET", undefined, c.signal).then((res) => res.json()),
        ]);
        if (!c.signal.aborted) {
          setReview(r);
          setHistory(items);
          if (r && attempt.current?.id === r.id && r.status !== "streaming") attempt.current = null;
          if (r?.status === "streaming") timer = setTimeout(load, 1000);
        }
      } catch (e) {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : "검토를 읽지 못했습니다.");
      }
    }
    async function settings() {
      try {
        const setting = await (
          await api(token, "/api/settings/collaboration", "GET", undefined, c.signal)
        ).json();
        if (!c.signal.aborted) setEnabled(setting.enabled);
        if (session.sectionId) {
          const catalog: WorkspaceCatalog = await (
            await api(token, "/api/projects", "GET", undefined, c.signal)
          ).json();
          const parent = catalog.sections.find((s) => s.id === session.sectionId)?.projectId;
          if (!c.signal.aborted) setProject(catalog.projects.find((p) => p.id === parent));
        }
      } catch (e) {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : "설정을 읽지 못했습니다.");
      }
    }
    if (!busy) void load();
    void settings();
    window.addEventListener("ags-collaboration-setting", settings);
    window.addEventListener("focus", settings);
    return () => {
      c.abort();
      clearTimeout(timer);
      window.removeEventListener("ags-collaboration-setting", settings);
      window.removeEventListener("focus", settings);
    };
  }, [open, token, latest, session.sectionId, busy]);
  const available = choices.some((c) => JSON.stringify([c.provider, c.model]) === selection);
  async function send() {
    if (!available || controller.current || missing || preview.length > reviewInputLimit) return;
    const [provider, model] = JSON.parse(selection);
    const key = JSON.stringify([selection, message.trim(), selectedIds]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    try {
      const result: Review = await (
        await api(
          token,
          route,
          "POST",
          {
            id: attempt.current.id,
            target: { provider, model },
            message,
            approved: true,
            referenceIds: selectedIds,
          },
          c.signal,
        )
      ).json();
      setReview(result);
      setSelectedIds([]);
      onCreated(result.reviewer);
      attempt.current = null;
    } catch (e) {
      setError(
        c.signal.aborted
          ? "검토 요청을 중단했습니다."
          : e instanceof Error
            ? e.message
            : "검토에 실패했습니다.",
      );
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  const pending = busy || review?.status === "streaming";
  return (
    <details className="checkpoint-editor review-editor" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>다른 모델에 검토 요청</summary>
      {!enabled && <small>설정 → 토글형 모듈에서 AI 협업 허용을 켜세요.</small>}
      <fieldset disabled={!enabled || pending}>
        <label>
          검토 모델
          <select value={available ? selection : ""} onChange={(e) => setSelection(e.target.value)}>
            {!available && <option value="" disabled>검토 모델을 다시 선택하세요</option>}
            {choices.map((c) => (
              <option
                key={JSON.stringify([c.provider, c.model])}
                value={JSON.stringify([c.provider, c.model])}
              >
                {providerNames[c.provider]} {c.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          검토 모델에 보낼 내용
          <textarea
            rows={4}
            maxLength={reviewInputLimit}
            value={message}
            placeholder="검토 목적, 필요한 자료와 원하는 결과를 적으세요."
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!lastReply || message.length + lastReply.length + (message ? 2 : 0) > reviewInputLimit}
          onClick={() => setMessage((v) => (v ? `${v}\n\n${lastReply}` : lastReply))}
        >
          마지막 답변 추가
        </button>
        <details onToggle={e => setExcerptOpen(e.currentTarget.open)}>
          <summary>대화 답변에서 발췌</summary>
          {open && excerptOpen && <ReplyExcerpt turns={turns} draft={message} references={selected} insert={setMessage} />}
        </details>
        {references.length > 0 && (
          <fieldset>
            <legend>함께 보낼 첨부 자료</legend>
            {references.map((ref) => (
              <label key={ref.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(ref.id)}
                  disabled={ref.paused}
                  onChange={() =>
                    setSelectedIds((ids) =>
                      ids.includes(ref.id) ? ids.filter((id) => id !== ref.id) : [...ids, ref.id],
                    )
                  }
                />{" "}
                {ref.kind === "knowledge" ? "지식 발췌" : "파일"} · {ref.project} / {ref.path} · {ref.start}–
                {ref.end}줄{ref.paused && " · 참조 꺼짐"}
              </label>
            ))}
          </fieldset>
        )}
        {missing && (
          <p role="alert">
            선택한 자료 중 사용할 수 없는 항목이 있습니다.{" "}
            <button type="button" onClick={() => setSelectedIds(selected.map((ref) => ref.id))}>
              사용 불가 항목 빼기
            </button>
          </p>
        )}
        {selected.length > 0 && (
          <details>
            <summary>보낼 내용 미리보기 · {preview.length.toLocaleString()} / 8,000자</summary>
            <pre className="review-preview">{preview}</pre>
          </details>
        )}
        {preview.length > reviewInputLimit && (
          <small>자료를 빼거나 요청을 줄여 8,000자 이내로 맞춰 주세요.</small>
        )}
        <small>
          작성한 요청과 선택한 발췌만 독립 대화에 한 번 보냅니다. 최대 출력 {reviewOutputTokens}토큰
          {selection !== JSON.stringify(["mock", ""]) ? " · API 사용료가 발생할 수 있습니다." : ""}
        </small>
        <button
          type="button"
          disabled={!available || !message.trim() || missing || preview.length > reviewInputLimit}
          onClick={() => void send()}
        >
          승인하고 검토 요청
        </button>
      </fieldset>
      {busy && (
        <button type="button" onClick={() => controller.current?.abort()}>
          검토 중단
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() => {
              setError("");
              window.dispatchEvent(new CustomEvent("ags-file-references", { detail: session.id }));
              refresh({ route });
            }}
          >
            상태 다시 확인
          </button>
        </p>
      )}
      {history.length > 0 && (
        <details>
          <summary>검토 이력 {history.length}건</summary>
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <button type="button" disabled={busy} onClick={() => onCreated(item.reviewer, true)}>
                  {item.title.split("\n")[0]} · {providerNames[item.provider]} {item.model} ·{" "}
                  {states[item.status]} · 대화 열기
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {review && (
        <ReviewResult
          key={review.id + review.status}
          token={token}
          review={review}
          project={project}
          insert={insert}
        />
      )}
    </details>
  );
}
