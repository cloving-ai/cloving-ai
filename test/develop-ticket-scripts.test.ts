import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextTicketScript,
  readyIssue,
  readyTicketsScript,
  runScript,
  withFakeGithub,
  writeFakeGithub,
} from "./develop-ticket-scripts-fixture.ts";
import { readyList } from "../src/queue-state.ts";
import { hardDependencies } from "../src/ticket-dependencies.ts";
import { blockersOf } from "../templates/develop/develop/ticket-queue.mts";

const needsTwo = "# Third\n\n## Dependencies\n\nNeeds #2\n";

await test("CLV-301 the next-ticket script prints #2 and not #3 while #3 needs the open #2", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(2, { createdAt: "2026-11-02T08:00:00Z" }),
        readyIssue(3, { createdAt: "2026-11-01T08:00:00Z", body: needsTwo }),
      ],
    },
    (directory) => {
      const result = runScript(nextTicketScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.equal(result.stdout, "2\n");
      assert.deepEqual(result.warnings, []);
    },
  ));

await test("CLV-301 the next-ticket script prints #3 after #2 closes", () =>
  withFakeGithub(
    {
      issues: [
        {
          number: 2,
          state: "closed",
          createdAt: "2026-11-02T08:00:00Z",
          closedAt: "2026-11-04T08:00:00Z",
        },
        readyIssue(3, { createdAt: "2026-11-01T08:00:00Z", body: needsTwo }),
        readyIssue(4, { createdAt: "2026-11-03T08:00:00Z" }),
      ],
    },
    (directory) => {
      const result = runScript(nextTicketScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.equal(result.stdout, "3\n");
      assert.deepEqual(result.warnings, []);
    },
  ));

const needs = (number: number) => `## Dependencies\nNeeds #${String(number)}\n`;

await test("CLV-301 issues in a dependency cycle are never printed and standard error names the cycle", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(4, { createdAt: "2026-11-01T08:00:00Z", body: needs(5) }),
        readyIssue(5, { createdAt: "2026-11-02T08:00:00Z", body: needs(4) }),
        readyIssue(6, { createdAt: "2026-11-03T08:00:00Z" }),
      ],
    },
    (directory) => {
      const result = runScript(nextTicketScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.equal(result.stdout, "6\n");
      assert.deepEqual(result.warnings, ["Dependency cycle: #4 -> #5 -> #4"]);
    },
  ));

await test("CLV-301 every issue of a group with two cycles is in a warning line", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(1, {
          createdAt: "2026-11-01T08:00:00Z",
          body: "## Dependencies\nNeeds #2\nNeeds #3\n",
        }),
        readyIssue(2, { createdAt: "2026-11-01T09:00:00Z", body: needs(1) }),
        readyIssue(3, { createdAt: "2026-11-01T10:00:00Z", body: needs(2) }),
      ],
    },
    (directory) => {
      const result = runScript(nextTicketScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.equal(result.stdout, "");
      assert.deepEqual(result.warnings, [
        "Dependency cycle: #1 -> #2 -> #1",
        "Dependency cycle: #3 -> #2 -> #1 -> #3",
      ]);
    },
  ));

await test("CLV-301 the scripts find a cycle through open issues without the ready label", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(7, { createdAt: "2026-11-01T08:00:00Z", body: needs(8) }),
        {
          number: 8,
          state: "open",
          createdAt: "2026-11-01T09:00:00Z",
          body: needs(9),
        },
        {
          number: 9,
          state: "open",
          createdAt: "2026-11-01T10:00:00Z",
          body: needs(8),
        },
      ],
    },
    (directory) => {
      const result = runScript(nextTicketScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.equal(result.stdout, "");
      assert.deepEqual(result.warnings, ["Dependency cycle: #8 -> #9 -> #8"]);
    },
  ));

await test("CLV-301 a blocker that does not exist keeps the issue back and the warning names it", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(3, { createdAt: "2026-11-01T08:00:00Z", body: needs(99) }),
        readyIssue(10, { createdAt: "2026-11-02T08:00:00Z" }),
      ],
    },
    async (directory) => {
      const result = runScript(nextTicketScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.equal(result.stdout, "10\n");
      assert.deepEqual(result.warnings, [
        "Missing blocker: #3 needs #99, which does not exist",
      ]);
      await writeFakeGithub(directory, {
        issues: [
          readyIssue(3, { createdAt: "2026-11-01T08:00:00Z", body: needs(2) }),
        ],
        failure: {
          command: "api",
          stderr: "gh: This issue was deleted (HTTP 410)",
        },
      });
      const deleted = runScript(nextTicketScript, { directory });
      assert.equal(deleted.status, 0, deleted.warnings.join("\n"));
      assert.equal(deleted.stdout, "");
      assert.deepEqual(deleted.warnings, [
        "Missing blocker: #3 needs #2, which does not exist",
      ]);
    },
  ));

const minute = (number: number) =>
  new Date(Date.UTC(2026, 9, 1) + number * 60_000).toISOString();

await test("CLV-301 the scripts read every ready issue, also the oldest of more than 1000", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(1, { createdAt: minute(1) }),
        ...Array.from({ length: 1000 }, (_, index) =>
          readyIssue(index + 2, {
            createdAt: minute(index + 2),
            body: needs(1002),
          }),
        ),
        { number: 1002, state: "open", createdAt: minute(1002) },
      ],
    },
    (directory) => {
      const next = runScript(nextTicketScript, { directory });
      assert.equal(next.status, 0, next.warnings.join("\n"));
      assert.equal(next.stdout, "1\n");
      assert.deepEqual(next.warnings, []);
      const ready = runScript(readyTicketsScript, { directory });
      assert.equal(ready.status, 0, ready.warnings.join("\n"));
      assert.deepEqual(readyList(ready.stdout), {
        kind: "read",
        tickets: [{ id: "1", readyAt: minute(1) }],
      });
    },
  ));

await test("CLV-301 the scripts never print a pull request with the ready label", () =>
  withFakeGithub(
    {
      issues: [
        {
          ...readyIssue(20, { createdAt: "2026-11-01T08:00:00Z" }),
          pullRequest: true,
        },
        readyIssue(21, { createdAt: "2026-11-02T08:00:00Z" }),
      ],
    },
    (directory) => {
      const next = runScript(nextTicketScript, { directory });
      assert.equal(next.status, 0, next.warnings.join("\n"));
      assert.equal(next.stdout, "21\n");
      const ready = runScript(readyTicketsScript, { directory });
      assert.deepEqual(readyList(ready.stdout), {
        kind: "read",
        tickets: [{ id: "21", readyAt: "2026-11-02T08:00:00Z" }],
      });
    },
  ));

await test("CLV-301 the next-ticket script never prints an ID from CLOVING_SKIP_TICKETS", () =>
  withFakeGithub(
    {
      issues: [
        readyIssue(2, { createdAt: "2026-11-01T08:00:00Z" }),
        readyIssue(12, { createdAt: "2026-11-02T08:00:00Z" }),
        readyIssue(13, { createdAt: "2026-11-03T08:00:00Z" }),
      ],
    },
    (directory) => {
      const first = runScript(nextTicketScript, {
        directory,
        environment: { CLOVING_SKIP_TICKETS: "1 2 12" },
      });
      assert.equal(first.status, 0, first.warnings.join("\n"));
      assert.equal(first.stdout, "13\n");
      const none = runScript(nextTicketScript, {
        directory,
        environment: { CLOVING_SKIP_TICKETS: "2 12 13" },
      });
      assert.equal(none.status, 0, none.warnings.join("\n"));
      assert.equal(none.stdout, "");
    },
  ));

await test("CLV-301 the ready-tickets script lists the ready issues with the time each became ready", () =>
  withFakeGithub(
    {
      issues: [
        {
          number: 2,
          state: "closed",
          createdAt: "2026-11-02T08:00:00Z",
          closedAt: "2026-11-04T08:00:00Z",
        },
        readyIssue(3, { createdAt: "2026-11-01T08:00:00Z", body: needsTwo }),
        readyIssue(4, { createdAt: "2026-11-03T08:00:00Z" }),
        readyIssue(5, { createdAt: "2026-11-02T09:00:00Z", body: needs(6) }),
        { number: 6, state: "open", createdAt: "2026-11-02T10:00:00Z" },
        readyIssue(9, { createdAt: "2026-11-06T08:00:00Z", body: needsTwo }),
      ],
    },
    (directory) => {
      const result = runScript(readyTicketsScript, { directory });
      assert.equal(result.status, 0, result.warnings.join("\n"));
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(readyList(result.stdout), {
        kind: "read",
        tickets: [
          { id: "3", readyAt: "2026-11-04T08:00:00Z" },
          { id: "4", readyAt: "2026-11-03T08:00:00Z" },
          { id: "9", readyAt: "2026-11-06T08:00:00Z" },
        ],
      });
    },
  ));

const failures = [
  {
    github: {
      failure: { command: "list", stderr: "gh: Server Error (HTTP 500)" },
    },
    warning: "The gh command failed: gh: Server Error (HTTP 500)",
  },
  {
    github: {
      failure: { command: "api", stderr: "gh: Bad Gateway (HTTP 502)" },
    },
    warning: "The gh command failed: gh: Bad Gateway (HTTP 502)",
  },
  {
    github: { failure: { command: "list", stderr: "" } },
    warning:
      "Command failed: gh api --paginate --slurp repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20ready&per_page=100",
  },
  {
    github: { listOutput: "{}" },
    warning: "gh printed an unexpected response.",
  },
  {
    github: { listOutput: "[{}]" },
    warning: "gh printed an unexpected response.",
  },
  {
    github: {
      listOutput: JSON.stringify([
        [
          {
            number: "3",
            state: "open",
            created_at: "2026-11-01T08:00:00Z",
            body: "",
          },
        ],
      ]),
    },
    warning: "gh printed an unexpected response.",
  },
  {
    github: {
      apiOutput: JSON.stringify({
        state: "merged",
        created_at: "2026-11-01T07:00:00Z",
        closed_at: null,
        body: null,
      }),
    },
    warning: "gh printed an unexpected response.",
  },
] as const;

await test("CLV-301 a failed or unexpected gh call ends the scripts with code 1 and prints no ticket", async () => {
  for (const { github, warning } of failures)
    await withFakeGithub(
      {
        ...github,
        issues: [
          readyIssue(3, { createdAt: "2026-11-01T08:00:00Z", body: needsTwo }),
          { number: 2, state: "closed", createdAt: "2026-11-01T07:00:00Z" },
        ],
      },
      (directory) => {
        for (const script of [nextTicketScript, readyTicketsScript]) {
          const result = runScript(script, { directory });
          assert.equal(result.status, 1, script);
          assert.equal(result.stdout, "", script);
          assert.deepEqual(result.warnings, [warning], script);
        }
      },
    );
});

await test("CLV-301 the scripts read blockers with the dependency rule of the daemon", () => {
  const body = [
    "# Title",
    "Needs #1",
    "## Dependencies",
    "",
    "Needs #2",
    "- Needs #3 and #4.",
    "1. Needs #5. See #6.",
    "See #7. Needs #10 and",
    "#11.",
    "### Detail",
    "* Needs #8, e.g. after #12.",
    "## Notes",
    "Needs #9",
  ].join("\r\n");
  assert.deepEqual(blockersOf(body), [2, 3, 4, 5, 10, 11, 8, 12]);
  assert.deepEqual(blockersOf(body).map(String), hardDependencies(body));
  assert.deepEqual(blockersOf("Needs #2\n## Dependency\nNeeds #3\n"), []);
});
