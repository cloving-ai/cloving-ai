import type { Fields, Reply } from "../protocol.ts";
import { transcriptEntries, transcriptPage } from "../turn-transcript.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  wholeNumber,
  type ServiceContext,
} from "./replies.ts";

const finished = ["completed", "failed", "stopped", "cancelled"];

interface TranscriptQuery {
  readonly runId: string;
  readonly operationId: string;
  readonly after: number;
}

function queryOf(parameters: Fields): TranscriptQuery | string {
  const { runId, operationId } = parameters;
  const after = parameters["after"] ?? 0;
  if (!isIdentifier(runId)) return "runId must be a run ID.";
  if (typeof operationId !== "string" || operationId === "")
    return "operationId must be the operation ID of an agent turn.";
  if (!wholeNumber(after, 0)) return "after must be a whole number.";
  return { runId, operationId, after };
}

export async function transcript(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const query = queryOf(parameters);
  if (typeof query === "string") return invalidRequest(query);
  const { runId, operationId, after } = query;
  const reads = context.turnTranscript;
  if (reads === undefined)
    return failed("transcript-unavailable", {
      detail: "This service reads no turn journal.",
    });
  const operation = (await context.authority.effects.operations(runId)).find(
    (item) => item.operationId === operationId && item.capability === "claude",
  );
  if (operation === undefined)
    return failed("unknown-turn", {
      runId,
      operationId,
      detail: "The run has no agent turn with this operation ID.",
    });
  const open = !finished.includes(operation.status);
  const files = await reads.read(operationId);
  if (files === undefined && !open)
    return failed("transcript-not-kept", {
      runId,
      operationId,
      detail: "The transcript of this turn is not kept.",
    });
  const entries =
    files === undefined
      ? []
      : transcriptEntries({ ...files, open, privateTexts: reads.privateTexts });
  return result("transcript", {
    runId,
    operationId,
    ...transcriptPage(entries, { after }),
    open,
  });
}
