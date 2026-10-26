import { Actor } from "solid-objects";

export const outboxIdentity = "phone";

export type OpenDecision = {
  readonly decisionId: string;
  readonly runId: string;
};

export class PhoneOutbox extends Actor {
  static override readonly actorType = "PhoneOutbox";

  decisions: OpenDecision[] = [];

  retired: string[] = [];

  track(decision: OpenDecision): boolean {
    if (this.decisions.some((item) => item.decisionId === decision.decisionId))
      return false;
    this.decisions = [...this.decisions, decision];
    return true;
  }

  retire({ decisionId }: { readonly decisionId: string }): void {
    if (!this.retired.includes(decisionId))
      this.retired = [...this.retired, decisionId];
  }

  forget({ decisionId }: { readonly decisionId: string }): void {
    this.retired = this.retired.filter((item) => item !== decisionId);
  }

  untrack({ decisionId }: { readonly decisionId: string }): boolean {
    const known = this.decisions.some((item) => item.decisionId === decisionId);
    this.decisions = this.decisions.filter(
      (item) => item.decisionId !== decisionId,
    );
    return known;
  }
}
