import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  issueResolver,
  promptResolver,
  ticketResolver,
} from "../src/daemon/ticket-registration.ts";
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
const open = new AbortController().signal;

function request(submission: Readonly<Record<string, unknown>>): {
  readonly workflowId: string;
  readonly submission: Readonly<Record<string, unknown>>;
  readonly commandId: string;
  readonly signal: AbortSignal;
} {
  return {
    workflowId: "develop-ticket",
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

await test("CLV-016 the ticket resolver gives the workflow the ticket ID, the ticket text and a cycle ID with the ticket ID, and it refuses an ID that is no identifier, a ticket that the command does not give, and a daemon with no ticket command", async () => {
  const resolver = ticketResolver({ command, repository: "/repository" });
  assert.deepEqual(await resolver.resolve(request({ ticket: "CLV-016" })), {
    kind: "resolved",
    input: {
      cycleId: "clv-016-a6f7ef47",
      ticketId: "CLV-016",
      ticket: "# CLV-016: Connect the board\n\nThe text of the ticket.",
      repository: "/repository",
    },
  });
  assert.deepEqual(await resolver.resolve(request({ ticket: "CLV 016; rm" })), {
    kind: "rejected",
    code: "invalid-ticket-id",
    detail: "A ticket ID has letters, digits and the characters . _ : - only.",
  });
  assert.deepEqual(await resolver.resolve(request({ ticket: "CLV-404" })), {
    kind: "rejected",
    code: "ticket-not-available",
    detail:
      "The ticket command ended with the code 3: Error: no task has the key CLV-404",
  });
  assert.deepEqual(
    await ticketResolver({
      command: undefined,
      repository: "/repository",
    }).resolve(request({ ticket: "CLV-016" })),
    {
      kind: "rejected",
      code: "ticket-source-not-configured",
      detail:
        "The daemon has no ticket command. Set CLOVING_TICKET_COMMAND, or use the workflow develop-prompt.",
    },
  );
  assert.deepEqual(
    [resolver.id, promptResolver("/repository").id],
    ["ticket-command", "ticket-prompt"],
  );
});

await test("CLV-016 the prompt resolver gives the workflow the prompt as the ticket text", async () => {
  assert.deepEqual(
    await promptResolver("/repository").resolve(
      request({ prompt: "Add the file." }),
    ),
    {
      kind: "resolved",
      input: {
        cycleId: "task-a6f7ef47ee8d",
        ticket: "Add the file.",
        repository: "/repository",
      },
    },
  );
});

await test("CLV-063 the issue resolver gives the workflow the ticket of the ticket resolver with the pull request delivery, and refuses the same tickets", async () => {
  const resolver = issueResolver({ command, repository: "/repository" });
  assert.deepEqual(await resolver.resolve(request({ ticket: "CLV-016" })), {
    kind: "resolved",
    input: {
      cycleId: "clv-016-a6f7ef47",
      ticketId: "CLV-016",
      ticket: "# CLV-016: Connect the board\n\nThe text of the ticket.",
      repository: "/repository",
      delivery: "pull-request",
    },
  });
  assert.equal(
    (await resolver.resolve(request({ ticket: "CLV-404" }))).kind,
    "rejected",
  );
  assert.equal(resolver.id, "issue-command");
});
