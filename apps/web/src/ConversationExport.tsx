import { useEffect, useRef, useState } from "react";
import { providerNames } from "../../../packages/contracts/src/providers.ts";
import { turnStatusLabels, type Session, type Turn } from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";
import { downloadBlob } from "./download.ts";

function transcript(session: Session, turns: Turn[], firstNumber: number) {
  const sections = [`# ${session.title.replace(/[\r\n\p{Zl}\p{Zp}]+/gu, " ")}`];
  if (session.sectionLabel) sections.push(session.sectionLabel);
  for (const [index, turn] of turns.entries()) {
    const model = [providerNames[turn.provider], turn.model].filter(Boolean).join(" · ");
    sections.push(`## ${index + firstNumber}. 사용자`, turn.message,
      `### 답변 · ${model} · ${turnStatusLabels[turn.status]}`, turn.reply);
  }
  return `${sections.join("\n\n")}\n`;
}

function exportFilename(title: string, suffix: string) {
  const name = title.replace(/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_").trim() || "대화";
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(255 - encoder.encode(`AGS-${suffix}.md`).length);
  const { read } = encoder.encodeInto(name, buffer);
  return `AGS-${name.slice(0, read)}${suffix}.md`;
}

function turnChoices(turns: Turn[]) {
  return turns.map((turn, index) => ({
    id: turn.id,
    label: `${index + 1}턴 · ${Array.from(turn.message.trim().replace(/\s+/gu, " ")).slice(0, 48).join("")}`,
  }));
}

export function ConversationExport({ token, session }: { token: string; session: Session }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [choices, setChoices] = useState<ReturnType<typeof turnChoices> | null>(null);
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  function showChoices(turns: Turn[], index: number) {
    setChoices(turnChoices(turns));
    setFirst(index);
    setLast(index);
  }
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function read(action: "choose" | "download") {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setNotice("");
    try {
      const response = await api(token, `/api/sessions/${session.id}`, "GET", undefined, request.signal);
      const data: { session: Session; turns: Turn[] } = await response.json();
      if (request.signal.aborted) return;
      if (!data.turns.length) setNotice("아직 저장된 메시지가 없습니다.");
      if (action === "choose" || !data.turns.length) {
        if (action === "choose" || choices !== null) showChoices(data.turns, data.turns.length - 1);
        return;
      }
      let turns = data.turns;
      let start = 0;
      let suffix = "";
      if (choices !== null) {
        const selected = choices.slice(first, last + 1);
        start = turns.findIndex(turn => turn.id === selected[0]?.id);
        if (start < 0 || !selected.every((choice, i) => turns[start + i]?.id === choice.id)) {
          showChoices(data.turns, -1);
          setNotice("대화 기록이 바뀌었습니다. 내보낼 구간을 다시 선택하세요.");
          return;
        }
        turns = turns.slice(start, start + selected.length);
        suffix = `-${start + 1}-${start + turns.length}턴`;
      }
      const file = new Blob([transcript(data.session, turns, start + 1)], { type: "text/markdown;charset=utf-8" });
      downloadBlob(file, exportFilename(data.session.title, suffix));
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
      <label className="match-case">
        <input type="checkbox" checked={choices !== null} disabled={busy} onChange={event => {
          setNotice("");
          if (event.target.checked) {
            setChoices([]);
            void read("choose");
          } else setChoices(null);
        }} />턴 범위 선택
      </label>
      {choices && choices.length > 0 && (
        <fieldset className="export-range" disabled={busy}>
          <legend>내보낼 구간 · {first < 0 ? 0 : last - first + 1}턴</legend>
          <label>시작 턴
            <select value={first} onChange={event => {
              const index = Number(event.target.value);
              setFirst(index);
              setLast(previous => Math.max(previous, index));
            }}>
              {first < 0 && <option value={-1} disabled>시작 턴 선택</option>}
              {choices.map((turn, i) => <option key={turn.id} value={i}>{turn.label}</option>)}
            </select>
          </label>
          <label>끝 턴
            <select disabled={first < 0} value={last} onChange={event => setLast(Number(event.target.value))}>
              {first < 0 ? <option value={-1}>시작 턴을 먼저 선택하세요</option> : choices.slice(first).map((turn, i) => <option key={turn.id} value={first + i}>{turn.label}</option>)}
            </select>
          </label>
        </fieldset>
      )}
      <button type="button" disabled={busy || (choices !== null && (!choices.length || first < 0))} onClick={() => void read("download")}>
        {choices === null ? "대화 Markdown 다운로드" : "선택 구간 Markdown 다운로드"}
      </button>
      {notice && <output>{notice}</output>}
    </section>
  );
}
