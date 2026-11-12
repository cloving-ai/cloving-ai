import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import type { HostProcesses } from "../tools/self-host-processes.ts";
import { testMilliseconds } from "./test-timing.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

interface ProgramOptions {
  readonly daemonMilliseconds?: number;
  readonly watchStartupMilliseconds?: number;
  readonly readyPrograms?: readonly string[];
  readonly stuckPrograms?: readonly string[];
  readonly announcedMilliseconds?: number | "never";
  readonly watchExits?: readonly WatchExit[];
  readonly statusRuns?: readonly Readonly<Record<string, string>>[];
}

export interface WatchExit {
  readonly code: number;
  readonly milliseconds: number;
}

function watchExit(root: string, options: ProgramOptions): string {
  if (options.watchExits === undefined) return "";
  return `appendFileSync(${JSON.stringify(join(root, "watch-starts"))}, process.pid + "\\n");
const start = readFileSync(${JSON.stringify(join(root, "watch-starts"))}, "utf8").trim().split("\\n").length;
writeFileSync(${JSON.stringify(root)} + "/watch-" + start + "-ready", String(process.pid));
const exit = ${JSON.stringify(options.watchExits)}[start - 1];
if (exit !== undefined) setTimeout(() => process.exit(exit.code), exit.milliseconds);`;
}

function watchStartup(root: string, options: ProgramOptions): string {
  return `writeFileSync(${JSON.stringify(join(root, "watch-saw-daemon"))}, String(existsSync(${JSON.stringify(join(root, "daemon-announced"))})));
await new Promise(resolve => setTimeout(resolve, ${String(options.watchStartupMilliseconds ?? 0)}));`;
}

function announcement(root: string, options: ProgramOptions): string {
  if (options.announcedMilliseconds === "never") return "";
  return `setTimeout(() => {
  writeFileSync(${JSON.stringify(join(root, "daemon-announced"))}, "announced");
  process.send?.("started");
  process.channel?.unref();
}, ${String(options.announcedMilliseconds ?? 0)});`;
}

export async function programs(
  root: string,
  options: ProgramOptions = {},
): Promise<{ readonly product: string; readonly project: string }> {
  const product = join(root, "product");
  const project = join(root, "project");
  await mkdir(join(product, "src"), { recursive: true });
  await mkdir(project);
  const program = (name: string): string => `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const parent = process.ppid;
if (parent === 1) process.exit(0);
writeFileSync(${JSON.stringify(join(root, `${name}-started`))}, String(process.pid));
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 200).unref();
${name === "watch" ? watchExit(root, options) : ""}
${name === "watch" ? watchStartup(root, options) : ""}
${
  name === "daemon"
    ? `import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
mkdirSync(${JSON.stringify(join(root, "host/run"))}, { recursive: true, mode: 0o700 });
createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ ok: true, result: { runs: ${JSON.stringify(options.statusRuns ?? [])}, next: null } }) + "\\n"))).listen(${JSON.stringify(join(root, "host/run/control.sock"))}).unref();
${announcement(root, options)}`
    : ""
}
const timer = setInterval(() => {}, 1000);
function stop(signal) {
  appendFileSync(${JSON.stringify(join(root, `${name}-signals`))}, signal + "\\n");
  if (${String(options.stuckPrograms?.includes(name) ?? false)}) return;
  setTimeout(() => {
  writeFileSync(${JSON.stringify(join(root, `${name}-stopped`))}, "stopped");
  clearInterval(timer);
  }, 50);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGUSR2", () => stop("SIGUSR2"));
writeFileSync(${JSON.stringify(join(root, `${name}-ready`))}, String(process.pid));
writeFileSync(${JSON.stringify(join(root, `${name}-runtime`))}, process.env.CLOVING_RUNTIME_DIR ?? "");
${
  name === "daemon" && options.daemonMilliseconds
    ? `const deadline = Date.now() + ${String(testMilliseconds(30_000))};
for (const ready of ${JSON.stringify((options.readyPrograms ?? ["watch"]).map((program) => join(root, `${program}-ready`)))}) {
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error("program-startup-timed-out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
setTimeout(() => process.emit("SIGTERM"), ${String(options.daemonMilliseconds)});`
    : ""
}
`;
  await writeFile(join(project, "start.mjs"), program("daemon"));
  await writeFile(join(product, "src/cli.ts"), program("watch"));
  await writeFile(join(product, "src/relay.ts"), program("relay"));
  return { product, project };
}

interface StalledCheck {
  readonly repository: string;
  readonly command: string;
  readonly signal: string;
}

export const networkDeadlineMilliseconds = 1000;

function shortNetworkDeadline(): string {
  return `import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const execute = promisify(childProcess.execFile);
function controlled() { throw new Error("unexpected-unpromisified-git"); }
Object.defineProperty(controlled, promisify.custom, {
  value: (file, argumentsList, options) => {
    const command = argumentsList[2];
    if (command === "fetch" || command === "remote") {
      assert.equal(options.timeout, 30000);
      return execute(file, argumentsList, { ...options, timeout: ${String(testMilliseconds(networkDeadlineMilliseconds))} });
    }
    if (command === "merge") assert.equal(options.timeout, undefined);
    return execute(file, argumentsList, options);
  },
});
childProcess.execFile = controlled;
syncBuiltinESMExports();
`;
}

export async function hostedWithDeadline(
  root: string,
  settings: HostProcesses,
) {
  const entry = join(root, "deadline-host.mjs");
  await writeFile(
    entry,
    `${shortNetworkDeadline()}
import { hostedPrograms } from ${JSON.stringify(pathToFileURL(resolve("tools/self-host-processes.ts")).href)};
process.exitCode = await hostedPrograms(${JSON.stringify(settings)});`,
  );
  return spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    timeout: testMilliseconds(10_000),
    killSignal: "SIGKILL",
  });
}

export async function stalledCheck(root: string, options: StalledCheck) {
  const timeFactor = parseCheckTimeFactor(
    process.env["CLOVING_CHECK_TIME_FACTOR"],
  );
  const paths = await programs(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "git");
  await writeFile(
    executable,
    options.command === "merge"
      ? interruptedMerge(root, options)
      : stalledGit(root, options),
  );
  await chmod(executable, 0o755);
  const entry = join(root, "host.mjs");
  await writeFile(
    entry,
    `${options.signal === "deadline" ? shortNetworkDeadline() : ""}
import { hostedPrograms } from ${JSON.stringify(pathToFileURL(resolve("tools/self-host-processes.ts")).href)};
const running = hostedPrograms(${JSON.stringify({ ...paths, repository: options.repository, runtime: join(root, "host/run"), directory: join(root, "host"), watchPort: "3663", phoneRelay: "on", updateMilliseconds: 10 })});
${
  options.command === "merge"
    ? `import { writeFileSync } from "node:fs";
process.once(${JSON.stringify(options.signal)}, () => writeFileSync(${JSON.stringify(join(root, "shutdown-observed"))}, "observed"));`
    : ""
}
process.exitCode = await running;`,
  );
  try {
    return spawnSync(process.execPath, [entry], {
      env: {
        ...process.env,
        NODE_V8_COVERAGE: undefined,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
      encoding: "utf8",
      timeout: (options.signal === "deadline" ? 35000 : 10000) * timeFactor,
      killSignal: "SIGKILL",
    });
  } finally {
    await stopFixturePrograms(root);
  }
}

function interruptedMerge(root: string, options: StalledCheck): string {
  return `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const argumentsList = process.argv.slice(2);
function merge() {
  const result = spawnSync("git", argumentsList, {
    env: { ...process.env, PATH: ${JSON.stringify(process.env["PATH"])} },
    stdio: "inherit",
  });
  if (argumentsList[2] === "merge" && result.status === 0)
    writeFileSync(${JSON.stringify(join(root, "merge-completed"))}, "completed");
  process.exit(result.status ?? 1);
}
if (argumentsList[2] === "merge") {
  writeFileSync(${JSON.stringify(join(root, "git-pid"))}, String(process.pid));
  process.kill(process.ppid, ${JSON.stringify(options.signal)});
  const deadline = Date.now() + ${String(testMilliseconds(5000))};
  while (!existsSync(${JSON.stringify(join(root, "shutdown-observed"))})) {
    if (Date.now() >= deadline) throw new Error("shutdown-not-observed");
    await delay(10);
  }
}
merge();
`;
}

const fixtureMarkers = [
  "git-pid",
  "daemon-ready",
  "watch-ready",
  "relay-ready",
];

export async function stopFixturePrograms(root: string): Promise<void> {
  for (const marker of fixtureMarkers) {
    const file = join(root, marker);
    if (!existsSync(file)) continue;
    const pid = Number(await readFile(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`invalid fixture PID: ${marker}`);
    try {
      process.kill(pid, "SIGKILL");
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

export function stalledGit(root: string, options: StalledCheck): string {
  return `#!${process.execPath}
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
if (process.argv[4] !== ${JSON.stringify(options.command)}) process.exit(0);
const root = ${JSON.stringify(root)};
if (${JSON.stringify(options.signal)} === "deadline" && existsSync(root + "/git-pid")) {
  process.kill(process.ppid, "SIGTERM");
  process.exit(0);
}
process.on("SIGTERM", () => {});
let notified = false;
setInterval(ready, 20);
const watcher = watch(root, ready);
function ready() {
  if (notified) return;
  if (!["daemon-ready", "watch-ready"].every(name => existsSync(root + "/" + name))) return;
  const daemon = Number(readFileSync(root + "/daemon-ready", "utf8"));
  const watch = Number(readFileSync(root + "/watch-ready", "utf8"));
  if (![daemon, watch].every(pid => Number.isSafeInteger(pid) && pid > 0)) return;
  notified = true;
  watcher.close();
  writeFileSync(root + "/git-pid", String(process.pid));
  if (${JSON.stringify(options.signal)} === "daemon")
    process.kill(daemon, "SIGTERM");
  else if (${JSON.stringify(options.signal)} !== "deadline")
    process.kill(process.ppid, ${JSON.stringify(options.signal)});
}
ready();
`;
}

export async function readyPrograms(root: string): Promise<readonly string[]> {
  return (await readdir(root))
    .filter((name) => name.endsWith("-ready"))
    .map((name) => name.replace(/-ready$/, ""))
    .sort();
}

export async function cancelledGit(options: {
  readonly command: string;
  readonly signal: string;
}): Promise<void> {
  await withUpdateRepository(async ({ root, repository, git, old }) => {
    const result = await stalledCheck(root, { repository, ...options });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["daemon", "watch"])
      assert.equal(
        await readFile(join(root, `${name}-stopped`), "utf8"),
        "stopped",
      );
    assert.equal(git(["rev-parse", "HEAD"]), old);
  });
}

export async function deadlineGit(command: string): Promise<void> {
  await withUpdateRepository(async ({ root, repository, git, old }) => {
    const result = await stalledCheck(root, {
      repository,
      command,
      signal: "deadline",
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(git(["rev-parse", "HEAD"]), old);
  });
}
