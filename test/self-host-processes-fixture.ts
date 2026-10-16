import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function programs(
  root: string,
  options: { readonly daemonMilliseconds?: number } = {},
): Promise<{ readonly product: string; readonly project: string }> {
  const product = join(root, "product");
  const project = join(root, "project");
  await mkdir(join(product, "src"), { recursive: true });
  await mkdir(project);
  const program = (name: string): string => `
import { writeFileSync } from "node:fs";
const timer = setInterval(() => {}, 1000);
process.on("SIGINT", () => process.emit("SIGTERM"));
process.on("SIGTERM", () => setTimeout(() => {
  writeFileSync(${JSON.stringify(join(root, `${name}-stopped`))}, "stopped");
  clearInterval(timer);
}, 50));
writeFileSync(${JSON.stringify(join(root, `${name}-ready`))}, String(process.pid));
${name === "daemon" && options.daemonMilliseconds ? `setTimeout(() => process.emit("SIGTERM"), ${String(options.daemonMilliseconds)});` : ""}
`;
  await writeFile(join(project, "start.mjs"), program("daemon"));
  await writeFile(join(product, "src/cli.ts"), program("watch"));
  return { product, project };
}

interface StalledCheck {
  readonly repository: string;
  readonly command: string;
  readonly signal: string;
}

export async function stalledCheck(root: string, options: StalledCheck) {
  const paths = await programs(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "git");
  await writeFile(executable, stalledGit(root, options));
  await chmod(executable, 0o755);
  const entry = join(root, "host.mjs");
  await writeFile(
    entry,
    `import { hostedPrograms } from ${JSON.stringify(pathToFileURL(resolve("tools/self-host-processes.ts")).href)};
const status = await hostedPrograms(${JSON.stringify({ ...paths, repository: options.repository, runtime: join(root, "host/run"), directory: join(root, "host"), watchPort: "3663", updateMilliseconds: 10 })});
process.exitCode = status;`,
  );
  try {
    return spawnSync(process.execPath, [entry], {
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      encoding: "utf8",
      timeout: options.signal === "deadline" ? 35000 : 3000,
      killSignal: "SIGKILL",
    });
  } finally {
    await cleanedProcesses(root);
  }
}

async function cleanedProcesses(root: string): Promise<void> {
  for (const marker of ["git-pid", "daemon-ready", "watch-ready"]) {
    const pid = Number(await readFile(join(root, marker), "utf8"));
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
