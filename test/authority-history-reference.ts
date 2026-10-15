import { type History, type OutboxEntry } from "../src/authority/history.ts";
import { type Evidence } from "../src/authority/operations.ts";
import { applyEvent, emptyAuthority } from "../src/authority/reducer.ts";

export function referenceHistory(
  events: readonly unknown[],
  sequence = 0,
): History {
  let state = { ...emptyAuthority, sequence };
  const entries: OutboxEntry[] = [];
  const releases = new Map<string, number>();
  const sequences: Record<string, number> = {};
  const evidence: Evidence[] = [];
  events.forEach((value, index) => {
    const previous = state.intents;
    const result = applyEvent(state, { value, index });
    state = result.state;
    sequences[result.event.runId] = state.sequence;
    evidence.push(...result.evidence);
    const pending = new Set(state.intents.map((intent) => intent.operationId));
    for (const intent of previous)
      if (!pending.has(intent.operationId))
        releases.set(intent.operationId, state.sequence);
    const known = new Set(previous.map((intent) => intent.operationId));
    entries.push(
      ...state.intents
        .filter((intent) => !known.has(intent.operationId))
        .map((intent) => ({
          ...intent,
          createdSequence: state.sequence,
          releasedSequence: null,
        })),
    );
  });
  return {
    state,
    evidence,
    runSequences: sequences,
    outbox: entries.map((entry) => ({
      ...entry,
      releasedSequence: releases.get(entry.operationId) ?? null,
    })),
  };
}
