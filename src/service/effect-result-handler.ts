import type { Fields, Reply } from "../protocol.ts";
import { isReportResultDigest } from "../report-effects.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  type ServiceContext,
} from "./replies.ts";

const reportPage = 100;
const resultBytes = 65_536;

interface ResultRequest {
  readonly runId: string;
  readonly digest: string;
}

function resultRequest(parameters: Fields): ResultRequest | undefined {
  const { runId, digest } = parameters;
  if (!isIdentifier(runId) || !isReportResultDigest(digest)) return undefined;
  return { runId, digest };
}

async function reported(
  context: Pick<ServiceContext, "authority">,
  request: ResultRequest,
): Promise<boolean> {
  let after = 0;
  for (;;) {
    const { events } = await context.authority.queries.eventsAfter({
      after,
      limit: reportPage,
      runId: request.runId,
      type: "effect.reported",
    });
    if (events.some((event) => event.payload["result"] === request.digest))
      return true;
    const last = events.at(-1);
    if (last === undefined || events.length < reportPage) return false;
    after = last.sequence;
  }
}

export async function effectResult(
  context: Pick<ServiceContext, "authority">,
  parameters: Fields,
): Promise<Reply> {
  const request = resultRequest(parameters);
  if (request === undefined)
    return invalidRequest(
      "An effect-result request has a run ID and a sha256 digest.",
    );
  const body = (await reported(context, request))
    ? await context.authority.queries.document(request.digest)
    : undefined;
  if (body === undefined)
    return failed("unknown-effect-result", {
      ...request,
      detail: `No effect report of run ${request.runId} names a stored result ${request.digest}.`,
    });
  const bytes = Buffer.byteLength(body);
  if (bytes > resultBytes)
    return failed("effect-result-too-large", {
      ...request,
      detail: `The stored result has ${String(bytes)} bytes. The limit is ${String(resultBytes)} bytes.`,
    });
  return result("effect-result", { ...request, result: body });
}
