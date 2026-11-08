import { parseCommand } from "../../authority/commands.ts";
import { execute } from "../../authority/reducer.ts";
import type { AuthorityCommand } from "../../authority/transitions.ts";
import { admitted } from "../authority-admission.ts";
import type { PlanSettings } from "./authority-settings.ts";
import { stageable, type DeliveryIntent } from "./delivery-intents.ts";
import { followUps, type Step } from "./effect-plan.ts";
import { operationDigest } from "../operation-digest.ts";
import {
  draft,
  merged,
  unchangedAt,
  type Accepted,
  type Row,
} from "./turn-draft.ts";
import { pricedCommand } from "./spend-turn.ts";
import { refusalOf } from "./turn-refusals.ts";
import { followUp, openAttempts, staged } from "./turn-staging.ts";
import type {
  CommandPlanning,
  TurnPlan,
  TurnRequest,
  TurnState,
} from "./turn-staging.ts";

export { planDelivery } from "./delivery-plan.ts";
export type { DeliveryIntent } from "./delivery-intents.ts";
export type { ChangeDraft, Row } from "./turn-draft.ts";
export type {
  CommandPlanning,
  DeliveryPlanning,
  DeliveryResult,
  Document,
  TurnPlan,
  TurnRequest,
  TurnState,
} from "./turn-staging.ts";

export function planCommand(given: CommandPlanning): TurnPlan {
  const command = pricedCommand(given.request.command, given.turn.spend);
  const planning = { ...given, request: { ...given.request, command } };
  const { turn, request } = planning;
  const refusal = freshRefusal(planning);
  if (refusal !== undefined) return answer(refusal);
  const admission = admitted(turn.state, {
    definitions: turn.definitions,
    command: request.command,
    manifest: request.manifest,
  });
  if (admission.kind === "rejected") return answer(admission);
  const missing = missingDocument(planning);
  if (missing !== undefined)
    return answer({
      kind: "rejected",
      reason: "missing-document",
      detail: missing,
    });
  const result = execute(turn.state, request);
  if (result.kind === "duplicate")
    return answer({ ...result, intents: turn.created });
  if (result.kind === "rejected") return answer(result);
  const later = laterSteps(result, planning);
  return {
    kind: "commit",
    receipt: {
      kind: "accepted",
      sequence: result.state.sequence,
      intents: result.intents,
      ...(result.disposition === undefined
        ? {}
        : { disposition: result.disposition.disposition }),
    },
    change: merged(
      draft(result, {
        before: turn.state,
        definitions: [...admission.definitions].map(([pin, manifest]) => ({
          pin,
          manifest: JSON.stringify(manifest),
        })),
        closed: [],
        documents: referencedDocuments(request),
      }),
      later.map(followUp),
    ),
    stage: staged(later.at(-1)?.result.state ?? result.state, {
      held: turn.held,
      results: [result, ...later.map((step) => step.result)],
      closed: [],
      open: openAttempts(turn, []),
      stop: { ...planning, rows: [] },
    }),
  };
}

function laterSteps(
  result: Accepted,
  planning: CommandPlanning,
): readonly Step[] {
  const noted = notedSteps(result, planning.request);
  return [
    ...noted,
    ...followUps(noted.at(-1)?.result.state ?? result.state, {
      recordedAt: planning.request.recordedAt,
      effects: planning.effects,
      blocked: planning.turn.blocked,
    }),
  ];
}

function notedSteps(result: Accepted, request: TurnRequest): readonly Step[] {
  const command = parseCommand(request.command);
  if (command?.kind !== "admit-run" || command.note === undefined) return [];
  const noteId = `note-${operationDigest(command.commandId).slice(0, 32)}`;
  const noted = execute(result.state, {
    command: {
      kind: "note-run",
      commandId: noteId,
      runId: command.runId,
      noteId,
      note: command.note,
      source: "continue",
    },
    recordedAt: request.recordedAt,
  });
  if (noted.kind !== "accepted")
    throw new Error(`note-not-recorded: ${noted.kind}`);
  return [{ result: noted, before: result.state }];
}

const documentFields = [
  "submission",
  "input",
  "prompt",
  "answer",
  "payload",
  "result",
] as const;

export function documentReferences(
  command: AuthorityCommand | null,
): readonly string[] {
  if (command === null) return [];
  return documentFields
    .map((name) => command[name])
    .filter((digest) => digest !== undefined);
}

function referencedDocuments(request: TurnRequest): readonly Row[] {
  const references = documentReferences(parseCommand(request.command));
  return (request.documents ?? [])
    .filter((document) => references.includes(document.digest))
    .map((document) => ({ digest: document.digest, body: document.body }));
}

function missingDocument(planning: CommandPlanning): string | undefined {
  const { turn, request } = planning;
  const command = parseCommand(request.command);
  if (command === null || turn.state.commands[command.commandId] !== undefined)
    return undefined;
  const given = new Set(
    (request.documents ?? []).map((document) => document.digest),
  );
  return documentReferences(command).find(
    (digest) => !given.has(digest) && !turn.documents.has(digest),
  );
}

function freshRefusal(planning: CommandPlanning): Row | undefined {
  const { turn, request, epoch } = planning;
  const command = parseCommand(request.command);
  if (command === null || turn.state.commands[command.commandId] !== undefined)
    return undefined;
  const reason = refusalOf({
    command,
    recordedAt: request.recordedAt,
    given: request.epoch,
    epoch,
  });
  return reason === undefined ? undefined : { kind: "rejected", reason };
}

export function planAdoption(sequence: number): TurnPlan {
  return {
    kind: "commit",
    receipt: { kind: "adopted", sequence },
    change: { ...unchangedAt(sequence, []), completes_adoption: true },
    stage: [],
  };
}

export function planRecovery(recovery: {
  readonly turn: TurnState;
  readonly intents: readonly DeliveryIntent[];
  readonly effects: PlanSettings;
  readonly recordedAt: string;
}): TurnPlan {
  const { turn, intents } = recovery;
  const grants = followUps(turn.state, { ...recovery, blocked: new Map() });
  const stage = [
    ...intents,
    ...stageable(
      grants.at(-1)?.result.state ?? turn.state,
      new Set(intents.map((intent) => intent.operationId)),
    ),
  ];
  const receipt = { kind: "recovered", staged: stage.length };
  if (stage.length === 0 && grants.length === 0) return answer(receipt);
  return {
    kind: "commit",
    receipt,
    change: merged(unchangedAt(turn.state.sequence, []), grants.map(followUp)),
    stage,
  };
}

function answer(receipt: Row): TurnPlan {
  return { kind: "answer", receipt };
}
