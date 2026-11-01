import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { SubmissionContract } from "../src/submission.ts";
import { scene, reached } from "./self-host-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";
import { record } from "../src/protocol.ts";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";

async function workflowFile(
  folder: string,
  entry: {
    readonly name: string;
    readonly fields: SubmissionContract["fields"];
    readonly queue?: boolean;
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

async function startOutput(
  fixture: Awaited<ReturnType<typeof scene>>,
  options: {
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly inspect?: () => void;
  } = {},
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
    options.inspect?.();
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
  return output.text;
}

function registered(fixture: Awaited<ReturnType<typeof scene>>) {
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

await test("CLV-262 start with no project or user workflow registers nothing and guides initialization", async () => {
  const fixture = await scene();
  const output = await startOutput(fixture, {
    inspect: () => {
      assert.deepEqual(registered(fixture), []);
    },
  });
  assert.match(output, /Cloving runs/);
  assert.match(output, /No workflow\. Run: cloving init/);
  assert.doesNotMatch(output, /run develop-(ticket|issue|prompt|prd)/);
});

await test("CLV-262 start registers a template under a formerly bundled ID and guides its ticket command", async () => {
  const fixture = await scene();
  const declaration = await writeDeclaredWorkflow(fixture.repository);
  await writeFile(
    join(fixture.repository, ".cloving/workflows/develop.declaration.json"),
    JSON.stringify({
      ...declaration,
      workflow: { ...declaration.workflow, workflowId: "develop-issue" },
    }),
  );
  const output = await startOutput(fixture, {
    inspect: () => {
      assert.deepEqual(registered(fixture), ["develop-issue"]);
    },
  });
  assert.match(output, /Cloving runs/);
  assert.doesNotMatch(output, /Refused workflow|bundled-name-reserved/);
  assert.match(output, /run develop-issue --ticket <ticket-id>/);
  assert.doesNotMatch(output, /run develop-(ticket|prompt|prd)/);
});

await test("CLV-262 start guides project and user workflows with their declared inputs", async () => {
  const fixture = await scene();
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "report",
    fields: { rounds: { type: "integer" } },
    queue: false,
  });
  await workflowFile(join(fixture.root, "config/cloving/workflows"), {
    name: "notes",
    fields: { prompt: { type: "string" } },
    queue: false,
  });
  const output = await startOutput(fixture, {
    inspect: () => {
      assert.deepEqual(registered(fixture), ["report", "notes"]);
    },
  });
  assert.match(output, /run report --input <json-file>/);
  assert.match(output, /run notes --prompt "<text>"/);
  assert.doesNotMatch(
    output,
    /No workflow|run develop-(ticket|issue|prompt|prd)/,
  );
});

await test("CLV-228 start needs no ticket commands when a queue interval has no declared target", async () => {
  const fixture = await scene();
  for (const command of [undefined, "[]"]) {
    const output = await startOutput(fixture, {
      environment: {
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_TICKET_COMMAND: command,
        CLOVING_NEXT_COMMAND: command,
      },
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
