export interface ChangeWait {
  readonly after: number;
  readonly milliseconds: number;
}

export interface ChangeSignal {
  readonly next: (wait: ChangeWait) => Promise<void>;
  readonly close: () => void;
}

type Subscribe = (listener: (sequence: number) => void) => () => void;

export function changeSignal(subscribe: Subscribe): ChangeSignal {
  const waiting = new Set<() => void>();
  const seen = { latest: -1, closed: false };
  const wake = (): void => {
    for (const settle of [...waiting]) settle();
  };
  const unsubscribe = subscribe((sequence) => {
    seen.latest = Math.max(seen.latest, sequence);
    wake();
  });
  return {
    next: ({ after, milliseconds }) => {
      if (seen.closed || seen.latest > after) return Promise.resolve();
      return new Promise((settle) => {
        const done = (): void => {
          clearTimeout(timer);
          waiting.delete(done);
          settle();
        };
        const timer = setTimeout(done, milliseconds);
        waiting.add(done);
      });
    },
    close: () => {
      seen.closed = true;
      unsubscribe();
      wake();
    },
  };
}
