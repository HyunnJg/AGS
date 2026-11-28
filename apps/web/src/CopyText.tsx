import { useEffect, useState } from "react";

export function CopyText({ text, label }: { text: string; label: "코드 복사" | "답변 복사" }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(timeout);
  }, [message]);
  async function copy() {
    setMessage("");
    setPending(true);
    try {
      await navigator.clipboard.writeText(text);
      setMessage("복사했습니다.");
    } catch {
      setMessage("클립보드에 복사할 수 없습니다. 텍스트를 선택해 직접 복사하세요.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button className="raw-reply" type="button" title={label === "코드 복사" ? "코드 내용만 복사" : "현재 답변의 Markdown 텍스트 복사"} disabled={pending} onClick={() => void copy()}>
        {label}
      </button>
      <output>{message}</output>
    </>
  );
}
