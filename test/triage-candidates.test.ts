import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { candidateOutput } from "../templates/triage-issue/triage-issue/triage-queue.mts";

const quietSince = "2026-11-04T11:50:00Z";
const listing = [
  "api",
  "--paginate",
  "--slurp",
  "repos/{owner}/{repo}/issues?state=open&per_page=100",
];

interface Row {
  readonly number: number;
  readonly user?: { readonly login: string };
  readonly labels?: readonly { readonly name: string }[];
  readonly created_at?: string;
  readonly comments?: number;
  readonly pull_request?: Readonly<Record<string, unknown>>;
}

function row(fields: Row): Row {
  return Object.assign(
    {
      user: { login: "visitor" },
      labels: [],
      created_at: "2026-11-04T10:00:00Z",
      comments: 0,
    },
    fields,
  );
}

function commentsPath(number: number): string {
  return `repos/{owner}/{repo}/issues/${String(number)}/comments?per_page=100`;
}

function fakeGh(github: {
  readonly rows: readonly Row[];
  readonly comments?: Readonly<Record<number, readonly string[]>>;
}) {
  const calls: (readonly string[])[] = [];
  const gh = (args: readonly string[]): Promise<string> => {
    calls.push(args);
    if (JSON.stringify(args) === JSON.stringify(listing))
      return Promise.resolve(JSON.stringify([github.rows]));
    const number = Number(/\/issues\/(\d+)\/comments/.exec(args[3] ?? "")?.[1]);
    const times = github.comments?.[number] ?? [];
    if (
      JSON.stringify(args.slice(0, 3)) !== JSON.stringify(listing.slice(0, 3))
    )
      return Promise.reject(new Error(`unexpected gh call ${args.join(" ")}`));
    return Promise.resolve(
      JSON.stringify([times.map((time) => ({ created_at: time }))]),
    );
  };
  return { calls, gh };
}

await test("CLV-319 an operator issue, a triaged issue, a recent comment and a pull request are not candidates", async () => {
  const github = fakeGh({
    rows: [
      row({ number: 1, user: { login: "Operator" } }),
      row({ number: 2, labels: [{ name: "cloving: triaged" }] }),
      row({ number: 3, comments: 1 }),
      row({ number: 4 }),
      row({ number: 5, pull_request: { url: "pull" } }),
      row({ number: 6, comments: 2 }),
      row({ number: 7, labels: [{ name: "bug" }] }),
    ],
    comments: {
      3: ["2026-11-04T11:55:00Z", "2026-11-04T10:30:00Z"],
      6: ["2026-11-04T11:00:00Z", "2026-11-04T11:50:00Z"],
    },
  });
  const output = await candidateOutput({
    gh: github.gh,
    operators: ["operator", "helper"],
    quietSince,
  });
  assert.deepEqual(output, {
    stdout: '[{"number":4},{"number":6},{"number":7}]\n',
    stderr: "",
    exitCode: 0,
  });
  assert.deepEqual(github.calls, [
    listing,
    ["api", "--paginate", "--slurp", commentsPath(3)],
    ["api", "--paginate", "--slurp", commentsPath(6)],
  ]);
});

await test("CLV-319 one pass prints at most four candidates, the oldest issues first", async () => {
  const github = fakeGh({
    rows: [12, 11, 10, 9, 8, 7, 6].map((number) =>
      row({ number, comments: number === 6 ? 0 : 1 }),
    ),
    comments: { 8: ["2026-11-04T11:00:00Z"] },
  });
  const output = await candidateOutput({
    gh: github.gh,
    operators: ["operator"],
    quietSince,
  });
  assert.equal(
    output.stdout,
    '[{"number":6},{"number":7},{"number":8},{"number":9}]\n',
  );
  assert.deepEqual(
    github.calls.map((call) => call[3]),
    [listing[3], commentsPath(7), commentsPath(8), commentsPath(9)],
  );
});

await test("CLV-319 an issue opened in the last 10 minutes waits like an issue with a new comment", async () => {
  const github = fakeGh({
    rows: [
      row({ number: 3, created_at: "2026-11-04T11:55:00Z" }),
      row({ number: 4, created_at: quietSince }),
    ],
  });
  const output = await candidateOutput({
    gh: github.gh,
    operators: ["operator"],
    quietSince,
  });
  assert.equal(output.stdout, '[{"number":4}]\n');
});

await test("CLV-319 the candidates command prints nothing and ends with code 1 without operators or with a bad gh answer", async () => {
  const refused = (stderr: string) => ({ stdout: "", stderr, exitCode: 1 });
  const operatorsMissing = refused(
    "Give the GitHub logins of the operators as arguments.\n",
  );
  const unexpectedAnswer = refused("gh printed an unexpected response.\n");
  for (const [gh, operators, expected] of [
    [fakeGh({ rows: [row({ number: 4 })] }).gh, [], operatorsMissing],
    [fakeGh({ rows: [] }).gh, ["two words"], operatorsMissing],
    [
      () =>
        Promise.reject(
          Object.assign(new Error("Command failed"), {
            stderr: "gh: Bad credentials (HTTP 401)\n",
          }),
        ),
      ["operator"],
      refused("The gh command failed: gh: Bad credentials (HTTP 401)\n"),
    ],
    [() => Promise.resolve("not json"), ["operator"], unexpectedAnswer],
    [() => Promise.resolve("{}"), ["operator"], unexpectedAnswer],
    [
      fakeGh({ rows: [row({ number: 4, created_at: "yesterday" })] }).gh,
      ["operator"],
      unexpectedAnswer,
    ],
    [
      fakeGh({
        rows: [row({ number: 4, comments: 1 })],
        comments: { 4: ["now"] },
      }).gh,
      ["operator"],
      unexpectedAnswer,
    ],
  ] as const)
    assert.deepEqual(
      await candidateOutput({ gh, operators, quietSince }),
      expected,
    );
});

const scriptGh = `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}
const args = process.argv.slice(2);
const old = new Date(Date.now() - 3_600_000).toISOString().replace(/\\.\\d{3}Z$/, "Z");
const recent = new Date(Date.now() - 60_000).toISOString().replace(/\\.\\d{3}Z$/, "Z");
const row = (number, comments) => ({ number, user: { login: "visitor" }, labels: [], created_at: old, comments });
if (args[3] === "repos/{owner}/{repo}/issues?state=open&per_page=100")
  process.stdout.write(JSON.stringify([[row(5, 1), row(4, 1), { ...row(3, 0), user: { login: "Operator" } }]]));
else process.stdout.write(JSON.stringify([[{ created_at: args[3].includes("/5/") ? recent : old }]]));
`;

await test("CLV-319 the triage-candidates script reads gh and leaves out the issue with a comment of a minute ago", () =>
  withFiles({ "bin/gh": scriptGh }, async (directory) => {
    await chmod(join(directory, "bin/gh"), 0o755);
    const run = (operators: readonly string[]) =>
      spawnSync(
        process.execPath,
        [
          "templates/triage-issue/triage-issue/triage-candidates.mts",
          ...operators,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(directory, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
          },
        },
      );
    const printed = run(["operator"]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout, '[{"number":4}]\n');
    const refused = run([]);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /operators as arguments/);
  }));
