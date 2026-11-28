import { Lexer } from "marked";

export function parseReplyMarkdown(text: string) {
  if (!text || text.length > 65536) return null;
  // GFM pads short table rows to the header width. Bound the possible cell count before lexing.
  if (text.includes("|")) {
    const lines = text.split(/\r\n?|\n/);
    const width = Math.max(...lines.map(line => line.split("|").length));
    if (width * lines.length > 32768) return null;
  }
  const tokens = Lexer.lex(text, { gfm: true });
  const first = tokens[0];
  if (tokens.length === 1 && first?.type === "paragraph" &&
      first.tokens?.every(token => token.type === "text")) return null;
  return tokens;
}

// Resolve no relative paths against the private workspace server.
export function replyLink(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
