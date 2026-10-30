import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { SubmissionContract } from "../src/submission.ts";
import { scene, reached } from "./self-host-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

async function workflowFile(
  folder: string,
  entry: {
    readonly name: string;
    readonly fields: SubmissionContract["fields"];
  },
) {
  const { name, fields } = entry;
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, name + ".ts"),
    `export async function ${name}() { "use workflow"; return { kind: "blocked" }; }`,
  );
  await writeFile(
    join(folder, name + ".declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: name,
        queue: true,
        input: { maximumBytes: 4096, fields },
      },
    }),
  );
}

async function startOutput(
  fixture: Awaited<ReturnType<typeof scene>>,
  environment: Readonly<NodeJS.ProcessEnv> = {},
) {
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "start"], {
    cwd: fixture.repository,
    env: {
      ...process.env,
      CLOVING_RUNTIME_DIR: fixture.runtimeDirectory,
      CLOVING_WATCH_PORT: "off",
      CLOVING_PHONE_RELAY: "off",
      CLOVING_QUEUE_SECONDS: undefined,
      CLOVING_QUEUE_LANES: undefined,
      CLOVING_SELF_UPDATE_SECONDS: undefined,
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_CLAUDE_COMMAND: JSON.stringify([
        process.execPath,
        join(fixture.root, "fake-claude.mjs"),
      ]),
      ...environment,
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
        /Cloving runs|The daemon did not start/.test(output.text)
          ? true
          : undefined,
      ),
    );
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
  return output.text;
}

await test("CLV-228 start needs no ticket commands when a queue interval has no declared target", async () => {
  const fixture = await scene();
  for (const command of [undefined, "[]"]) {
    const output = await startOutput(fixture, {
      CLOVING_QUEUE_SECONDS: "10",
      CLOVING_TICKET_COMMAND: command,
      CLOVING_NEXT_COMMAND: command,
    });
    assert.match(output, /Cloving runs/);
    assert.doesNotMatch(output, /The daemon did not start/);
  }
});

await test("CLV-218 start prints the specific queue input refusal codes", async () => {
  const fixture = await scene();
  const folder = join(fixture.repository, ".cloving/workflows");
  await workflowFile(folder, { name: "missing", fields: {} });
  await workflowFile(folder, {
    name: "incomplete",
    fields: {
      ticket: { type: "ticket" },
      note: { type: "string" },
    },
  });
  const output = await startOutput(fixture);
  assert.match(output, /missing.ts: queue-needs-ticket-field/);
  assert.match(output, /incomplete.ts: queue-input-incomplete/);
});

await test("CLV-218 start stops for conflicting project and user queue workflows", async () => {
  const fixture = await scene();
  const fields: SubmissionContract["fields"] = { ticket: { type: "ticket" } };
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "projectQueue",
    fields,
  });
  await workflowFile(join(fixture.root, "config/cloving/workflows"), {
    name: "userQueue",
    fields,
  });
  const output = await startOutput(fixture);
  assert.match(output, /The daemon did not start: queue-workflow-conflict/);
  assert.doesNotMatch(output, /Cloving runs/);
});
