interface HarnessProcessEffects {
  readonly snapshot: () => string;
  readonly kill: (identifier: number, signal: "SIGTERM") => boolean;
}

function harnessProcesses(
  identifier: number,
  effects: HarnessProcessEffects,
): number[] {
  let snapshot: string;
  try {
    snapshot = effects.snapshot();
  } catch {
    return [identifier];
  }
  const rows = snapshot
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number));
  const identifiers = [identifier];
  for (let index = 0; index < identifiers.length; index++) {
    for (const [child, parent] of rows) {
      if (parent === identifiers[index] && child !== undefined && child > 0)
        identifiers.push(child);
    }
  }
  return identifiers;
}

export function terminateHarness(
  identifier: number | undefined,
  effects: HarnessProcessEffects,
): void {
  if (identifier === undefined) return;
  for (const target of harnessProcesses(identifier, effects).reverse()) {
    try {
      effects.kill(target, "SIGTERM");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      )
        throw error;
    }
  }
}
