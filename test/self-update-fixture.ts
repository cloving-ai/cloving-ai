import type { SelfUpdate } from "../tools/self-update.ts";

export function updateFixture() {
  const calls: string[] = [];
  const failures = new Set<string>();
  const journal = new Map<string, { readonly result?: string }>();
  const replies = new Map([
    ["fetch origin", ""],
    [
      "ls-remote --symref origin HEAD",
      "ref: refs/heads/main\tHEAD\nafter\tHEAD",
    ],
    ["symbolic-ref HEAD", "refs/heads/main"],
    ["rev-parse HEAD", "before"],
    ["rev-parse refs/remotes/origin/main", "after"],
    ["merge-base --is-ancestor before after", ""],
    ["status --porcelain --untracked-files=all --ignore-submodules=none", ""],
    ["ls-files -v", "H package-lock.json\n"],
    ["diff --name-only before after -- package-lock.json", ""],
    ["merge --ff-only --no-overwrite-ignore after", ""],
  ]);
  const settings: SelfUpdate = {
    git: (argumentsList) => {
      const command = argumentsList.join(" ");
      calls.push(command);
      const reply = replies.get(command);
      if (reply === undefined) return Promise.reject(new Error(command));
      return Promise.resolve(reply);
    },
    activeTurn: () =>
      Promise.resolve([...journal.values()].some((turn) => !turn.result)),
    failed: (commit) => Promise.resolve(failures.has(commit)),
    recordFailure: (commit) => {
      failures.add(commit);
      return Promise.resolve();
    },
    stop: () => {
      calls.push("stop");
      return Promise.resolve();
    },
    report: (message) => calls.push(`error: ${message}`),
  };
  return { calls, failures, journal, replies, settings };
}

export function heldFetch() {
  const fixture = updateFixture();
  const fetching = Promise.withResolvers<string>();
  const fetches: string[] = [];
  const settings: SelfUpdate = {
    ...fixture.settings,
    git: (argumentsList) => {
      if (argumentsList[0] !== "fetch")
        return fixture.settings.git(argumentsList);
      fetches.push("fetch");
      return fetching.promise;
    },
  };
  return { ...fixture, settings, fetching, fetches };
}
