import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { declaredResolver } from "../src/daemon/ticket-registration.ts";
import { ticketLimits, ticketText } from "../src/daemon/ticket-source.ts";

const board = `
const [mode, ticket] = process.argv.slice(2);
if (ticket === "CLV-404") { process.stderr.write("Error: no task has the key CLV-404\\n"); process.exit(3); }
if (ticket === "CLV-BIG") process.stdout.write("x".repeat(Number(mode)));
if (ticket === "CLV-EMPTY") process.stdout.write(" \\n");
if (ticket === "CLV-SLOW") await new Promise((settle) => setTimeout(settle, 30000));
if (ticket === "CLV-016") process.stdout.write("# CLV-016: Connect the board\\n\\nThe text of the ticket.\\n");
`;

const directory = mkdtempSync(join(tmpdir(), "cloving-ticket-"));
process.on("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});
writeFileSync(join(directory, "board.mjs"), board);
const command = [
  process.execPath,
  join(directory, "board.mjs"),
  String(ticketLimits.textBytes + 1),
];
const ticketContract = {
  maximumBytes: 4096,
  fields: { ticket: { type: "ticket" as const } },
};
const open = new AbortController().signal;

function request(submission: Readonly<Record<string, unknown>>): {
  readonly workflowId: string;
  readonly submission: Readonly<Record<string, unknown>>;
  readonly commandId: string;
  readonly signal: AbortSignal;
} {
  return {
    workflowId: "project-develop",
    submission,
    commandId: "c-1",
    signal: open,
  };
}

await test("CLV-016 the ticket source runs the configured command with the ticket ID as its last argument and gives the printed text", async () => {
  assert.deepEqual(
    await ticketText(command, { ticketId: "CLV-016", signal: open }),
    {
      kind: "read",
      text: "# CLV-016: Connect the board\n\nThe text of the ticket.",
    },
  );
});

await test("CLV-016 the ticket source gives a failure for a command that fails, prints no text, prints too much text, does not start or is stopped", async () => {
  const failure = async (
    given: readonly string[],
    ticketId: string,
  ): Promise<unknown> => ticketText(given, { ticketId, signal: open });
  assert.deepEqual(await failure(command, "CLV-404"), {
    kind: "failed",
    detail:
      "The ticket command ended with the code 3: Error: no task has the key CLV-404",
  });
  assert.deepEqual(await failure(command, "CLV-EMPTY"), {
    kind: "failed",
    detail: "The ticket command printed no text.",
  });
  assert.deepEqual(await failure(command, "CLV-BIG"), {
    kind: "failed",
    detail: `The ticket text has more than ${String(ticketLimits.textBytes)} bytes.`,
  });
  assert.partialDeepStrictEqual(
    await failure([join(directory, "absent-command")], "CLV-016"),
    { kind: "failed" },
  );
  const stopping = new AbortController();
  const stopped = ticketText(command, {
    ticketId: "CLV-SLOW",
    signal: stopping.signal,
  });
  stopping.abort();
  assert.partialDeepStrictEqual(await stopped, { kind: "failed" });
});

await test("CLV-070 the declared ticket resolver selects the next ID without adding arguments and resolves its ticket", async () => {
  const source = {
    repository: "/repository",
    command,
    nextCommand: [
      process.execPath,
      "-e",
      'if (process.argv.length !== 1) process.exit(2); process.stdout.write("  CLV-016\\n");',
    ],
  };
  const resolver = declaredResolver(source, ticketContract);
  const direct = await resolver.resolve(request({ ticket: "CLV-016" }));
  assert.equal(direct.kind, "resolved");
  assert.deepEqual(await resolver.resolve(request({ ticket: "next" })), direct);
});

const selections = [
  { name: "empty output", script: "", code: "no-ready-ticket" },
  { name: "whitespace", script: 'console.log("  ")', code: "no-ready-ticket" },
  {
    name: "failure",
    script: 'console.error("board unavailable"); process.exit(3)',
    code: "next-ticket-not-available",
    detail: "The ticket command ended with the code 3: board unavailable",
  },
  {
    name: "invalid ID",
    script: 'console.log("CLV 016")',
    code: "invalid-ticket-id",
  },
  {
    name: "multiple IDs",
    script: 'console.log("CLV-016\\nCLV-017")',
    code: "invalid-ticket-id",
  },
  {
    name: "oversized ID",
    script: 'console.log("x".repeat(65))',
    code: "invalid-ticket-id",
  },
  {
    name: "reserved ID",
    script: 'console.log("next")',
    code: "invalid-ticket-id",
  },
  {
    name: "missing command",
    script: undefined,
    code: "next-source-not-configured",
  },
] as const;

for (const selection of selections)
  await test(`CLV-070 the declared ticket resolver rejects next selection with ${selection.name}`, async () => {
    const source = {
      repository: "/repository",
      command: [
        process.execPath,
        "-e",
        'throw new Error("The ticket command must not run")',
      ],
      nextCommand:
        selection.script === undefined
          ? undefined
          : [process.execPath, "-e", selection.script],
    };
    const result = await declaredResolver(source, ticketContract).resolve(
      request({ ticket: "next" }),
    );
    assert.partialDeepStrictEqual(result, {
      kind: "rejected",
      code: selection.code,
      ...("detail" in selection ? { detail: selection.detail } : {}),
    });
  });
