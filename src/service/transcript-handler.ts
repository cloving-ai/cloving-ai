import { isFinal } from "../authority/operations.ts";
import type { Fields, Reply } from "../protocol.ts";
import {
  emptyTranscript,
  transcriptAppended,
  transcriptPage,
  type ParsedTranscript,
} from "../turn-transcript.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  wholeNumber,
  type ServiceContext,
  type TranscriptReads,
} from "./replies.ts";

const cachedTurns = 8;

interface TranscriptQuery {
  readonly before?: number;
  readonly runId: string;
  readonly operationId: string;
  readonly after: number;
}

function queryOf(parameters: Fields): TranscriptQuery | string {
  const { runId, operationId } = parameters;
  const after = parameters["after"] ?? 0;
  const before = parameters["before"];
  if (!isIdentifier(runId)) return "runId must be a run ID.";
  if (typeof operationId !== "string" || operationId === "")
    return "operationId must be the operation ID of an agent turn.";
  if (!wholeNumber(after, 0)) return "after must be a whole number.";
  if (before !== undefined && !wholeNumber(before, 1))
    return "before must be a positive whole number.";
  return {
    runId,
    operationId,
    after,
    ...(before === undefined ? {} : { before }),
  };
}

export function remembered(
  cache: Map<string, ParsedTranscript>,
  turn: { readonly operationId: string; readonly parsed: ParsedTranscript },
): void {
  cache.delete(turn.operationId);
  cache.set(turn.operationId, turn.parsed);
  for (const key of cache.keys())
    if (cache.size > cachedTurns) cache.delete(key);
}

async function parsedTurn(
  reads: TranscriptReads,
  turn: { readonly operationId: string; readonly open: boolean },
): Promise<ParsedTranscript | undefined> {
  const { operationId, open } = turn;
  const known = reads.cache.get(operationId) ?? emptyTranscript;
  const files = await reads.read(operationId, known.bytes);
  reads.cache.delete(operationId);
  if (files === undefined) return undefined;
  if (files.size < known.bytes) return parsedTurn(reads, turn);
  const parsed = transcriptAppended(known, {
    ...files,
    open,
    privateTexts: reads.privateTexts,
  });
  remembered(reads.cache, { operationId, parsed });
  return parsed;
}

export async function transcript(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const query = queryOf(parameters);
  if (typeof query === "string") return invalidRequest(query);
  const { runId, operationId } = query;
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
  const open = !isFinal(operation);
  const parsed = await parsedTurn(reads, { operationId, open });
  if (parsed === undefined && !open)
    return failed("transcript-not-kept", {
      runId,
      operationId,
      detail: "The transcript of this turn is not kept.",
    });
  return result("transcript", {
    runId,
    operationId,
    ...transcriptPage(parsed?.entries ?? [], query),
    open,
  });
}
