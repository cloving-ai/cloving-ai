import { parseEvent } from "./events.ts";
import { emptyAuthority } from "./reducer.ts";
import type { AuthorityState, EffectIntent } from "./transitions.ts";

function entry<Value>(
  values: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  const value = values[key];
  return value === undefined ? {} : { [key]: value };
}

export class HistoryState {
  private state = emptyAuthority;
  private readonly runs: Record<string, AuthorityState["runs"][string]> = {};
  private readonly commands: Record<
    string,
    AuthorityState["commands"][string]
  > = {};
  private readonly details: Record<string, AuthorityState["details"][string]> =
    {};
  private readonly gates: Record<string, AuthorityState["gates"][string]> = {};
  private readonly budgets: Record<
    string,
    AuthorityState["effects"]["budgets"][string]
  > = {};
  private readonly runGates = new Map<string, AuthorityState["gates"]>();
  private readonly intents = new Map<string, readonly EffectIntent[]>();
  private readonly pending = new Set<EffectIntent>();

  scope(value: unknown): AuthorityState {
    const event = parseEvent(value);
    if (event === null) return this.state;
    return {
      ...this.state,
      runs: entry(this.runs, event.runId),
      commands: entry(this.commands, event.commandId),
      details: entry(this.details, event.runId),
      gates: this.runGates.get(event.runId) ?? {},
      effects: {
        ...this.state.effects,
        budgets: entry(this.budgets, event.runId),
      },
      intents: this.intents.get(event.runId) ?? [],
    };
  }

  record(state: AuthorityState, runId: string): void {
    Object.assign(this.runs, state.runs);
    Object.assign(this.commands, state.commands);
    Object.assign(this.details, state.details);
    Object.assign(this.gates, state.gates);
    Object.assign(this.budgets, state.effects.budgets);
    this.runGates.set(runId, state.gates);
    const remaining = new Set(state.intents);
    for (const intent of this.intents.get(runId) ?? [])
      if (!remaining.has(intent)) this.pending.delete(intent);
    for (const intent of remaining) this.pending.add(intent);
    this.intents.set(runId, state.intents);
    this.state = state;
  }

  finish(): AuthorityState {
    return {
      ...this.state,
      runs: this.runs,
      commands: this.commands,
      details: this.details,
      gates: this.gates,
      effects: { ...this.state.effects, budgets: this.budgets },
      intents: [...this.pending],
    };
  }
}
