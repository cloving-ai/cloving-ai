import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { settingsScene } from "./project-settings-fixture.ts";

export function configScene() {
  const fixture = settingsScene();
  execFileSync("git", ["init", "--quiet", fixture.repository]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("CLOVING_"),
    ),
  );
  const run = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../src/cli.ts"), "config", ...args],
      {
        cwd: fixture.repository,
        env: { ...environment, ...fixture.environment, ...extra },
        encoding: "utf8",
        timeout: 15000,
      },
    );
  return {
    ...fixture,
    [Symbol.dispose]: () => {
      rmSync(fixture.root, { recursive: true, force: true });
    },
    run,
    start: (args: readonly string[]) =>
      startConfig(args, {
        repository: fixture.repository,
        environment: { ...environment, ...fixture.environment },
      }),
    read: (path: string): unknown => JSON.parse(readFileSync(path, "utf8")),
    close: () => {
      rmSync(fixture.root, { recursive: true, force: true });
    },
  };
}

function startConfig(
  args: readonly string[],
  context: {
    readonly repository: string;
    readonly environment: NodeJS.ProcessEnv;
  },
) {
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "../src/cli.ts"), "config", ...args],
    {
      cwd: context.repository,
      env: context.environment,
    },
  );
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const ended = new Promise<{ status: number | null; output: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => {
        resolve({ status, output });
      });
    },
  );
  return {
    child,
    ended,
    [Symbol.asyncDispose]: async () => {
      child.kill("SIGKILL");
      await ended;
    },
  };
}
