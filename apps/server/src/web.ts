import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

// Both uncompiled and compiled servers serve the same trusted build directory.
const webRoot = new URL(
  import.meta.url.endsWith(".ts") ? "../../../dist/web/" : "../../../web/",
  import.meta.url,
);

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"] as const],
  ["/app.js", ["app.js", "application/javascript"] as const],
  ["/display-worker.js", ["display-worker.js", "application/javascript"] as const],
  ["/app.css", ["app.css", "text/css; charset=utf-8"] as const],
]);

export async function serveWeb(path: string, res: ServerResponse) {
  const asset = assets.get(path);
  if (!asset) return false;
  try {
    const data = await readFile(fileURLToPath(new URL(asset[0], webRoot)));
    res
      .writeHead(200, {
        "content-type": asset[1],
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
        "referrer-policy": "no-referrer",
      })
      .end(data);
  } catch {
    res
      .writeHead(503, { "content-type": "text/plain; charset=utf-8" })
      .end("pnpm build 명령으로 작업 화면을 빌드해 주세요.");
  }
  return true;
}
