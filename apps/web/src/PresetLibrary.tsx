import { useState } from "react";
import { isPresetDraft, maxPresetName, maxPresetText } from "../../../packages/contracts/src/sessions.ts";
import { api } from "./api.ts";

export function PresetLibrary({ token }: { token: string }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function read(file: File) {
    setBusy(true);
    try {
      if (file.size > 4 * maxPresetText) throw new Error("8,000자 이내의 파일을 선택하세요.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim() || text.length > maxPresetText || text.includes("\0"))
        throw new Error("내용이 있는 8,000자 이내의 UTF-8 문서를 선택하세요.");
      setName(file.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, maxPresetName));
      setInstructions(text);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof TypeError
          ? "UTF-8 텍스트 파일을 선택하세요."
          : error instanceof Error
            ? error.message
            : "파일을 읽지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await api(token, "/api/settings/presets", "POST", { name, instructions });
      setMessage(`‘${name.trim()}’ 등록 완료 · 대화 상단의 프리셋에서 선택하세요.`);
      setName("");
      setInstructions("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "프리셋을 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy} className="source-fields">
        <label>
          Markdown 파일 가져오기
          <input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void read(file);
            }}
          />
        </label>
        <label>
          프리셋 이름
          <input value={name} maxLength={maxPresetName} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          분야 지침
          <textarea
            value={instructions}
            maxLength={maxPresetText}
            rows={8}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <small>
          파일을 가져오거나 지침을 직접 입력하세요. 등록한 내용은 이 프리셋을 선택한 대화의 시스템 지침에
          들어갑니다.
        </small>
        <button type="submit" disabled={!isPresetDraft({name, instructions})}>
          프리셋 등록
        </button>
      </fieldset>
      {message && <output>{message}</output>}
    </form>
  );
}
