import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readyList, type ReadyList } from "../queue-state.ts";

export const ticketLimits = {
  textBytes: 48_000,
  detailCharacters: 300,
  readyMilliseconds: 30_000,
};

export type TicketRead =
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "failed"; readonly detail: string };

export interface TicketRequest {
  readonly ticketId: string;
  readonly signal: AbortSignal;
}

function failed(detail: string): TicketRead {
  return { kind: "failed", detail };
}

function printed(output: string): TicketRead {
  const text = output.trim();
  if (text === "") return failed("The ticket command printed no text.");
  if (Buffer.byteLength(text) > ticketLimits.textBytes)
    return failed(
      `The ticket text has more than ${String(ticketLimits.textBytes)} bytes.`,
    );
  return { kind: "read", text };
}

function ended(error: unknown, name: string): TicketRead {
  const code: unknown = Reflect.get(Object(error), "code");
  const cause = String(Reflect.get(Object(error), "stderr"))
    .trim()
    .slice(0, ticketLimits.detailCharacters);
  return typeof code === "number"
    ? failed(`The ${name} ended with the code ${String(code)}: ${cause}`)
    : failed(`The ${name} did not complete: ${String(code)}`);
}

const executed = promisify(execFile);

function commandOutput(
  command: readonly string[],
  run: {
    readonly name: string;
    readonly signal: AbortSignal;
    readonly environment: NodeJS.ProcessEnv;
  },
): Promise<TicketRead> {
  const [executable = "", ...fixed] = command;
  return executed(executable, fixed, {
    signal: run.signal,
    env: run.environment,
    maxBuffer: 4 * ticketLimits.textBytes,
    encoding: "utf8",
  }).then(
    (output) => ({ kind: "read", text: output.stdout.trim() }),
    (error: unknown) => ended(error, run.name),
  );
}

export function ticketText(
  command: readonly string[],
  request: TicketRequest,
): Promise<TicketRead> {
  const [executable = "", ...fixed] = command;
  return ticketCommandText(
    [executable, ...fixed, request.ticketId],
    request.signal,
  ).then((result) =>
    result.kind === "failed" ? result : printed(result.text),
  );
}

export function ticketCommandText(
  command: readonly string[],
  request:
    | AbortSignal
    | { readonly signal: AbortSignal; readonly skipTickets: readonly string[] },
): Promise<TicketRead> {
  return commandOutput(command, {
    name: "ticket command",
    signal: request instanceof AbortSignal ? request : request.signal,
    environment:
      request instanceof AbortSignal
        ? process.env
        : {
            ...process.env,
            CLOVING_SKIP_TICKETS: request.skipTickets.join(" "),
          },
  });
}

export function readyTickets(
  command: readonly string[],
  signal: AbortSignal,
): Promise<ReadyList> {
  return commandOutput(command, {
    name: "ready-ticket command",
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(ticketLimits.readyMilliseconds),
    ]),
    environment: process.env,
  }).then((result) =>
    result.kind === "failed" ? result : readyList(result.text),
  );
}

export async function readyRefresh(
  command: readonly string[] | undefined,
  run: {
    readonly signal: AbortSignal;
    readonly listed: (ready: ReadyList) => void;
  },
): Promise<void> {
  if (command === undefined) return;
  run.listed(await readyTickets(command, run.signal));
}
