import { setTimeout as delay } from "node:timers/promises";
import type { EventPage } from "../broker/actor/authority.ts";
import type { Fields, Reply } from "../protocol.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  wholeNumber,
  type ServiceContext,
} from "./replies.ts";

export interface Connection {
  readonly send: (events: readonly Fields[]) => Promise<boolean>;
  readonly closed: () => boolean;
}

interface Cursor {
  readonly after: number;
  readonly limit: number;
  readonly runId?: string;
}

function cursor(parameters: Fields): Cursor | undefined {
  const { runId } = parameters;
  const after: unknown = parameters["after"] ?? 0;
  const limit: unknown = parameters["limit"] ?? 100;
  if (
    !wholeNumber(after, 0) ||
    !wholeNumber(limit, 1) ||
    limit > 1000 ||
    (runId !== undefined && typeof runId !== "string")
  )
    return undefined;
  return { after, limit, ...(runId === undefined ? {} : { runId }) };
}

function published(page: EventPage): readonly Fields[] {
  return page.events.map((event) => ({ schemaVersion: 1, ...event }));
}

function gap(after: number, page: EventPage): Reply {
  return failed("event-gap", {
    detail: `The service has no events after sequence ${String(after)}.`,
    after,
    earliestAvailable: page.earliest,
    latestSequence: page.latest,
  });
}

async function followed(
  context: ServiceContext,
  stream: { readonly start: Cursor; readonly connection: Connection },
): Promise<undefined> {
  const { connection } = stream;
  let { after } = stream.start;
  while (!connection.closed()) {
    const page = await context.authority.queries.eventsAfter({
      ...stream.start,
      after,
    });
    if (!(await connection.send(published(page)))) return undefined;
    after = page.events.at(-1)?.sequence ?? after;
    if (page.events.length === 0) await changed(context, page.latest);
  }
  return undefined;
}

function changed(context: ServiceContext, latest: number): Promise<void> {
  const milliseconds = context.followMilliseconds;
  return context.changed === undefined
    ? delay(milliseconds)
    : context.changed({ after: latest, milliseconds });
}

async function known(context: ServiceContext, runId: string): Promise<boolean> {
  if (!isIdentifier(runId)) return false;
  return (await context.authority.state()).runs[runId] !== undefined;
}

export async function events(
  context: ServiceContext,
  request: { readonly parameters: Fields; readonly connection: Connection },
): Promise<Reply | undefined> {
  const start = cursor(request.parameters);
  if (start === undefined)
    return invalidRequest("The events request is not valid.");
  if (start.runId !== undefined && !(await known(context, start.runId)))
    return failed("unknown-run", {
      runId: start.runId,
      detail: `No run has the ID ${start.runId}.`,
    });
  const page = await context.authority.queries.eventsAfter(start);
  if (start.after > page.latest) return gap(start.after, page);
  if (request.parameters["follow"] === true)
    return followed(context, { start, connection: request.connection });
  return result("event-page", {
    events: published(page),
    latestSequence: page.latest,
  });
}
