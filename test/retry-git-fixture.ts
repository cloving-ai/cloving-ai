import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type Scene } from "./claude-worker-fixture.ts";

export function origin(scene: Scene): void {
  const remote = join(scene.directory, "origin");
  mkdirSync(remote);
  git(remote, ["init", "--bare", "--quiet"]);
  git(scene.repository, ["remote", "add", "origin", remote]);
}

export function stopGit(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
  }
}

export async function withBlockedGit(
  command: string,
  use: (blocked: () => number | undefined) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "cloving-git-"));
  const log = join(directory, "blocked");
  const executable = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  const previous = process.env["PATH"];
  writeFileSync(
    join(directory, "git"),
    `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const parts = process.argv.slice(2);
const command = ${JSON.stringify(command)};
const blocked = command === "head" ? parts.includes("--verify") && parts.includes("HEAD") : parts.includes(command);
if (blocked) {
  writeFileSync(${JSON.stringify(log)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.exitCode = spawnSync(${JSON.stringify(executable)}, parts, { stdio: "inherit" }).status ?? 1;
}
`,
    { mode: 0o700 },
  );
  const blocked = (): number | undefined => {
    const pid = existsSync(log) ? Number(readFileSync(log, "utf8")) : 0;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  };
  process.env["PATH"] = `${directory}:${previous ?? ""}`;
  try {
    await use(blocked);
  } finally {
    stopGit(blocked());
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function withGitDeadline(
  use: (clock: {
    readonly duration: () => number;
    readonly expire: () => void;
  }) => Promise<void>,
): Promise<void> {
  const schedule = globalThis.setTimeout;
  let duration = 0;
  let expire: () => void = () => {
    throw new Error("git-deadline-not-scheduled");
  };
  const replacement = (callback: () => void, milliseconds: number) => {
    if (milliseconds === 30_000) {
      duration = milliseconds;
      expire = callback;
    }
    return schedule(callback, milliseconds);
  };
  Object.defineProperty(globalThis, "setTimeout", { value: replacement });
  try {
    await use({
      duration: () => duration,
      expire: () => {
        expire();
      },
    });
  } finally {
    Object.defineProperty(globalThis, "setTimeout", { value: schedule });
  }
}
