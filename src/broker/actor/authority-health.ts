import type { Logger } from "solid-objects";

export interface AuthorityHealth {
  readonly refresh: () => Promise<void>;
  readonly condition: () => string | null;
}

interface HealthState {
  condition: string | null;
  checks: number;
  checked: number;
}

export function authorityHealth(source: {
  readonly condition: () => Promise<string | undefined>;
  readonly logger: Logger;
}): AuthorityHealth {
  const state: HealthState = { condition: null, checks: 0, checked: 0 };
  return {
    refresh: async () => {
      state.checks += 1;
      const check = state.checks;
      const detected = (await source.condition()) ?? null;
      if (check < state.checked) return;
      state.checked = check;
      changed(state, { detected, logger: source.logger });
    },
    condition: () => state.condition,
  };
}

function changed(
  state: HealthState,
  change: { readonly detected: string | null; readonly logger: Logger },
): void {
  const { detected, logger } = change;
  const previous = state.condition;
  state.condition = detected;
  if (previous === null && detected !== null)
    logger.warn({ event: "authority-unhealthy", condition: detected });
  if (previous !== null && detected === null)
    logger.info({ event: "authority-recovered", condition: previous });
}
