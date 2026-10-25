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
  shellBlock,
  shellDiscoveryScript,
  shellEntries,
  shellProbeScript,
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

async function discoverFiles(
  definitions: readonly KnownHarness[],
  env: Environment,
): Promise<HarnessEntry[]> {
  const entries = await Promise.all(
    definitions.map(async (definition) => {
      const path = await findFile(definition.name, env);
      if (path === null) return [];
      const output = await runProbe(path, {
        arguments: [definition.versionOption],
        env,
      });
      return [
        probeEntry({ name: definition.name, kind: "file", path }, output),
      ];
    }),
  );
  return entries.flat();
}

async function discoverShell(
  names: readonly string[],
  env: Environment,
): Promise<HarnessDiscovery> {
  const shell = env["SHELL"];
  if (!shell) return { entries: [], shellReason: "shell-unavailable" };
  const output = await runProbe(shell, {
    arguments: [
      "-l",
      "-i",
      "+m",
      "-c",
      shellDiscoveryScript,
      "cloving-harnesses",
      ...names,
    ],
    env,
  });
  if (output.exitCode === 64)
    return { entries: [], shellReason: "unsupported-shell" };
  if (output.reason !== null)
    return { entries: [], shellReason: output.reason };
  const found = shellEntries(output.stdout, names);
  if (found === null) return { entries: [], shellReason: "shell-protocol" };
  const entries = await Promise.all(
    found.map(async (name) => {
      const probe = await runProbe(shell, {
        arguments: [
          "-l",
          "-i",
          "+m",
          "-c",
          shellProbeScript,
          "cloving-harness-probe",
          name,
        ],
        env,
      });
      const stdout = shellBlock(probe.stdout, 0);
      return probeEntry(
        { name, kind: "shell", path: name },
        {
          stdout: stdout ?? "",
          reason: probe.reason ?? (stdout === null ? "shell-protocol" : null),
        },
      );
    }),
  );
  return { entries, shellReason: null };
}

async function discoverNames(
  definitions: readonly KnownHarness[],
  env: Environment,
): Promise<HarnessDiscovery> {
  const [files, shell] = await Promise.all([
    discoverFiles(definitions, env),
    discoverShell(
      definitions.map(({ name }) => name),
      env,
    ),
  ]);
  return {
    entries: [...files, ...shell.entries],
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
  if (!target.includes("/")) {
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
