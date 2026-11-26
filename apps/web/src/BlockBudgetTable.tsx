import { blockNames, type BlockUsage } from "../../../packages/contracts/src/context.ts";

export function BlockBudgetTable({ rows }: { rows: BlockUsage[] }) {
  return (
    <details className="block-budget">
      <summary>블록별 입력 예산</summary>
      <table aria-label="블록별 입력 예산">
        <thead>
          <tr>
            <th scope="col">블록</th>
            <th scope="col">추정 토큰</th>
            <th scope="col">포함 메시지</th>
            <th scope="col">예산으로 제외</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.block}>
              <th scope="row">{row.block === "system" ? "고정 지침" : blockNames[row.block]}</th>
              <td>{row.estimatedTokens.toLocaleString()}</td>
              <td>{row.includedMessages}</td>
              <td>{row.omittedMessages}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
