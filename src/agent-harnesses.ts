import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { basename, delimiter, resolve } from "node:path";
import {
  harnessDefinition,
  harnessVersion,
  knownHarnesses,
  type KnownHarness,
} from "./agent-harness-versions.ts";

import {
  shellArguments,
  shellBlock,
  shellDiscoveryScript,
  shellEntries,
  shellProbeScript,
  type ShellEntry,
  type ShellMode,
} from "./agent-harness-shell.ts";

export interface HarnessEntry {
  readonly name: string;
  readonly kind: "file" | "shell";
  readonly path: string;
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

interface ProbeOutput {
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly reason: string | null;
}

type Environment = Readonly<Record<string, string | undefined>>;

function killProbe(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runProbe(
  executable: string,
  options: { readonly arguments: readonly string[]; readonly env: Environment },
): Promise<ProbeOutput> {
  return new Promise((complete) => {
    const child = spawn(executable, [...options.arguments], {
      env: options.env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let reason: string | null = null;
    const stop = (failure: string): void => {
      if (reason !== null) return;
      reason = failure;
      killProbe(child);
      child.stdout.destroy();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) stop("probe-output-limit");
      else chunks.push(chunk);
    });
    const timer = setTimeout(() => {
      stop("probe-timeout");
    }, 10000);
    child.once("error", () => {
      reason ??= "probe-start";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      complete({
        exitCode: code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        reason: reason ?? (code === 0 ? null : "probe-exit"),
      });
    });
  });
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
  env: Environment,
): Promise<HarnessEntry> {
  const { name, path } = entry;
  const output = await runProbe(path, {
    arguments: [harnessDefinition(name).versionOption],
    env,
  });
  return probeEntry({ name, kind: "file", path }, output);
}

async function discoverFiles(
  definitions: readonly KnownHarness[],
  env: Environment,
): Promise<HarnessEntry[]> {
  const entries = await Promise.all(
    definitions.map(async ({ name }) => {
      const path = await findFile(name, env);
      return path === null ? [] : [await probeFile({ name, path }, env)];
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
  options: { readonly env: Environment; readonly mode: ShellMode },
): Promise<ShellScan> {
  const { env, mode } = options;
  const shell = env["SHELL"];
  if (!shell) return { entries: [], reason: "shell-unavailable", bash: false };
  const output = await runProbe(shell, {
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
  env: Environment,
): Promise<HarnessEntry> {
  const { entry, mode } = candidate;
  const { name, kind, path } = entry;
  const probe = await runProbe(env["SHELL"] ?? "", {
    arguments: [
      ...shellArguments(mode),
      shellProbeScript,
      "cloving-harness-probe",
      path,
      kind,
    ],
    env,
  });
  const stdout = shellBlock(probe.stdout, 0);
  return probeEntry(
    { name, kind, path },
    {
      stdout: stdout ?? "",
      reason: probe.reason ?? (stdout === null ? "shell-protocol" : null),
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
  },
): Promise<HarnessEntry[]> {
  const { files, env } = options;
  const settled = new Set(
    files
      .filter(
        (file) =>
          file.working ||
          file.reason === "probe-timeout" ||
          file.reason === "probe-output-limit",
      )
      .map(entryKey),
  );
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
        const probe = await probeShell({ entry, mode }, env);
        result = [probe];
        if (probe.working) break;
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
    readonly files: readonly HarnessEntry[];
  },
): Promise<HarnessDiscovery> {
  const { env, files } = options;
  const login = await inspectShell(names, { env, mode: "login" });
  if (login.reason !== null) return { entries: [], shellReason: login.reason };
  const interactive = login.bash
    ? await inspectShell(names, { env, mode: "interactive" })
    : null;
  const found = [
    ...login.entries.map((entry) => ({ entry, mode: "login" as const })),
    ...(interactive?.entries ?? []).map((entry) => ({
      entry,
      mode: "interactive" as const,
    })),
  ];
  const entries = await probeCandidates(found, { files, env });
  return { entries, shellReason: interactive?.reason ?? null };
}

async function discoverNames(
  definitions: readonly KnownHarness[],
  env: Environment,
): Promise<HarnessDiscovery> {
  const files = await discoverFiles(definitions, env);
  const shell = await discoverShell(
    definitions.map(({ name }) => name),
    { env, files },
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
  options: HarnessOptions = {},
): Promise<HarnessDiscovery> {
  return discoverNames(knownHarnesses, options.env ?? process.env);
}

export async function probeHarness(
  target: string,
  options: HarnessOptions = {},
): Promise<HarnessDiscovery> {
  const env = options.env ?? process.env;
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
        : await runProbe(path, { arguments: ["--version"], env });
    return { entries: [probeEntry(entry, output)], shellReason: null };
  }
  const found = await discoverNames([harnessDefinition(target)], env);
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
