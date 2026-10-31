import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import { testMilliseconds } from "./test-timing.ts";

interface ProgramOptions {
  readonly daemonMilliseconds?: number;
  readonly watchStartupMilliseconds?: number;
  readonly readyPrograms?: readonly string[];
  readonly stuckPrograms?: readonly string[];
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
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const parent = process.ppid;
if (parent === 1) process.exit(0);
writeFileSync(${JSON.stringify(join(root, `${name}-started`))}, String(process.pid));
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 200).unref();
${name === "watch" ? `await new Promise(resolve => setTimeout(resolve, ${String(options.watchStartupMilliseconds ?? 0)}));` : ""}
${
  name === "daemon"
    ? `import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
mkdirSync(${JSON.stringify(join(root, "host/run"))}, { recursive: true, mode: 0o700 });
createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ ok: true, result: { runs: [], next: null } }) + "\\n"))).listen(${JSON.stringify(join(root, "host/run/control.sock"))}).unref();`
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
    `import { hostedPrograms } from ${JSON.stringify(pathToFileURL(resolve("tools/self-host-processes.ts")).href)};
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

function stalledGit(root: string, options: StalledCheck): string {
  return `#!${process.execPath}
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
if (process.argv[4] !== ${JSON.stringify(options.command)}) process.exit(0);
const root = ${JSON.stringify(root)};
if (${JSON.stringify(options.signal)} === "deadline" && existsSync(root + "/git-pid")) {
  process.kill(process.ppid, "SIGTERM");
  process.exit(0);
}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const watcher = watch(root, ready);
function ready() {
  if (!["daemon-ready", "watch-ready"].every(name => existsSync(root + "/" + name))) return;
  const daemon = Number(readFileSync(root + "/daemon-ready", "utf8"));
  const watch = Number(readFileSync(root + "/watch-ready", "utf8"));
  if (![daemon, watch].every(pid => Number.isSafeInteger(pid) && pid > 0)) return;
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
