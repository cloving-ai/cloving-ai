export interface DeadlineTimer {
  readonly clear: () => void;
}

export function fullDeadline(
  milliseconds: number,
  expired: (waited: number) => void,
): DeadlineTimer {
  const started = performance.now();
  const state: { timer?: NodeJS.Timeout } = {};
  const fire = (): void => {
    const waited = performance.now() - started;
    if (waited < milliseconds) {
      state.timer = setTimeout(fire, Math.ceil(milliseconds - waited)).unref();
      return;
    }
    expired(Math.round(waited));
  };
  state.timer = setTimeout(fire, milliseconds).unref();
  return {
    clear: () => {
      clearTimeout(state.timer);
    },
  };
}
