import { maxText, type DisplayRule } from "../../../packages/contracts/src/display.ts";

// Executed only in the worker. Limit intermediate output as well as the final string.
export function transformReply(original: string, rules: DisplayRule[]) {
  if (original.length > maxText) throw new Error("텍스트 길이 제한을 넘었습니다.");
  let text = original;
  let matches = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const regex = new RegExp(rule.pattern, rule.flags);
    const parts: string[] = [];
    let size = 0,
      end = 0;
    function append(part: string) {
      size += part.length;
      if (size > maxText) throw new Error("치환 결과가 길이 제한을 넘었습니다.");
      if (part) parts.push(part);
    }
    const tokens = rule.replacement.split(/(\$\$|\$&|\$[1-9][0-9]?)/);
    for (let m = regex.exec(text); m; m = regex.exec(text)) {
      if (++matches > 4096) throw new Error("치환 횟수 제한을 넘었습니다.");
      append(text.slice(end, m.index));
      for (const token of tokens) {
        if (token === "$$") append("$");
        else if (token === "$&") append(m[0]);
        else if (/^\$[1-9]/.test(token) && Number(token.slice(1)) < m.length)
          append(m[Number(token.slice(1))] ?? "");
        else append(token);
      }
      end = m.index + m[0].length;
      if (!regex.global) break;
      if (!m[0]) regex.lastIndex += regex.unicode && (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    }
    append(text.slice(end));
    text = parts.join("");
  }
  return text;
}
