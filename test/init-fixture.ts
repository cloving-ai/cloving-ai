import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { DoctorScene } from "./doctor-fixture.ts";

export function initCli(
  scene: DoctorScene,
  options: {
    readonly arguments?: readonly string[];
    readonly directory?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) {
  return spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "init", ...(options.arguments ?? [])],
    {
      cwd: options.directory ?? scene.repository,
      env: { ...scene.environment, ...options.environment },
      encoding: "utf8",
      timeout: 15000,
    },
  );
}
