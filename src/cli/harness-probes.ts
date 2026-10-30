import type { ProbeRunner, ProbeOutput } from "./probe-command.ts";
import { access, constants, stat } from "node:fs/promises";
import { basename, delimiter, resolve } from "node:path";
import {
  harnessDefinition,
  harnessVersion,
  knownHarnesses,
  type KnownHarness,
} from "../agent-harness-versions.ts";

import {
  shellArguments,
  shellBlock,
  shellDiscoveryScript,
  shellEntries,
  shellProbeScript,
  type ShellEntry,
  type ShellMode,
} from "../agent-harness-shell.ts";

export interface HarnessEntry {
  readonly name: string;
  readonly kind: "file" | "shell";
  readonly path: string;
  readonly shellMode?: ShellMode;
  readonly version: string | null;
  readonly working: boolean;
  readonly reason: string | null;
}

export interface HarnessDiscovery {
  readonly entries: HarnessEntry[];
  readonly shellReason: string | null;
}

export interface HarnessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type Environment = Readonly<Record<string, string | undefined>>;
interface ProbeContext {
  readonly env: Environment;
  readonly probe: ProbeRunner;
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findFile(
  name: string,
  env: Environment,
): Promise<string | null> {
  if (name.includes("/")) {
    const path = resolve(name);
    return (await executableFile(path)) ? path : null;
  }
  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    const path = resolve(directory, name);
    if (await executableFile(path)) return path;
  }
  return null;
}

function probeEntry(
  entry: Pick<HarnessEntry, "name" | "kind" | "path">,
  output: ProbeOutput,
): HarnessEntry {
  const version = harnessVersion(
    output.stdout,
    harnessDefinition(entry.name).versionPattern,
  );
  const reason = output.reason ?? (version === null ? "no-version" : null);
  return {
    ...entry,
    version: reason === null ? version : null,
    working: reason === null,
    reason,
  };
}

async function probeFile(
  entry: Pick<HarnessEntry, "name" | "path">,
  context: ProbeContext,
): Promise<HarnessEntry> {
  const { env, probe } = context;
  const { name, path } = entry;
  const output = await probe(path, {
    arguments: [harnessDefinition(name).versionOption],
    env,
  });
  return probeEntry({ name, kind: "file", path }, output);
}

async function discoverFiles(
  definitions: readonly KnownHarness[],
  context: ProbeContext,
): Promise<HarnessEntry[]> {
  const { env } = context;
  const entries = await Promise.all(
    definitions.map(async ({ name }) => {
      const path = await findFile(name, env);
      return path === null ? [] : [await probeFile({ name, path }, context)];
    }),
  );
  return entries.flat();
}

interface ShellScan {
  readonly entries: ShellEntry[];
  readonly reason: string | null;
  readonly bash: boolean;
}

async function inspectShell(
  names: readonly string[],
  options: ProbeContext & { readonly mode: ShellMode },
): Promise<ShellScan> {
  const { env, mode, probe } = options;
  const shell = env["SHELL"];
  if (!shell) return { entries: [], reason: "shell-unavailable", bash: false };
  const output = await probe(shell, {
    arguments: [
      ...shellArguments(mode),
      shellDiscoveryScript,
      "cloving-harnesses",
      ...names,
    ],
    env,
  });
  const found = shellEntries(output.stdout, names);
  const reason = output.exitCode === 64 ? "unsupported-shell" : output.reason;
  return {
    entries: reason === null ? (found ?? []) : [],
    reason: reason ?? (found === null ? "shell-protocol" : null),
    bash: shellBlock(output.stdout, -1)?.trim() === "bash",
  };
}

async function probeShell(
  candidate: ShellCandidate,
  context: ProbeContext,
): Promise<HarnessEntry> {
  const { env, probe } = context;
  const { entry, mode } = candidate;
  const { name, kind, path } = entry;
  const output = await probe(env["SHELL"] ?? "", {
    arguments: [
      ...shellArguments(mode),
      shellProbeScript,
      "cloving-harness-probe",
      path,
      kind,
    ],
    env,
  });
  const stdout = shellBlock(output.stdout, 0);
  return probeEntry(
    { name, kind, path, ...(kind === "shell" ? { shellMode: mode } : {}) },
    {
      stdout: stdout ?? "",
      reason: output.reason ?? (stdout === null ? "shell-protocol" : null),
    },
  );
}

function entryKey(entry: Pick<HarnessEntry, "name" | "kind" | "path">): string {
  return JSON.stringify([entry.name, entry.kind, entry.path]);
}

interface ShellCandidate {
  readonly entry: ShellEntry;
  readonly mode: ShellMode;
}

async function probeCandidates(
  candidates: readonly ShellCandidate[],
  options: {
    readonly files: readonly HarnessEntry[];
    readonly env: Environment;
    readonly probe: ProbeRunner;
  },
): Promise<HarnessEntry[]> {
  const { files, env, probe } = options;
  const settled = new Set(files.filter((file) => file.working).map(entryKey));
  const groups = new Map<string, ShellCandidate[]>();
  for (const candidate of candidates) {
    const key = entryKey(candidate.entry);
    if (settled.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const entries = await Promise.all(
    [...groups.values()].map(async (group) => {
      let result: HarnessEntry[] = [];
      for (const { entry, mode } of group) {
        const output = await probeShell({ entry, mode }, { env, probe });
        result = [output];
        if (output.working) break;
      }
      return result;
    }),
  );
  return entries.flat();
}

async function discoverShell(
  names: readonly string[],
  options: {
    readonly env: Environment;
    readonly probe: ProbeRunner;
    readonly files: readonly HarnessEntry[];
  },
): Promise<HarnessDiscovery> {
  const { env, files, probe } = options;
  const login = await inspectShell(names, { env, mode: "login", probe });
  const interactive =
    login.bash ||
    (login.reason !== null && basename(env["SHELL"] ?? "") !== "zsh")
      ? await inspectShell(names, { env, mode: "interactive", probe })
      : null;
  const found = [
    ...login.entries.map((entry) => ({ entry, mode: "login" as const })),
    ...(interactive?.bash ? interactive.entries : []).map((entry) => ({
      entry,
      mode: "interactive" as const,
    })),
  ];
  const entries = await probeCandidates(found, { files, env, probe });
  return { entries, shellReason: login.reason ?? interactive?.reason ?? null };
}

async function discoverNames(
  definitions: readonly KnownHarness[],
  context: ProbeContext,
): Promise<HarnessDiscovery> {
  const { env, probe } = context;
  const files = await discoverFiles(definitions, context);
  const shell = await discoverShell(
    definitions.map(({ name }) => name),
    { env, files, probe },
  );
  return {
    entries: [
      ...new Map(
        [...files, ...shell.entries].map((entry) => [entryKey(entry), entry]),
      ).values(),
    ],
    shellReason: shell.shellReason,
  };
}

export function discoverHarnesses(
  options: HarnessOptions & { readonly probe: ProbeRunner },
): Promise<HarnessDiscovery> {
  return discoverNames(knownHarnesses, {
    env: options.env ?? process.env,
    probe: options.probe,
  });
}

export async function probeHarness(
  target: string,
  options: HarnessOptions & { readonly probe: ProbeRunner },
): Promise<HarnessDiscovery> {
  const env = options.env ?? process.env;
  const probe = options.probe;
  if (target.includes("/")) {
    const path = await findFile(target, env);
    const entry = {
      name: basename(target),
      kind: "file" as const,
      path: path ?? target,
    };
    const output =
      path === null
        ? { stdout: "", reason: "not-found" }
        : await probe(path, { arguments: ["--version"], env });
    return { entries: [probeEntry(entry, output)], shellReason: null };
  }
  const found = await discoverNames([harnessDefinition(target)], {
    env,
    probe,
  });
  if (found.entries.length > 0) return found;
  return {
    ...found,
    entries: [
      probeEntry(
        { name: target, kind: "file", path: target },
        { stdout: "", reason: "not-found" },
      ),
    ],
  };
}
