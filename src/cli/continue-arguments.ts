import { isRecordKey } from "../authority/commands.ts";
import type { ServiceRequest } from "../protocol.ts";

export interface ContinueInvocation {
  readonly kind: "continue";
  readonly runId: string;
  readonly from: string | null;
  readonly bundle: "retained" | "current";
  readonly commandId: string | null;
  readonly note: string | null;
  readonly json: boolean;
}

interface GivenOption {
  readonly name: string;
  readonly value: string | undefined;
}

const allowed = ["from", "bundle", "command-id", "note", "json"];
export const stepName =
  /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+(?:\/(?:0|[1-9][0-9]*))?$/;
const invalid = "invalid-option-value";

function valueOf(
  options: readonly GivenOption[],
  name: string,
): string | undefined {
  return options.find((option) => option.name === name)?.value;
}

function bundleOf(
  value: string | undefined,
): ContinueInvocation["bundle"] | undefined {
  if (value === undefined || value === "retained") return "retained";
  return value === "current" ? "current" : undefined;
}

function optionsOf(
  options: readonly GivenOption[],
): Omit<ContinueInvocation, "kind" | "runId"> | undefined {
  const from = valueOf(options, "from") ?? null;
  const bundle = bundleOf(valueOf(options, "bundle"));
  const commandId = valueOf(options, "command-id") ?? null;
  if (bundle === undefined) return undefined;
  if (from !== null && !stepName.test(from)) return undefined;
  if (commandId !== null && !isRecordKey(commandId)) return undefined;
  const json = options.some((option) => option.name === "json");
  const note = valueOf(options, "note") ?? null;
  return { from, bundle, commandId, note, json };
}

export function continueInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly GivenOption[];
}): ContinueInvocation | string {
  const { positionals, options } = request;
  if (options.some((option) => !allowed.includes(option.name)))
    return "unexpected-option";
  const [runId, ...rest] = positionals;
  if (runId === undefined) return "missing-argument";
  if (rest.length > 0) return "unexpected-argument";
  const given = optionsOf(options);
  if (!isRecordKey(runId) || given === undefined) return invalid;
  return { kind: "continue", runId, ...given };
}

export function continueServiceRequest(
  invocation: ContinueInvocation,
  commandId: string,
): ServiceRequest {
  return {
    operation: "continue-run",
    parameters: {
      runId: invocation.runId,
      commandId,
      bundle: invocation.bundle,
      ...(invocation.from === null ? {} : { from: invocation.from }),
      ...(invocation.note === null ? {} : { note: invocation.note }),
    },
  };
}
