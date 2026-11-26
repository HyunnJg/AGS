import { useEffect, useRef, useState } from "react";
import { providerNames, type ModelSelection } from "../../../packages/contracts/src/providers.ts";
import {
  reviewInputLimit,
  reviewOutputTokens,
  type Review,
} from "../../../packages/contracts/src/reviews.ts";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import type { Project, WorkspaceCatalog } from "../../../packages/contracts/src/workspace.ts";
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

export function ReviewEditor({
  token,
  session,
  choices,
  lastReply,
  insert,
  onCreated,
}: {
  token: string;
  session: Session;
  choices: ModelSelection[];
  lastReply: string;
  insert: (value: string) => void;
  onCreated: (id: string) => void;
}) {
  const route = `/api/sessions/${session.id}/review`;
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [project, setProject] = useState<Project>();
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState(JSON.stringify(["mock", ""]));
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [latest, refresh] = useState({route});
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const r = await (await api(token, latest.route, "GET", undefined, c.signal)).json();
        if (!c.signal.aborted) {
          setReview(r);
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
  async function send() {
    if (controller.current) return;
    const [provider, model] = JSON.parse(selection);
    const key = JSON.stringify([selection, message.trim()]);
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
          },
          c.signal,
        )
      ).json();
      setReview(result);
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
  const available = choices.some((c) => JSON.stringify([c.provider, c.model]) === selection);
  return (
    <details className="checkpoint-editor" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>다른 모델에 검토 요청</summary>
      {!enabled && <small>설정 → 토글형 모듈에서 AI 협업 허용을 켜세요.</small>}
      <fieldset disabled={!enabled || pending}>
        <label>
          검토 모델
          <select value={selection} onChange={(e) => setSelection(e.target.value)}>
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
        <small>
          위 내용만 독립 대화에 한 번 보냅니다. 최대 출력 {reviewOutputTokens}토큰
          {selection !== JSON.stringify(["mock", ""]) ? " · API 사용료가 발생할 수 있습니다." : ""}
        </small>
        <button type="button" disabled={!available || !message.trim()} onClick={() => void send()}>
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
              refresh({route});
            }}
          >
            상태 다시 확인
          </button>
        </p>
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
