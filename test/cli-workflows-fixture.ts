import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { join, resolve } from "node:path";
import { testMilliseconds } from "./test-timing.ts";

export const entry = resolve("src/cli.ts");

export function cli(
  root: string,
  invocation: {
    readonly args: readonly string[];
    readonly entry?: string;
    readonly directory?: string;
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  return spawnSync(
    process.execPath,
    [invocation.entry ?? entry, "workflows", ...invocation.args],
    cliOptions(root, invocation),
  );
}

export function cliOptions(
  root: string,
  invocation: {
    readonly directory?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): SpawnSyncOptionsWithStringEncoding {
  return {
    cwd: invocation.directory ?? join(root, "repo"),
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      CLOVING_RUNTIME_DIR: join(root, "service/run"),
      ...invocation.environment,
    },
    encoding: "utf8",
    timeout: testMilliseconds(30000),
  };
}
