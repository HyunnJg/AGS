import { useEffect, useRef, useState } from "react";
import { providerNames } from "../../../packages/contracts/src/providers.ts";
import { turnStatusLabels, type Session, type Turn } from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";
import { downloadBlob } from "./download.ts";

function transcript(session: Session, turns: Turn[]) {
  const sections = [`# ${session.title.replace(/[\r\n\p{Zl}\p{Zp}]+/gu, " ")}`];
  if (session.sectionLabel) sections.push(session.sectionLabel);
  for (const [index, turn] of turns.entries()) {
    const model = [providerNames[turn.provider], turn.model].filter(Boolean).join(" · ");
    sections.push(`## ${index + 1}. 사용자`, turn.message,
      `### 답변 · ${model} · ${turnStatusLabels[turn.status]}`, turn.reply);
  }
  return `${sections.join("\n\n")}\n`;
}

export function ConversationExport({ token, session }: { token: string; session: Session }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function save() {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setNotice("");
    try {
      const response = await api(token, `/api/sessions/${session.id}`, "GET", undefined, request.signal);
      const data: { session: Session; turns: Turn[] } = await response.json();
      if (request.signal.aborted) return;
      if (!data.turns.length) {
        setNotice("아직 저장된 메시지가 없습니다.");
        return;
      }
      const name = data.session.title.replace(/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_").trim();
      downloadBlob(new Blob([transcript(data.session, data.turns)], {type: "text/markdown;charset=utf-8"}),
        `AGS-${name || "대화"}.md`);
    } catch (e) {
      if (!request.signal.aborted) setNotice(e instanceof Error ? e.message : "대화를 내려받지 못했습니다.");
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  return (
    <section className="conversation-export" aria-label="현재 대화 내보내기">
      <h4>현재 대화 내보내기</h4>
      <p>{session.title} · 저장된 질문과 답변 원문을 Markdown 파일로 내려받습니다.</p>
      <button type="button" disabled={busy} onClick={() => void save()}>대화 Markdown 다운로드</button>
      {notice && <output>{notice}</output>}
    </section>
  );
}
