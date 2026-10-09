import { parseCommand } from "../authority/commands.ts";
import type { AuthorityState } from "../authority/reducer.ts";
import type { AuthorityCommand } from "../authority/transitions.ts";
import { readExecutionManifest, resumePinned } from "../execution-pin.ts";
import type {
  AdmissionResult,
  ExecutionManifest,
} from "../workflow-admission.ts";
import { workflowPin } from "./workflow-pin.ts";

export type Definitions = ReadonlyMap<string, ExecutionManifest>;

export type Admission =
  | { readonly kind: "admissible"; readonly definitions: Definitions }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly detail?: string;
    };

type Rule = (
  command: AuthorityCommand,
  manifest: ExecutionManifest | undefined,
  state: AuthorityState,
  definitions: Definitions,
) => Admission;

const admissible: Admission = { kind: "admissible", definitions: new Map() };

const terminal = ["completed", "failed", "cancelled"];

const unpinned: Rule = (_command, manifest) =>
  manifest === undefined
    ? admissible
    : { kind: "rejected", reason: "unexpected-manifest" };

const admission: Rule = (command, manifest) => {
  if (manifest === undefined)
    return { kind: "rejected", reason: "missing-manifest" };
  const stored = readExecutionManifest(manifest);
  const pin = workflowPin(stored);
  if (command.workflow !== pin)
    return { kind: "rejected", reason: "workflow-pin-mismatch" };
  return { kind: "admissible", definitions: new Map([[pin, stored]]) };
};

const resumption: Rule = (command, manifest, state, definitions) => {
  if (manifest === undefined)
    return { kind: "rejected", reason: "missing-manifest" };
  const resumed = pinnedResumption(state, definitions, command.runId, manifest);
  return resumed.kind === "rejected" && resumed.reason !== "unknown-run"
    ? resumed
    : admissible;
};

const rules: Readonly<Record<string, Rule>> = {
  "admit-run": admission,
  "decide-gate": resumption,
  "resume-run": resumption,
};

export function admitted(
  state: AuthorityState,
  definitions: Definitions,
  command: unknown,
  manifest: ExecutionManifest | undefined,
): Admission {
  const parsed = parseCommand(command);
  if (!parsed || state.commands[parsed.commandId]) return admissible;
  return (rules[parsed.kind] ?? unpinned)(parsed, manifest, state, definitions);
}

export function pinnedResumption(
  state: AuthorityState,
  definitions: Definitions,
  runId: string,
  available: ExecutionManifest,
): AdmissionResult {
  const status = state.runs[runId]?.status ?? "";
  const pinned = definitions.get(state.runs[runId]?.workflow ?? "");
  if (!pinned)
    return { kind: "rejected", reason: "unknown-run", detail: runId };
  if (terminal.includes(status))
    return { kind: "rejected", reason: "terminal-run", detail: runId };
  return resumePinned(pinned, available);
}
