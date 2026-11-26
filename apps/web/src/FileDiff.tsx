import { useMemo } from "react";
import type { WritePreview } from "../../../packages/contracts/src/workspace.ts";
import { lineDiff } from "./line-diff.ts";

function lines(label: string, first: number, start: number, end: number) {
  if (start === end) return "";
  return `${label} ${first + start}${end > start + 1 ? `–${first + end - 1}` : ""}줄`;
}

export function FileDiff({ preview }: { preview: WritePreview }) {
  const { first, removed, added } = preview;
  const { changes, grouped } = useMemo(() => lineDiff(removed, added), [removed, added]);
  return (
    <div className="file-diff">
      {preview.action === "create" && <small>새 파일</small>}
      {grouped && <p>변경이 많아 이 범위의 원본과 수정안을 한 구간으로 표시합니다.</p>}
      {changes.map(({ oldStart, oldEnd, newStart, newEnd }, index) => {
        const gap = index ? oldStart - (changes[index - 1]?.oldEnd ?? 0) : 0;
        const label = [lines("원본", first, oldStart, oldEnd), lines("수정안", first, newStart, newEnd)]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={`${oldStart}-${newStart}`}>
            {gap > 0 && <small className="diff-gap">중간 {gap}줄 동일</small>}
            <section aria-label={label}>
              <strong>{label}</strong>
              {oldEnd > oldStart && (
                <pre className="removed">
                  {removed
                    .slice(oldStart, oldEnd)
                    .map((l) => (grouped ? l : `− ${l}`))
                    .join("\n")}
                </pre>
              )}
              {newEnd > newStart && (
                <pre className="added">
                  {added
                    .slice(newStart, newEnd)
                    .map((l) => (grouped ? l : `+ ${l}`))
                    .join("\n")}
                </pre>
              )}
            </section>
          </div>
        );
      })}
    </div>
  );
}
