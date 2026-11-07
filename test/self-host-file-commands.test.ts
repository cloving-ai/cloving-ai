import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { call } from "./service-fixture.ts";
import {
  ended,
  field,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

function writeInspectionWorkflow(repository: string): void {
  const folder = join(repository, ".cloving/workflows");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "inspect.ts"),
    `import { runCommand } from "cloving/workflows/steps/run-command";
export async function inspect() {
  "use workflow";
  await runCommand({ scope: { phase: "inspect", operation: "files", round: 1 }, name: "inspect", input: {} });
  return { kind: "handoff_requested" };
}`,
  );
  writeFileSync(
    join(folder, "inspect.declaration.json"),
    JSON.stringify({
      workflow: {
        workflowId: "inspect",
        effectLimit: 1,
        capabilities: ["command"],
        commands: ["inspect"],
        input: { maximumBytes: 64, fields: {} },
      },
      methods: { command: ["run:inspect"] },
    }),
  );
}

function configured(
  fixture: { readonly repository: string; readonly directory: string },
  setting: { readonly field: string; readonly value: string },
): void {
  const result = spawnSync(
    process.execPath,
    [entry, "config", "set", setting.field, setting.value],
    {
      cwd: fixture.repository,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(fixture.directory, "configuration"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function configuredFiles(
  fixture: { readonly repository: string; readonly directory: string },
  capture: string,
): void {
  configured(fixture, {
    field: "commands",
    value: JSON.stringify({
      inspect: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(capture)},JSON.stringify({seconds:process.env.CLOVING_COMMAND_SECONDS}))`,
      ],
    }),
  });
  configured(fixture, { field: "commandSeconds", value: "120" });
  configured(fixture, {
    field: "schedules",
    value: JSON.stringify({ inspect: { everySeconds: 3600, input: {} } }),
  });
}

await test("CLV-320 commands, commandSeconds and schedules from the private file reach the daemon, and the scheduled workflow runs its command", () =>
  withoutChildren(async () => {
    const fixture = await scene(undefined, entry);
    writeInspectionWorkflow(fixture.repository);
    const capture = join(fixture.root, "command-files.json");
    configuredFiles(fixture, capture);
    const daemon = await fixture.start({
      CLOVING_COMMANDS: undefined,
      CLOVING_COMMAND_SECONDS: undefined,
      CLOVING_SCHEDULES: undefined,
    });
    try {
      const status = await call(fixture, {
        operation: "status",
        parameters: {},
      });
      assert.deepEqual(
        (Array.isArray(status["schedules"]) ? status["schedules"] : []).map(
          (schedule: unknown) => field(schedule, "workflowId"),
        ),
        ["inspect"],
      );
      assert.equal(
        field(status["settingSources"], "commands"),
        "private",
        JSON.stringify(status["settingSources"]),
      );
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "inspect",
          source: "input",
          submission: {},
          commandId: "inspect-files",
        },
      });
      assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
      await reached(async () => {
        const shown = await call(fixture, {
          operation: "status",
          parameters: { runId: admitted["runId"] },
        });
        return field(shown["run"], "state") === "completed" ? true : undefined;
      });
      assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
        seconds: "120",
      });
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
