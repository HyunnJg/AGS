import { minimumResponsesOutput } from "../../../packages/providers/src/openai-responses.ts";
import { folderFollowupCost } from "../../../packages/providers/src/folder-tools.ts";
import type { configureProviders } from "../../../packages/providers/src/compatible.ts";
import type { CallCapture } from "../../../packages/providers/src/capture.ts";
import type { ContextBudget, ContextPreview } from "../../../packages/contracts/src/context.ts";
import type { ModelSelection } from "../../../packages/contracts/src/providers.ts";
import type { WorkspaceRead } from "../../../packages/contracts/src/workspace.ts";
import { WorkspaceError, type RegisteredRoot } from "./workspace-files.ts";
import { workspaceListing } from "./workspace-tools.ts";

export function folderOutputFits(provider: ModelSelection["provider"], budget: number | null) {
  return budget === null || budget >= (provider === "openai" ? minimumResponsesOutput : 1);
}

export function folderCallBudget(context: ContextBudget, extraInput: number, extraMessages: number): ContextBudget {
  return {
    inputCeiling: context.inputCeiling,
    estimatedInput: context.estimatedInput + extraInput,
    blockUsage: [...context.blockUsage, {
      block: "tool", estimatedTokens: extraInput, includedMessages: extraMessages, omittedMessages: 0,
    }],
  };
}

export async function* providerFolderTurn(providers: ReturnType<typeof configureProviders>, selection: ModelSelection,
  context: ContextPreview, root: RegisteredRoot, signal: AbortSignal, activity: () => void,
  check: () => void, record: (row: WorkspaceRead) => void, capture: CallCapture | undefined,
  nextHttpCall: (extraInput: number, extraMessages: number) => CallCapture | undefined) {
  const { messages, outputBudget, inputCeiling, estimatedInput } = context;
  const decision = await providers.folderDecision(selection, messages, signal, activity, outputBudget, capture);
  if ("answer" in decision) {
    yield decision.answer;
    return;
  }
  check();
  const remainingOutput = outputBudget === null ? null : outputBudget - (decision.used ?? outputBudget);
  if (!folderOutputFits(selection.provider, remainingOutput)) throw new WorkspaceError(422, "workspace_tool_budget");
  // Count the complete tool messages, including framing and escaped names, before sending.
  const page = await workspaceListing(root, "", check, record);
  const extra = decision.followup(JSON.stringify(page));
  const { estimatedTokens, includedMessages } = folderFollowupCost(extra);
  if (inputCeiling !== null && estimatedInput + estimatedTokens > inputCeiling)
    throw new WorkspaceError(422, "workspace_tool_budget");
  check();
  const finalCapture = nextHttpCall(estimatedTokens, includedMessages);
  yield* providers.stream(selection, messages, signal, activity, remainingOutput, finalCapture, extra);
}
