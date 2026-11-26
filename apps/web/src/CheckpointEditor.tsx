import { useState } from "react";
import type { Session } from "../../../packages/contracts/src/sessions.ts";
import { maxSummary, type CheckpointDraft } from "../../../packages/contracts/src/checkpoints.ts";
import { providerNames } from "../../../packages/contracts/src/providers.ts";
import { api } from "./api.ts";

export function CheckpointEditor({ session, token }: { session: Session; token: string }) {
  const [draft, setDraft] = useState<CheckpointDraft>();
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function run() {
    setBusy(true);
    setNotice("");
    try {
      const body = draft
        ? {
            binding: draft.binding,
            first: draft.first,
            last: draft.last,
            summary: draft.summary,
            action: "save",
            approved: true,
          }
        : { action: "draft", provider: session.provider, model: session.model };
      const result = await (await api(token, `/api/sessions/${session.id}/checkpoint`, "POST", body)).json();
      if (draft) {
        setNotice(`구간 요약을 저장했습니다 · ${result.path}`);
        setDraft(undefined);
      } else setDraft(result);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "구간 요약 요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="checkpoint-editor">
      <summary>구간 요약</summary>
      <fieldset disabled={busy}>
        {draft ? (
          <>
            <label>
              구간 요약 초안
              <textarea
                aria-label="구간 요약 초안"
                rows={5}
                maxLength={maxSummary}
                value={draft.summary}
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              />
            </label>
            <details>
              <summary>요약에 사용한 대화</summary>
              {draft.sources.map((t, i) => (
                <div key={t.id}>
                  <strong>출처 [{i + 1}]</strong>
                  <p>{t.question}</p>
                  <p>{t.reply}</p>
                </div>
              ))}
            </details>
            <small>
              완료 턴 {draft.count}개 · {draft.path}
            </small>
          </>
        ) : (
          <small>
            기록하지 않은 완료 턴을 앞에서 최대 8개 읽습니다.{" "}
            {session.provider === "mock"
              ? "로컬 mock은 요청에 적힌 결정과 할 일을 발췌합니다."
              : `${session.model}에 질문·답변을 각각 앞 3,000자까지 보내 요약합니다. API 사용료가 발생할 수 있습니다.`}
          </small>
        )}
        <button type="button" disabled={!!draft && !draft.summary.trim()} onClick={() => void run()}>
          {draft ? "승인하고 요약 저장" : `${providerNames[session.provider]}으로 요약 초안 만들기`}
        </button>
        {draft && (
          <button
            type="button"
            onClick={() => {
              setDraft(undefined);
              setNotice("");
            }}
          >
            초안 취소
          </button>
        )}
      </fieldset>
      {busy && <output>처리 중…</output>}
      {notice && <output>{notice}</output>}
    </details>
  );
}
