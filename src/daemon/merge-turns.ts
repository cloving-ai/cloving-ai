const turns = new Map<string, Promise<undefined>>();

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

export async function inMergeTurn<Result>(
  turn: MergeTurn,
  work: () => Promise<Result>,
): Promise<Result> {
  const previous = turns.get(turn.repository) ?? Promise.resolve(undefined);
  const ended = Promise.withResolvers<undefined>();
  const queued: Promise<undefined> = previous
    .then(() => ended.promise)
    .then(() => {
      if (turns.get(turn.repository) === queued) turns.delete(turn.repository);
      return undefined;
    });
  turns.set(turn.repository, queued);
  try {
    await waited(previous, turn.signal);
    return await work();
  } finally {
    ended.resolve(undefined);
  }
}
