export type RunStatus =
  | "queued"
  | "running"
  | "waiting_gate"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunState {
  readonly runId: string;
  readonly status: RunStatus;
  readonly revision: number;
  readonly workflow: string;
  readonly pausedFrom: RunStatus | null;
  readonly gates: readonly string[];
}

export interface EffectIntent {
  readonly kind: "start-run";
  readonly runId: string;
  readonly operationId: string;
}

export interface AuthorityState {
  readonly sequence: number;
  readonly runs: Readonly<Record<string, RunState>>;
  readonly commands: Readonly<
    Record<string, { readonly request: string; readonly sequence: number }>
  >;
  readonly intents: readonly EffectIntent[];
}

export type EventType =
  | "run.created"
  | "run.started"
  | "gate.opened"
  | "gate.decided"
  | "run.paused"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface AuthorityEvent {
  readonly sequence: number;
  readonly type: EventType;
  readonly runId: string;
  readonly commandId: string;
  readonly recordedAt: string;
  readonly request: string;
  readonly payload: Readonly<Record<string, string>>;
}

export type AuthorityCommand = {
  readonly kind: string;
  readonly commandId: string;
  readonly runId: string;
  readonly expectedRevision?: number;
  readonly workflow?: string;
  readonly gateId?: string;
  readonly decision?: string;
};

type Move = Exclude<EventType, "run.created">;
type Change = Pick<RunState, "status"> & Partial<RunState>;

const terminal: readonly RunStatus[] = ["completed", "failed", "cancelled"];
const active: readonly RunStatus[] = ["queued", "running", "waiting_gate"];

const sources: Readonly<
  Record<Exclude<Move, "run.resumed">, readonly RunStatus[]>
> = {
  "run.started": ["queued"],
  "gate.opened": ["running", "waiting_gate"],
  "gate.decided": ["waiting_gate"],
  "run.paused": active,
  "run.completed": ["running"],
  "run.failed": active,
  "run.cancelled": [...active, "paused"],
};

const changes: Readonly<
  Record<
    Exclude<Move, "run.resumed" | "gate.decided">,
    (run: RunState, gateId: string) => Change
  >
> = {
  "run.started": () => ({ status: "running" }),
  "gate.opened": (run, gateId) => ({
    status: "waiting_gate",
    gates: [...run.gates, gateId],
  }),
  "run.paused": (run) => ({ status: "paused", pausedFrom: run.status }),
  "run.completed": () => ({ status: "completed" }),
  "run.failed": () => ({ status: "failed" }),
  "run.cancelled": () => ({ status: "cancelled" }),
};

export type Transition =
  | { readonly kind: "moved"; readonly run: RunState }
  | { readonly kind: "invalid"; readonly reason: string };

export function transition(
  run: RunState,
  type: Move,
  gateId: string,
): Transition {
  if (terminal.includes(run.status)) return invalid("terminal-run");
  if (type === "run.resumed")
    return run.pausedFrom
      ? moved(run, { status: run.pausedFrom, pausedFrom: null })
      : invalid("invalid-transition");
  if (!sources[type].includes(run.status)) return invalid("invalid-transition");
  if (type === "gate.opened" && run.gates.includes(gateId))
    return invalid("existing-gate");
  if (type === "gate.decided")
    return run.gates.includes(gateId)
      ? moved(run, decided(run, gateId))
      : invalid("unknown-gate");
  return moved(run, changes[type](run, gateId));
}

function decided(run: RunState, gateId: string): Change {
  const gates = run.gates.filter((gate) => gate !== gateId);
  return { status: gates.length === 0 ? "running" : "waiting_gate", gates };
}

function moved(run: RunState, change: Change): Transition {
  return {
    kind: "moved",
    run: { ...run, ...change, revision: run.revision + 1 },
  };
}

function invalid(reason: string): Transition {
  return { kind: "invalid", reason };
}
