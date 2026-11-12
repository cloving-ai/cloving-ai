import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { RestartMark } from "../src/restart-request.ts";
import { restartSettings } from "../tools/restart-settings.ts";
import { settingsScene } from "./project-settings-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";

const mark: RestartMark = {
  at: "keep",
  requestedAt: 1,
  commandId: "restart-queue",
  resumeQueue: false,
};

await test("CLV-352 restart validation refuses an unsupported worker and names the changed harness setting", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: fixture.environment,
      fileVariables: [],
    });
    const refusal = await validate({
      ...mark,
      variables: { CLOVING_QUEUE_SECONDS: "60", CLOVING_WORKER: "my-tool" },
    });
    assert.equal(refusal?.key, "harness.name");
    assert.match(refusal.detail, /harness-no-worker: my-tool/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation refuses a declared queue without a next-ticket command", async () => {
  const fixture = settingsScene();
  try {
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    for (const command of [undefined, "[]"]) {
      const validate = restartSettings({
        repository: fixture.repository,
        environment: { ...fixture.environment, CLOVING_NEXT_COMMAND: command },
        fileVariables: [],
      });
      const refusal = await validate({
        ...mark,
        variables: { CLOVING_QUEUE_SECONDS: "60" },
      });
      assert.equal(refusal?.key, "queue.everySeconds");
      assert.match(refusal.detail, /queue-needs-next-command/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation refuses a declared queue without a ticket command", async () => {
  const fixture = settingsScene();
  try {
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    for (const command of [undefined, "[]"]) {
      const validate = restartSettings({
        repository: fixture.repository,
        environment: {
          ...fixture.environment,
          CLOVING_NEXT_COMMAND: '["false"]',
          CLOVING_TICKET_COMMAND: command,
        },
        fileVariables: [],
      });
      const refusal = await validate({
        ...mark,
        variables: { CLOVING_QUEUE_SECONDS: "60" },
      });
      assert.equal(refusal?.key, "queue.everySeconds");
      assert.match(refusal.detail, /queue-needs-ticket-command/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation names an empty ticket command even when another queue setting changes", async () => {
  const fixture = settingsScene();
  try {
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_QUEUE_SECONDS: "60",
        CLOVING_NEXT_COMMAND: '["false"]',
        CLOVING_TICKET_COMMAND: '["tickets"]',
      },
      fileVariables: [],
    });
    for (const [variable, key, detail] of [
      [
        "CLOVING_NEXT_COMMAND",
        "tickets.nextCommand",
        "queue-needs-next-command",
      ],
      [
        "CLOVING_TICKET_COMMAND",
        "tickets.command",
        "queue-needs-ticket-command",
      ],
    ]) {
      const refusal = await validate({
        ...mark,
        variables: { CLOVING_QUEUE_LANES: "8", [String(variable)]: "[]" },
      });
      assert.equal(refusal?.key, key);
      assert.match(String(refusal?.detail), new RegExp(String(detail)));
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation refuses self-update outside the product repository", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: fixture.environment,
      fileVariables: [],
    });
    const refusal = await validate({
      ...mark,
      variables: { CLOVING_SELF_UPDATE_SECONDS: "60" },
    });
    assert.equal(refusal?.key, "selfUpdate.everySeconds");
    assert.match(refusal.detail, /self-update-needs-own-repository/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation permits self-update in the product source repository", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: join(import.meta.dirname, ".."),
      environment: fixture.environment,
      fileVariables: [],
    });
    assert.equal(
      await validate({
        ...mark,
        variables: { CLOVING_SELF_UPDATE_SECONDS: "60" },
      }),
      undefined,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation permits native workers and a configured custom worker", async () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.privateFile, {
      version: 1,
      harness: {
        name: "my-tool",
        turn: ["my-tool", "{prompt}"],
        output: "text",
      },
    });
    const validate = restartSettings({
      repository: fixture.repository,
      environment: fixture.environment,
      fileVariables: [],
    });
    for (const worker of ["claude", "codex", "my-tool"])
      assert.equal(
        await validate({ ...mark, variables: { CLOVING_WORKER: worker } }),
        undefined,
      );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation requires ticket commands only for an enabled declared queue", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: fixture.environment,
      fileVariables: [],
    });
    assert.equal(
      await validate({ ...mark, variables: { CLOVING_QUEUE_SECONDS: "60" } }),
      undefined,
    );
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    assert.equal(await validate(mark), undefined);
    assert.equal(
      await validate({
        ...mark,
        variables: {
          CLOVING_QUEUE_SECONDS: "60",
          CLOVING_NEXT_COMMAND: '["false"]',
          CLOVING_TICKET_COMMAND: '["tickets"]',
        },
      }),
      undefined,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation checks the set workflow folder after file settings remove start commands", async () => {
  const fixture = settingsScene();
  try {
    const folder = join(fixture.root, "other-workflows");
    await writeQueueWorkflow(folder);
    fixture.write(fixture.project, { version: 1, queue: { everySeconds: 60 } });
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_NEXT_COMMAND: '["false"]',
        CLOVING_TICKET_COMMAND: '["tickets"]',
      },
      fileVariables: [],
    });
    const variables = { CLOVING_WORKFLOW_FOLDER: folder };
    assert.equal(await validate({ ...mark, variables }), undefined);
    const refusal = await validate({ ...mark, settings: "files", variables });
    assert.equal(refusal?.key, "workflows.folder");
    assert.match(refusal.detail, /queue-needs-next-command/);
    assert.equal(
      await validate({
        ...mark,
        settings: "files",
        variables: {
          ...variables,
          CLOVING_NEXT_COMMAND: '["false"]',
          CLOVING_TICKET_COMMAND: '["tickets"]',
        },
      }),
      undefined,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 a combined queue refusal names working lanes when both lane settings change", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_QUEUE_LANES: "8",
        CLOVING_QUEUE_WORKING_LANES: "8",
      },
      fileVariables: [],
    });
    const refusal = await validate({
      ...mark,
      variables: { CLOVING_QUEUE_LANES: "8", CLOVING_QUEUE_WORKING_LANES: "9" },
    });
    assert.equal(refusal?.key, "queue.workingLanes");
    assert.match(refusal.detail, /invalid-queue-working-lanes/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation reads current files without treating file-injected variables as start overrides", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_QUEUE_LANES: "8",
        CLOVING_QUEUE_WORKING_LANES: "8",
      },
      fileVariables: ["CLOVING_QUEUE_LANES", "CLOVING_QUEUE_WORKING_LANES"],
    });
    fixture.write(fixture.project, {
      version: 1,
      queue: { everySeconds: 10, lanes: 4, workingLanes: 3 },
    });
    assert.equal(await validate(mark), undefined);
    fixture.write(fixture.privateFile, {
      version: 1,
      queue: { workingLanes: 5 },
    });
    assert.match(
      String((await validate(mark))?.detail),
      /invalid-queue-working-lanes/,
    );
    assert.equal(
      await validate({ ...mark, variables: { CLOVING_QUEUE_LANES: "6" } }),
      undefined,
    );
    assert.equal(
      await validate({
        ...mark,
        settings: "files",
        variables: { CLOVING_QUEUE_LANES: "6" },
      }),
      undefined,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-359 restart validation names queues when its working lanes exceed the declared lanes", async () => {
  const fixture = settingsScene();
  try {
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_NEXT_COMMAND: '["false"]',
        CLOVING_TICKET_COMMAND: '["tickets"]',
      },
      fileVariables: [],
    });
    const refusal = await validate({
      ...mark,
      variables: {
        CLOVING_QUEUES: '{"queued":{"workingLanes":2}}',
      },
    });
    assert.match(String(refusal?.detail), /invalid-queue-working-lanes/);
    assert.equal(refusal?.key, "queues");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
