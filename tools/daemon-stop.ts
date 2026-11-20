export interface StopOptions {
  readonly turns?: "keep";
}

export interface StopHost {
  readonly on: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly exit: (code: number) => void;
}

export interface StopLatch {
  readonly closeWith: (
    close: (options: StopOptions) => Promise<void>,
  ) => Promise<void>;
}

export function stopLatch(
  keepSignal: NodeJS.Signals,
  host: StopHost = process,
): StopLatch {
  const requested = Promise.withResolvers<StopOptions>();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    host.on(signal, () => {
      requested.resolve({});
    });
  host.on(keepSignal, () => {
    requested.resolve({ turns: "keep" });
  });
  return {
    closeWith: async (close) => {
      await close(await requested.promise);
      host.exit(0);
    },
  };
}
