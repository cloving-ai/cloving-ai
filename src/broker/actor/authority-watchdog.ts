export interface WatchedEvent {
  readonly name: string;
  readonly messageId: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface StrandingWatchdog {
  readonly observe: (event: WatchedEvent) => void;
  readonly stranded: () => string | undefined;
  readonly deadLettered: () => string | undefined;
}

const callbacks = ["deliveryCompleted", "deliveryFailed"];

const finished = [
  "solid_objects.message.completed",
  "solid_objects.message.failed",
  "solid_objects.message.rejected",
];

export function strandingWatchdog(bound: {
  readonly boundMilliseconds: number;
  readonly whenStranded?: () => void;
  readonly clock?: () => number;
}): StrandingWatchdog {
  const clock = bound.clock ?? monotonic;
  const lost = new Map<string, number>();
  const dead: string[] = [];
  let halted: string | undefined;
  const stranded = (): string | undefined =>
    halted ?? overdue(lost, clock() - bound.boundMilliseconds);
  return {
    observe: (event) => {
      const { messageId } = event;
      if (messageId === null) return;
      if (deadCallback(event)) dead.push(messageId);
      if (
        event.name === "solid_objects.activation.lost" &&
        !lost.has(messageId)
      )
        lost.set(messageId, clock());
      if (finished.includes(event.name)) lost.delete(messageId);
      halted ??= stranded();
      if (halted !== undefined) bound.whenStranded?.();
    },
    stranded,
    deadLettered: () => dead[0],
  };
}

function monotonic(): number {
  return performance.now();
}

function overdue(
  lost: ReadonlyMap<string, number>,
  limit: number,
): string | undefined {
  return [...lost].find(([, at]) => at < limit)?.[0];
}

function deadCallback(event: WatchedEvent): boolean {
  return (
    event.name === "solid_objects.dead_letter.created" &&
    callbacks.includes(String(event.attributes["operation"]))
  );
}
