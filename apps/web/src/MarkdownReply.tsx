import { Fragment, type ReactNode } from "react";
import type { MarkedToken, Token, Tokens } from "marked";
import { CopyText } from "./CopyText.tsx";
import { parseReplyMarkdown, replyLink } from "./replyMarkdown.ts";

const headings = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

// The local lexer has no extensions. Only these React elements can be produced by model text.
function nodes(tokens: Token[]): ReactNode {
  let offset = 0;
  return tokens.map(token => {
    offset += token.raw.length;
    return <Fragment key={offset}>{render(token as MarkedToken)}</Fragment>;
  });
}

function cells(row: Tokens.TableCell[], header: boolean) {
  const Cell = header ? "th" : "td";
  return row.map((cell, column) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: Columns in this static token have no IDs.
    <Cell key={column} scope={header ? "col" : undefined} style={{textAlign: cell.align ?? undefined}}>
      {nodes(cell.tokens)}
    </Cell>
  ));
}

function render(token: MarkedToken): ReactNode {
  switch (token.type) {
    case "space": case "def": return null;
    case "html": case "image": return token.raw;
    case "escape": return token.text;
    case "text": return token.tokens ? nodes(token.tokens) : token.text;
    case "paragraph": return <p>{nodes(token.tokens)}</p>;
    case "heading": {
      const Heading = headings[token.depth - 1] ?? "h6";
      return <Heading>{nodes(token.tokens)}</Heading>;
    }
    case "blockquote": return <blockquote>{nodes(token.tokens)}</blockquote>;
    case "strong": return <strong>{nodes(token.tokens)}</strong>;
    case "em": return <em>{nodes(token.tokens)}</em>;
    case "del": return <del>{nodes(token.tokens)}</del>;
    case "br": return <br />;
    case "hr": return <hr />;
    case "codespan": return <code>{token.text}</code>;
    case "checkbox": return token.checked ? "☑ " : "☐ ";
    case "list_item": return <li>{nodes(token.tokens)}</li>;
    case "list": return token.ordered
      ? <ol start={Number(token.start)}>{nodes(token.items)}</ol>
      : <ul>{nodes(token.items)}</ul>;
    case "link": {
      const href = replyLink(token.href);
      return href ? <a href={href} target="_blank" rel="noreferrer">{nodes(token.tokens)}</a> : token.raw;
    }
    case "code": return (
      <div className="reply-code">
        <div>{token.lang && <span>{token.lang}</span>} <CopyText text={token.text} label="코드 복사" /></div>
        <pre><code>{token.text}</code></pre>
      </div>
    );
    case "table": return (
      <div className="reply-table"><table>
        <thead><tr>{cells(token.header, true)}</tr></thead>
        <tbody>{token.rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Rows of a finished reply are static.
          <tr key={index}>{cells(row, false)}</tr>
        ))}</tbody>
      </table></div>
    );
  }
}

export function renderReplyMarkdown(text: string) {
  try {
    const tokens = parseReplyMarkdown(text);
    return tokens ? nodes(tokens) : null;
  } catch {
    // A deeply nested or malformed response must still be readable and copyable.
    return null;
  }
}
