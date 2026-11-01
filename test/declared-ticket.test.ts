import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  ticketRegistrationTable,
  type TicketSource,
} from "../src/daemon/ticket-registration.ts";
import type { DeclaredWorkflow } from "../src/workflow-declaration.ts";
import { queryDatabase } from "./authority-store-fixture.ts";
import {
  call,
  field,
  parsed,
  text,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const declaration: DeclaredWorkflow = {
  workflowId: "project-develop",
  functionName: "develop",
  effectLimit: 1,
  capabilities: ["claude"],
  input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
};
const command = [
  process.execPath,
  "-e",
  'process.stdout.write("# Ticket " + process.argv[1])',
];

function workflows(
  harness: Harness,
  options: {
    readonly source?: Partial<TicketSource>;
    readonly declarations?: readonly DeclaredWorkflow[];
  } = {},
) {
  return ticketRegistrationTable(
    { repository: harness.projectDirectory, command, ...options.source },
    options.declarations ?? [declaration],
  ).map((row) => ({ ...harness.registration, ...row }));
}

function submit(
  harness: Harness,
  request: { readonly commandId: string; readonly submission?: unknown },
) {
  return call(harness, {
    operation: "run",
    parameters: {
      workflowId: declaration.workflowId,
      commandId: request.commandId,
      source: "input",
      submission: request.submission ?? { ticket: "312" },
    },
  });
}

function storedInput(harness: Harness, admitted: unknown): unknown {
  const digest = text(field(admitted, "binding"), "executionInputDigest");
  const rows = queryDatabase(
    harness.stateDirectory,
    "SELECT digest, body FROM documents",
  );
  return JSON.parse(
    text(
      rows.find((row) => field(row, "digest") === digest),
      "body",
    ),
  );
}

await test("CLV-217 declared ticket admission stores ticket text and replays without reading the source", () =>
  withHarness(async (harness) => {
    const service = await harness.start({ workflows: workflows(harness) });
    const result = await harness.cli([
      "run",
      declaration.workflowId,
      "--ticket",
      "312",
      "--command-id",
      "ticket",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const admitted = parsed(result);
    assert.equal(field(admitted, "kind"), "run-admitted");
    await service.close();
    assert.partialDeepStrictEqual(storedInput(harness, admitted), {
      repository: harness.projectDirectory,
      input: { ticket: { id: "312", text: "# Ticket 312" } },
    });
    const restarted = await harness.start({
      workflows: workflows(harness, { source: { command: undefined } }),
    });
    const replay = await submit(harness, { commandId: "ticket" });
    assert.equal(replay["replayed"], true);
    assert.deepEqual(replay["binding"], field(admitted, "binding"));
    await restarted.close();
  }));

await test("CLV-217 declared next selects a ticket through the next command", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: workflows(harness, {
        source: {
          nextCommand: [process.execPath, "-e", 'process.stdout.write("313")'],
        },
      }),
    });
    const result = await harness.cli([
      "run",
      declaration.workflowId,
      "--next",
      "--command-id",
      "next",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    await service.close();
    assert.partialDeepStrictEqual(storedInput(harness, parsed(result)), {
      input: { ticket: { id: "313", text: "# Ticket 313" } },
    });
  }));

await test("CLV-217 declared tickets preserve source and selection refusal codes", () =>
  withHarness(async (harness) => {
    for (const [source, ticket, code] of [
      [{ command: undefined }, "312", "ticket-source-not-configured"],
      [
        { command: [process.execPath, "-e", "process.exit(1)"] },
        "312",
        "ticket-not-available",
      ],
      [{}, "bad id", "invalid-ticket-id"],
      [{}, "next", "next-source-not-configured"],
      [
        { nextCommand: [process.execPath, "-e", 'process.stdout.write("")'] },
        "next",
        "no-ready-ticket",
      ],
    ] as const) {
      const service = await harness.start({
        workflows: workflows(harness, { source }),
      });
      assert.equal(
        (await submit(harness, { commandId: code, submission: { ticket } }))[
          "code"
        ],
        code,
      );
      await service.close();
    }
  }));

await test("CLV-217 declared tickets refuse open dependencies and admit closed dependencies", () =>
  withHarness(async (harness) => {
    const source = {
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("GitHub issue: example/project#312\\n## Dependencies\\nNeeds #12.")',
      ],
    };
    for (const [state, property, expected] of [
      ["open", "code", "ticket-dependency-open"],
      ["closed", "kind", "run-admitted"],
    ] as const) {
      const service = await harness.start({
        workflows: workflows(harness, {
          source: {
            ...source,
            githubCommand: [
              process.execPath,
              "-e",
              `process.stdout.write(JSON.stringify({state: ${JSON.stringify(state)}}))`,
              "--",
            ],
          },
        }),
      });
      const result = await submit(harness, { commandId: state });
      assert.equal(result[property], expected);
      await service.close();
    }
  }));

await test("CLV-217 a second required field needs complete input and retains its value", () =>
  withHarness(async (harness) => {
    const complete = {
      ...declaration,
      input: {
        ...declaration.input,
        fields: {
          ...declaration.input.fields,
          rounds: { type: "integer" as const },
        },
      },
    };
    const service = await harness.start({
      workflows: workflows(harness, { declarations: [complete] }),
    });
    const refused = await harness.cli([
      "run",
      declaration.workflowId,
      "--ticket",
      "312",
      "--json",
    ]);
    assert.equal(refused.status, 1);
    assert.equal(field(parsed(refused), "code"), "invalid-submission");
    const file = join(harness.projectDirectory, "ticket.json");
    await writeFile(file, JSON.stringify({ ticket: "312", rounds: 2 }));
    const result = await harness.cli([
      "run",
      declaration.workflowId,
      "--input",
      file,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    await service.close();
    assert.partialDeepStrictEqual(storedInput(harness, parsed(result)), {
      input: { ticket: { id: "312", text: "# Ticket 312" }, rounds: 2 },
    });
  }));

await test("CLV-217 simultaneous submissions admit one ticket per workflow and keep workflows independent", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: workflows(harness, {
        declarations: [
          declaration,
          { ...declaration, workflowId: "other-develop" },
        ],
      }),
    });
    const results = await Promise.all([
      submit(harness, { commandId: "first" }),
      submit(harness, { commandId: "second" }),
    ]);
    assert.deepEqual(
      results.map((result) => result["code"] ?? result["kind"]).sort(),
      ["run-admitted", "ticket-active"],
    );
    const other = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "other-develop",
        commandId: "other",
        submission: { ticket: "312" },
      },
    });
    assert.equal(other["kind"], "run-admitted");
    await service.close();
  }));

await test("CLV-217 declared next excludes active tickets and refuses ticket aliases", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: workflows(harness, {
        source: {
          command: [
            process.execPath,
            "-e",
            'process.stdout.write("GitHub issue: example/project#312")',
          ],
          nextCommand: [
            process.execPath,
            "-e",
            'process.stdout.write(process.env.CLOVING_SKIP_TICKETS === "312" ? "313" : "bad id")',
          ],
        },
      }),
    });
    assert.equal(
      (await submit(harness, { commandId: "initial" }))["kind"],
      "run-admitted",
    );
    assert.equal(
      (
        await submit(harness, {
          commandId: "next-alias",
          submission: { ticket: "next" },
        })
      )["code"],
      "ticket-active",
    );
    await service.close();
  }));
