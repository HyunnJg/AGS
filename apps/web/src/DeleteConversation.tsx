import { useState } from "react";
import { api } from "./api.ts";

type Preview = { title: string; turns: number; savedSummaries: number; confirmation: string };

export function DeleteConversation({ token, id, disabled, onDeleted, onRestored }: {
  token: string; id: string; disabled: boolean; onDeleted: (id: string) => void; onRestored: () => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    const path = `/api/sessions/${id}`;
    try {
      if (preview) {
        await api(token, path, "DELETE", { confirmation: preview.confirmation });
        onDeleted(id);
      } else {
        setPreview(await (await api(token, `${path}/delete-preview`, "POST")).json());
      }
    } catch (e) {
      setPreview(undefined);
      setError(e instanceof Error ? e.message : "대화를 삭제하지 못했습니다.");
      try {
        const { session } = await (await api(token, path)).json();
        if (!session.archived) onRestored();
      } catch { /* Keep the original error if the server is unavailable. */ }
    } finally {
      setBusy(false);
    }
  }
  return <>
    {preview && <p>‘{preview.title}’의 {preview.turns}개 턴과 초안, 첨부 참조, 호출 로그를 영구 삭제합니다.{" "}
      {preview.savedSummaries > 0 && `저장한 구간 요약 ${preview.savedSummaries}건은 섹션 기억에서 빠집니다. `}
      작업 폴더의 파일과 별도 검토 대화는 유지됩니다.</p>}
    <button type="button" disabled={disabled || busy} onClick={() => void submit()}>
      {preview ? "영구 삭제 확인" : "대화 영구 삭제"}
    </button>
    {preview && <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>삭제 취소</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}
