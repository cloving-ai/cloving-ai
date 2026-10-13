import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const productRoot = join(import.meta.dirname, "..");

export const hostModule = pathToFileURL(
  join(productRoot, "src/host/world-host.ts"),
).href;

export const prelude = `
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { getRun, start } from "workflow/api";
import { setWorld } from "workflow/runtime";
import * as workflows from "./artifacts/client.mjs";
import { POST } from "./artifacts/flow.mjs";
import { startHost } from ${JSON.stringify(hostModule)};
const dataDirectory = process.env.WORKFLOW_LOCAL_DATA_DIR;
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const worlds = () => ["cache", "stubbedCache", "cachePromise", "stubbedCachePromise"].filter((name) => globalThis[Symbol.for("@workflow/world//" + name)] !== undefined).length;
`;

export interface ChildResult {
  readonly status: number | null;
  readonly lines: readonly unknown[];
  readonly stderr: string;
}

export interface Consumer {
  readonly directory: string;
  readonly world: string;
  readonly run: (
    script: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ) => Promise<ChildResult>;
}

function child(
  argumentsList: readonly string[],
  options: {
    readonly directory: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const started = spawn(process.execPath, argumentsList, {
      cwd: options.directory,
      env: { ...process.env, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    const output = { stdout: "", stderr: "" };
    started.stdout.on("data", (chunk: Buffer) => {
      output.stdout += chunk.toString();
    });
    started.stderr.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
    });
    started.on("error", reject);
    started.on("close", (status) => {
      resolve({
        status,
        stderr: output.stderr,
        lines: output.stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line): unknown => JSON.parse(line)),
      });
    });
  });
}

export async function withConsumer<Result>(
  workflow: string,
  use: (consumer: Consumer) => Promise<Result>,
): Promise<Result> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-host-")),
  );
  const world = join(directory, "world");
  try {
    await mkdir(join(directory, "workflows"));
    await writeFile(
      join(directory, "package.json"),
      '{"name":"host-consumer","private":true,"type":"module"}',
    );
    await writeFile(join(directory, "workflows/develop.ts"), workflow);
    await symlink(
      join(productRoot, "node_modules"),
      join(directory, "node_modules"),
    );
    const compiled = await child(
      [
        join(productRoot, "tools/compile-workflows.ts"),
        "workflows",
        "artifacts",
      ],
      { directory, environment: {} },
    );
    if (compiled.status !== 0)
      throw new Error(
        `The fixture workflow did not compile: ${compiled.stderr}`,
      );
    return await use({
      directory,
      world,
      run: async (script, environment = {}) => {
        await writeFile(join(directory, "scenario.mjs"), prelude + script);
        return await child(["scenario.mjs"], {
          directory,
          environment: {
            WORKFLOW_TARGET_WORLD: "local",
            WORKFLOW_LOCAL_DATA_DIR: world,
            WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:1",
            WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "1",
            ...environment,
          },
        });
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
