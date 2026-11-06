import type { Reply, ServiceError } from "../protocol.ts";
import { commandJson, errorObject } from "./command-requests.ts";
import { errorText, rendered } from "./render.ts";

export interface Terminal {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface OutputEnvironment {
  readonly terminal: Terminal;
  readonly identifier: () => string;
}

export interface Format {
  readonly json: boolean;
  readonly commandId?: string;
  readonly announced?: boolean;
}

export function failed(
  environment: OutputEnvironment,
  failure: { readonly error: ServiceError; readonly format: Format },
): number {
  const { terminal } = environment;
  const shown = errorObject(failure.error, failure.format);
  if (failure.format.json) {
    terminal.out(`${JSON.stringify(shown)}\n`);
    return 1;
  }
  terminal.error(errorText(failure.error));
  if (typeof shown["commandId"] === "string" && !failure.format.announced)
    terminal.error(`Command ID: ${shown["commandId"]}\n`);
  return 1;
}

export function presented(
  environment: OutputEnvironment,
  outcome: { readonly reply: Reply; readonly format: Format },
): number {
  const { reply, format } = outcome;
  if (reply.kind === "error")
    return failed(environment, { error: reply.error, format });
  environment.terminal.out(
    format.json
      ? `${JSON.stringify(commandJson(reply))}\n`
      : rendered(reply.result),
  );
  return 0;
}

export function identified(
  environment: OutputEnvironment,
  invocation: { readonly commandId: string | null; readonly json: boolean },
): Format & { readonly commandId: string } {
  const { json } = invocation;
  if (invocation.commandId !== null)
    return { json, commandId: invocation.commandId, announced: false };
  const commandId = environment.identifier();
  if (!json) environment.terminal.error(`Command ID: ${commandId}\n`);
  return { json, commandId, announced: !json };
}
