import { mockReply } from "../packages/providers/src/mock.ts";

const args = process.argv.slice(2);
const prompt = args.length ? args.join(" ") : "AGS 연결 확인";

try {
  for (const chunk of mockReply(prompt)) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : "mock 실행에 실패했습니다.");
  process.exitCode = 1;
}
