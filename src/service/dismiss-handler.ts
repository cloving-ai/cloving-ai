import { isCommandId } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  type ServiceContext,
} from "./replies.ts";

export async function dismissRun(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { runId, commandId } = parameters;
  if (!isIdentifier(runId) || !isCommandId(commandId))
    return invalidRequest("The dismiss request is not valid.");
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: { kind: "dismiss-run", commandId, runId },
  });
  if (!committed(receipt)) return rejection(receipt, { commandId, runId });
  const stored = await context.authority.queries.receipt(commandId);
  if (stored === undefined)
    return failed("authority-unavailable", { commandId, runId });
  return result("run-dismissed", {
    runId,
    commandId,
    replayed: receipt.kind === "duplicate",
    receipt: publicReceipt(stored),
  });
}
