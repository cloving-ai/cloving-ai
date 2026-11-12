import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SubmissionContract } from "../src/submission.ts";
import { scene, reached, roomyQueue } from "./self-host-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";
import { record } from "../src/protocol.ts";
import type { QueueDeclaration } from "../src/workflow-declaration.ts";

export async function workflowFile(
  folder: string,
  entry: {
    readonly name: string;
    readonly fields: SubmissionContract["fields"];
    readonly queue?: boolean | QueueDeclaration;
  },
) {
  const { name, fields } = entry;
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, name + ".ts"),
    validCandidateSource.replaceAll("candidate", name),
  );
  await writeFile(
    join(folder, name + ".declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: name,
        queue: entry.queue ?? true,
        input: { maximumBytes: 4096, fields },
      },
    }),
  );
}

export async function startOutput(
  fixture: Awaited<ReturnType<typeof scene>>,
  options: {
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly inspect?: () => void | Promise<void>;
    readonly entry?: string;
  } = {},
) {
  const entry = options.entry ?? resolve("src/cli.ts");
  const child = spawn(process.execPath, [entry, "start"], {
    cwd: fixture.repository,
    env: {
      ...process.env,
      CLOVING_RUNTIME_DIR: fixture.runtimeDirectory,
      CLOVING_WATCH_PORT: "off",
      CLOVING_PHONE_RELAY: "off",
      CLOVING_QUEUE_SECONDS: undefined,
      CLOVING_QUEUE_LANES: undefined,
      CLOVING_QUEUE_WORKING_LANES: undefined,
      CLOVING_QUEUES: undefined,
      CLOVING_SELF_UPDATE_SECONDS: undefined,
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_CLAUDE_COMMAND: JSON.stringify([
        process.execPath,
        join(fixture.root, "fake-claude.mjs"),
      ]),
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output.text += chunk.toString();
    });
  const closed = new Promise<number | null>((settle, reject) => {
    child.once("error", reject);
    child.once("close", settle);
  });
  try {
    await reached(() =>
      Promise.resolve(
        child.exitCode !== null ||
          /Cloving runs|The daemon did not start/.test(output.text)
          ? true
          : undefined,
      ),
    );
    await options.inspect?.();
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
  return output.text;
}

export function registered(fixture: Awaited<ReturnType<typeof scene>>) {
  const status = spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "status", "--json"],
    {
      cwd: fixture.repository,
      env: { ...process.env, CLOVING_RUNTIME_DIR: fixture.runtimeDirectory },
      encoding: "utf8",
    },
  );
  assert.equal(status.status, 0, status.stdout + status.stderr);
  return record(JSON.parse(status.stdout))?.["workflows"];
}

export function cli(
  fixture: Awaited<ReturnType<typeof scene>>,
  argumentsList: readonly string[],
) {
  return spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), ...argumentsList],
    {
      cwd: fixture.repository,
      env: {
        ...process.env,
        CLOVING_RUNTIME_DIR: fixture.runtimeDirectory,
        XDG_CONFIG_HOME: join(fixture.root, "config"),
      },
      encoding: "utf8",
    },
  );
}

export function statusOf(fixture: Awaited<ReturnType<typeof scene>>) {
  const status = cli(fixture, ["status", "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  return record(JSON.parse(status.stdout)) ?? {};
}

export async function queueScene(declared: {
  readonly queue: boolean | QueueDeclaration;
}) {
  const fixture = await scene();
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "develop",
    fields: { ticket: { type: "ticket" } },
    queue: declared.queue,
  });
  await writeFile(
    join(fixture.root, "next.mjs"),
    'process.stdout.write("CLV-900");',
  );
  const environment = {
    CLOVING_TICKET_COMMAND: JSON.stringify([
      process.execPath,
      join(fixture.root, "fake-board.mjs"),
    ]),
    CLOVING_NEXT_COMMAND: JSON.stringify([
      process.execPath,
      join(fixture.root, "next.mjs"),
    ]),
    ...roomyQueue(join(fixture.root, "calm-host.mjs")),
  };
  return { fixture, environment };
}

export async function privateSettings(
  fixture: Awaited<ReturnType<typeof scene>>,
  settings: Readonly<Record<string, unknown>>,
) {
  const id = createHash("sha256")
    .update(fixture.repository)
    .digest("hex")
    .slice(0, 8);
  const folder = join(fixture.root, "config/cloving/projects");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, `repository-${id}.json`),
    JSON.stringify({ version: 1, ...settings }),
  );
}
