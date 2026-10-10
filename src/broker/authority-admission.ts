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
  context: {
    readonly manifest: ExecutionManifest | undefined;
    readonly state: AuthorityState;
    readonly definitions: Definitions;
  },
) => Admission;

const admissible: Admission = { kind: "admissible", definitions: new Map() };

const terminal = ["completed", "failed", "cancelled"];

const unpinned: Rule = (_command, context) =>
  context.manifest === undefined
    ? admissible
    : { kind: "rejected", reason: "unexpected-manifest" };

const admission: Rule = (command, context) => {
  const { manifest } = context;
  if (manifest === undefined)
    return { kind: "rejected", reason: "missing-manifest" };
  const stored = readExecutionManifest(manifest);
  const pin = workflowPin(stored);
  if (command.workflow !== pin)
    return { kind: "rejected", reason: "workflow-pin-mismatch" };
  return { kind: "admissible", definitions: new Map([[pin, stored]]) };
};

const resumption: Rule = (command, context) => {
  const { manifest, state, definitions } = context;
  if (manifest === undefined)
    return { kind: "rejected", reason: "missing-manifest" };
  const resumed = pinnedResumption(state, {
    definitions,
    runId: command.runId,
    available: manifest,
  });
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
  request: {
    readonly definitions: Definitions;
    readonly command: unknown;
    readonly manifest: ExecutionManifest | undefined;
  },
): Admission {
  const { definitions, command, manifest } = request;
  const parsed = parseCommand(command);
  if (!parsed || state.commands[parsed.commandId]) return admissible;
  const rule = rules[parsed.kind] ?? unpinned;
  return rule(parsed, { manifest, state, definitions });
}

export function pinnedResumption(
  state: AuthorityState,
  request: {
    readonly definitions: Definitions;
    readonly runId: string;
    readonly available: ExecutionManifest;
  },
): AdmissionResult {
  const { definitions, runId, available } = request;
  const status = state.runs[runId]?.status ?? "";
  const pinned = definitions.get(state.runs[runId]?.workflow ?? "");
  if (!pinned)
    return { kind: "rejected", reason: "unknown-run", detail: runId };
  if (terminal.includes(status))
    return { kind: "rejected", reason: "terminal-run", detail: runId };
  return resumePinned(pinned, available);
}
