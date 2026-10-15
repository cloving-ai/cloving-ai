import type { Evidence } from "./operations.ts";
import { HistoryState } from "./history-state.ts";
import {
  applyEvent,
  type AuthorityState,
  type EffectIntent,
} from "./reducer.ts";

export interface OutboxEntry extends EffectIntent {
  readonly createdSequence: number;
  readonly releasedSequence: number | null;
}

export interface History {
  readonly state: AuthorityState;
  readonly outbox: readonly OutboxEntry[];
  readonly runSequences: Readonly<Record<string, number>>;
  readonly evidence: readonly Evidence[];
}

export function rebuildHistory(events: readonly unknown[]): History {
  const replay = new HistoryState();
  const created: OutboxEntry[] = [];
  const released = new Map<string, number>();
  const runSequences: Record<string, number> = {};
  const evidence: Evidence[] = [];
  for (const [index, value] of events.entries()) {
    const state = replay.scope(value);
    const applied = applyEvent(state, { value, index });
    const before = new Set(state.intents.map((intent) => intent.operationId));
    const after = new Set(
      applied.state.intents.map((intent) => intent.operationId),
    );
    for (const intent of applied.state.intents)
      if (!before.has(intent.operationId))
        created.push({
          ...intent,
          createdSequence: applied.event.sequence,
          releasedSequence: null,
        });
    for (const operationId of before)
      if (!after.has(operationId))
        released.set(operationId, applied.event.sequence);
    runSequences[applied.event.runId] = applied.event.sequence;
    evidence.push(...applied.evidence);
    replay.record(applied.state, applied.event.runId);
  }
  return {
    state: replay.finish(),
    outbox: created.map((entry) => ({
      ...entry,
      releasedSequence: released.get(entry.operationId) ?? null,
    })),
    runSequences,
    evidence,
  };
}
