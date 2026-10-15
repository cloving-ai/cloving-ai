export interface SelfUpdate {
  readonly signal?: AbortSignal;
  readonly git: (argumentsList: readonly string[]) => Promise<string>;
  readonly activeTurn: () => Promise<boolean>;
  readonly failed: (commit: string) => Promise<boolean>;
  readonly recordFailure: (commit: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly report: (message: string) => void;
}

const statusArguments = [
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--ignore-submodules=none",
];

async function candidate(
  settings: SelfUpdate,
): Promise<{ readonly before: string; readonly target: string } | undefined> {
  await settings.git(["fetch", "origin"]);
  const remote = await settings.git([
    "ls-remote",
    "--symref",
    "origin",
    "HEAD",
  ]);
  const defaultBranch = /^ref: (refs\/heads\/\S+)\s+HEAD$/m.exec(remote)?.[1];
  if (defaultBranch === undefined) return undefined;
  const branch = await settings.git(["symbolic-ref", "HEAD"]);
  if (branch !== defaultBranch) return undefined;
  const before = await settings.git(["rev-parse", "HEAD"]);
  const target = await settings.git([
    "rev-parse",
    defaultBranch.replace("refs/heads/", "refs/remotes/origin/"),
  ]);
  if (before === target) return undefined;
  await settings.git(["merge-base", "--is-ancestor", before, target]);
  if (await settings.git(statusArguments)) return undefined;
  if (/^[a-zS] /m.test(await settings.git(["ls-files", "-v"])))
    return undefined;
  if (await settings.activeTurn()) return undefined;
  return { before, target };
}

function cause(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /\s+/g,
    " ",
  );
}

async function failedUpdate(
  settings: SelfUpdate,
  failure: { readonly target: string; readonly error: unknown },
): Promise<number> {
  const message = `self-update-failed: ${cause(failure.error)}`;
  try {
    await settings.recordFailure(failure.target);
  } catch (error) {
    settings.report(`${message}; failure-record-failed: ${cause(error)}`);
    return 1;
  }
  settings.report(message);
  return 75;
}

async function updated(
  settings: SelfUpdate,
  target: string,
): Promise<number | undefined> {
  await settings.stop();
  if (settings.signal?.aborted) return undefined;
  try {
    if (await settings.git(statusArguments))
      throw new Error("checkout-changed");
    await settings.git(["merge", "--ff-only", "--no-overwrite-ignore", target]);
  } catch (error) {
    return failedUpdate(settings, { target, error });
  }
  return 75;
}

export function selfUpdater(
  settings: SelfUpdate,
): () => Promise<number | undefined> {
  let busy = false;
  let disabled = false;
  return async () => {
    if (busy || disabled || settings.signal?.aborted) return undefined;
    busy = true;
    try {
      const selected = await candidate(settings).catch(() => undefined);
      if (selected === undefined) return undefined;
      const { before, target } = selected;
      if (
        await settings.git([
          "diff",
          "--name-only",
          before,
          target,
          "--",
          "package-lock.json",
        ])
      ) {
        disabled = true;
        settings.report(
          "self-update-disabled: package-lock.json changed; update and install by hand.",
        );
        return undefined;
      }
      if (await settings.failed(target)) return undefined;
      if (settings.signal?.aborted) return undefined;
      disabled = true;
      return await updated(settings, target);
    } finally {
      busy = false;
    }
  };
}
