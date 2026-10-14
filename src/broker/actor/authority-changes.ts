export type SequenceListener = (sequence: number) => void;

interface Envelope {
  readonly kind: string;
  readonly observables?: Readonly<Record<string, unknown>>;
}

export interface Realtime {
  connect(options: {
    readonly authorizationContext: unknown;
    readonly send: (envelope: Envelope) => void;
  }): {
    receive(request: unknown): Promise<void>;
    close(): void;
  };
}

export interface SequenceSource {
  readonly realtime: Realtime;
  readonly broker: object;
  readonly actorType: string;
  readonly actorId: string;
}

export function sequenceChanges(
  source: SequenceSource,
  listener: SequenceListener,
): () => void {
  let last = -1;
  const session = source.realtime.connect({
    authorizationContext: source.broker,
    send: (envelope) => {
      const sequence = envelope.observables?.["sequence"];
      if (typeof sequence !== "number" || sequence <= last) return;
      last = sequence;
      listener(sequence);
    },
  });
  const request = {
    version: 1,
    action: "subscribe",
    actorType: source.actorType,
    actorId: source.actorId,
  };
  session.receive(request).then(undefined, () => {
    session.close();
  });
  return () => {
    session.close();
  };
}

export function sequenceSubscriber(
  source: Pick<SequenceSource, "realtime" | "broker">,
): (actorId: string, listener: SequenceListener) => () => void {
  return (actorId, listener) =>
    sequenceChanges(
      { ...source, actorType: "ClovingAuthority", actorId },
      listener,
    );
}

export interface SequenceChanges {
  readonly subscribe: (listener: SequenceListener) => () => void;
}

export interface Subscriptions {
  readonly add: (listener: SequenceListener) => () => void;
  readonly close: () => void;
}

export function subscriptions(
  subscribe: (listener: SequenceListener) => () => void,
): Subscriptions {
  const open = new Set<() => void>();
  return {
    add: (listener) => {
      const close = subscribe(listener);
      open.add(close);
      return () => {
        open.delete(close);
        close();
      };
    },
    close: () => {
      for (const close of open) close();
      open.clear();
    },
  };
}
