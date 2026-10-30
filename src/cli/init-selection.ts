import type { HarnessSettings } from "../harness-defaults.ts";
import {
  discoverHarnesses,
  probeHarness,
  type HarnessEntry,
} from "./harness-probes.ts";
import type { ProbeRunner } from "./probe-command.ts";

interface SelectionContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
}

export async function selectedHarness(
  target: string,
  context: SelectionContext,
): Promise<HarnessEntry> {
  const shell = target.startsWith("shell:");
  const discovery = await probeHarness(shell ? target.slice(6) : target, {
    env: context.environment,
    probe: context.probe,
  });
  const entries = discovery.entries.filter(
    (entry) => entry.working && (!shell || entry.kind === "shell"),
  );
  if (entries.length > 1) throw new Error("harness-ambiguous");
  const entry = entries[0];
  if (entry === undefined) throw new Error("harness-unusable");
  return initEntry(entry);
}

export async function chooseHarness(
  context: SelectionContext & {
    readonly current: HarnessSettings["harness"];
    readonly question: (text: string) => Promise<string>;
  },
): Promise<HarnessEntry> {
  const entries = await availableHarnesses(context);
  const labels = entries.map(
    (entry, index) =>
      `  ${String(index + 1)}. ${entry.name}    ${entry.kind === "file" ? entry.path : "your shell function or alias"}`,
  );
  const other = entries.length + 1;
  const answer = await context.question(
    [
      ...labels,
      `  ${String(other)}. Other: type a name or a path`,
      "? Which agent harness do you want for the setup? [1]: ",
    ].join("\n"),
  );
  const number = answer === "" ? 1 : Number(answer);
  if (number === other) {
    const target = await context.question("Agent harness name or file path: ");
    return selectedHarness(target, context);
  }
  const entry = entries[number - 1];
  if (entry === undefined) throw new Error("harness-not-selected");
  return entry;
}

async function availableHarnesses(
  context: SelectionContext & {
    readonly current: HarnessSettings["harness"];
  },
): Promise<HarnessEntry[]> {
  const found = await discoverHarnesses({
    env: context.environment,
    probe: context.probe,
  });
  const entries = found.entries.filter((entry) => entry.working).map(initEntry);
  const current = context.current;
  if (
    current?.name !== undefined &&
    !entries.some((entry) => matchesCurrent(entry, current))
  ) {
    const target =
      current.kind === "shell"
        ? `shell:${current.path ?? current.name}`
        : (current.path ?? current.name);
    const discovery = await probeHarness(
      target.startsWith("shell:") ? target.slice(6) : target,
      {
        env: context.environment,
        probe: context.probe,
      },
    );
    const name = current.name;
    entries.push(
      ...discovery.entries
        .map(initEntry)
        .filter((entry) => entry.working && savedHarness(entry, current))
        .map((entry) => ({ ...entry, name })),
    );
  }
  entries.sort(
    (left, right) =>
      Number(matchesCurrent(right, current)) -
      Number(matchesCurrent(left, current)),
  );
  return entries;
}

function savedHarness(
  entry: HarnessEntry,
  current: NonNullable<HarnessSettings["harness"]>,
): boolean {
  return (
    (current.kind === undefined || current.kind === entry.kind) &&
    (current.path === undefined || current.path === entry.path)
  );
}

function matchesCurrent(
  entry: HarnessEntry,
  current: HarnessSettings["harness"],
): boolean {
  return (
    current?.name === entry.name &&
    (current.kind === undefined || current.kind === entry.kind) &&
    (current.path === undefined || current.path === entry.path)
  );
}

function initEntry(entry: HarnessEntry): HarnessEntry {
  if (/^[a-z][a-z0-9-]{0,63}$/.test(entry.name)) return entry;
  const slug = entry.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return { ...entry, name: `agent-${slug}`.slice(0, 64) };
}
