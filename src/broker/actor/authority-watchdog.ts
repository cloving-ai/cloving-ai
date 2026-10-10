export interface WatchedEvent {
  readonly name: string;
  readonly messageId: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface StrandingWatchdog {
  readonly observe: (event: WatchedEvent, at: number) => void;
  readonly stranded: (now: number) => string | undefined;
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
}): StrandingWatchdog {
  const lost = new Map<string, number>();
  const dead: string[] = [];
  return {
    observe: (event, at) => {
      const { messageId } = event;
      if (messageId === null) return;
      if (deadCallback(event)) dead.push(messageId);
      if (
        event.name === "solid_objects.activation.lost" &&
        !lost.has(messageId)
      )
        lost.set(messageId, at);
      if (finished.includes(event.name)) lost.delete(messageId);
    },
    stranded: (now) =>
      [...lost].find(([, at]) => now - at > bound.boundMilliseconds)?.[0],
    deadLettered: () => dead[0],
  };
}

function deadCallback(event: WatchedEvent): boolean {
  return (
    event.name === "solid_objects.dead_letter.created" &&
    callbacks.includes(String(event.attributes["operation"]))
  );
}
