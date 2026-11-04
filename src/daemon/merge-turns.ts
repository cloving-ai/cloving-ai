const turns = new Map<string, Promise<undefined>>();

export interface Turn {
  readonly key: string;
  readonly signal: AbortSignal;
}

export interface MergeTurn {
  readonly repository: string;
  readonly signal: AbortSignal;
}

function waited(
  previous: Promise<undefined>,
  signal: AbortSignal,
): Promise<undefined> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error ? reason : new Error("merge-turn-aborted"),
      );
    };
    signal.addEventListener("abort", aborted, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", aborted);
      resolve(undefined);
    }, reject);
  });
}

export async function inTurn<Result>(
  turn: Turn,
  work: () => Promise<Result>,
): Promise<Result> {
  const previous = turns.get(turn.key) ?? Promise.resolve(undefined);
  const ended = Promise.withResolvers<undefined>();
  const queued: Promise<undefined> = previous
    .then(() => ended.promise)
    .then(() => {
      if (turns.get(turn.key) === queued) turns.delete(turn.key);
      return undefined;
    });
  turns.set(turn.key, queued);
  try {
    await waited(previous, turn.signal);
    return await work();
  } finally {
    ended.resolve(undefined);
  }
}

export function inMergeTurn<Result>(
  turn: MergeTurn,
  work: () => Promise<Result>,
): Promise<Result> {
  return inTurn({ key: turn.repository, signal: turn.signal }, work);
}
