import { terminal } from "../../authority/transitions.ts";

export interface WatchedEvent {
  readonly name: string;
  readonly messageId: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface WatchReport {
  readonly kind: "stranded" | "dead-lettered";
  readonly messageId: string;
}

export type MessageRuns = (
  messageIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

export interface StrandingWatchdog {
  readonly observe: (event: WatchedEvent) => void;
  readonly report: (runs: MessageRuns) => Promise<WatchReport | undefined>;
}

const callbacks = ["deliveryCompleted", "deliveryFailed"];

const finished = [
  "solid_objects.message.completed",
  "solid_objects.message.failed",
  "solid_objects.message.rejected",
];

export function strandingWatchdog(bound: {
  readonly boundMilliseconds: number;
  readonly clock?: () => number;
}): StrandingWatchdog {
  const clock = bound.clock ?? monotonic;
  const lost = new Map<string, number>();
  const dead = new Set<string>();
  return {
    observe: (event) => {
      const { messageId } = event;
      if (messageId === null) return;
      if (deadCallback(event)) dead.add(messageId);
      if (
        event.name === "solid_objects.activation.lost" &&
        !lost.has(messageId)
      )
        lost.set(messageId, clock());
      if (finished.includes(event.name)) lost.delete(messageId);
    },
    report: async (runs) => {
      const overdue = overdueMessages(lost, clock() - bound.boundMilliseconds);
      const suspects = [...dead, ...overdue];
      if (suspects.length === 0) return undefined;
      const statuses = await runs(suspects);
      const released = suspects.filter((messageId) =>
        settled(statuses.get(messageId)),
      );
      for (const messageId of released) {
        lost.delete(messageId);
        dead.delete(messageId);
      }
      return firstReport({ dead: [...dead], stranded: overdue, lost });
    },
  };
}

function monotonic(): number {
  return performance.now();
}

function overdueMessages(
  lost: ReadonlyMap<string, number>,
  limit: number,
): readonly string[] {
  return [...lost]
    .filter(([, at]) => at < limit)
    .map(([messageId]) => messageId);
}

function settled(status: string | undefined): boolean {
  return terminal.some((candidate) => candidate === status);
}

function firstReport(found: {
  readonly dead: readonly string[];
  readonly stranded: readonly string[];
  readonly lost: ReadonlyMap<string, number>;
}): WatchReport | undefined {
  const deadLetter = found.dead[0];
  if (deadLetter !== undefined)
    return { kind: "dead-lettered", messageId: deadLetter };
  const stranded = found.stranded.find((messageId) =>
    found.lost.has(messageId),
  );
  return stranded === undefined
    ? undefined
    : { kind: "stranded", messageId: stranded };
}

function deadCallback(event: WatchedEvent): boolean {
  return (
    event.name === "solid_objects.dead_letter.created" &&
    callbacks.includes(String(event.attributes["operation"]))
  );
}
