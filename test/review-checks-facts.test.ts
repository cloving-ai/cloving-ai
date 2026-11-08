import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import {
  factsOutput,
  type CommandCall,
} from "../templates/review-checks/review-checks/review-facts.mts";

const since = "2026-10-31T07:00:00Z";
const folders = ["/home/operator/gh", "/run/cloving/review-checks.jsonl"];
const merged = [
  "pr",
  "list",
  "--state",
  "merged",
  "--search",
  "merged:>=2026-10-31",
  "--json",
  "number,url,mergedAt",
  "--limit",
  "1000",
];
const checkIssues =
  "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20check&per_page=100";

function reviewRow(id: number, fields: Readonly<Record<string, unknown>> = {}) {
  return Object.assign(
    {
      id,
      path: "src/queue.ts",
      line: id,
      original_line: id,
      body: `Finding ${String(id)}`,
      html_url: `https://github.com/acme/demo/pull/641#discussion_r${String(id)}`,
      user: { login: "greptile-apps[bot]", type: "Bot" },
    },
    fields,
  );
}

function fakeSystem(answers: Readonly<Record<string, unknown>>) {
  const calls: CommandCall[] = [];
  const run = (call: CommandCall): Promise<string> => {
    calls.push(call);
    const key = [call.command].concat(call.args).join(" ");
    const answer = answers[key];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === undefined)
      return Promise.reject(new Error(`unexpected call ${key}`));
    return Promise.resolve(
      typeof answer === "string" ? answer : JSON.stringify(answer),
    );
  };
  return { calls, run };
}

function comments(number: number): string {
  return `gh api --paginate --slurp repos/{owner}/{repo}/pulls/${String(number)}/comments?per_page=100`;
}

const lint = "node_modules/.bin/eslint --print-config src/queue.ts";
const baseAnswers = {
  [["gh"].concat(merged).join(" ")]: [
    { number: 643, url: "u", mergedAt: "2026-11-02T10:00:00Z" },
    { number: 641, url: "u", mergedAt: "2026-11-01T10:00:00Z" },
    { number: 600, url: "u", mergedAt: "2026-10-30T10:00:00Z" },
  ],
  [comments(641)]: [
    [
      reviewRow(1),
      reviewRow(2, { in_reply_to_id: 1 }),
      reviewRow(3, { line: null, original_line: 7, path: "README.md" }),
    ],
  ],
  [comments(643)]: [
    [
      reviewRow(4, {
        user: { login: "person", type: "User" },
        line: null,
        original_line: null,
      }),
    ],
  ],
  [lint]: {
    rules: { "no-console": [2], "no-await-in-loop": "off", eqeqeq: 1 },
  },
  [`gh api --paginate --slurp ${checkIssues}`]: [
    [
      {
        number: 700,
        title: "Add the review check x",
        html_url: "https://github.com/acme/demo/issues/700",
        body: "## Desired outcome\n\nCheck: await-in-loop\n",
      },
      {
        number: 701,
        title: "A pull",
        html_url: "h",
        body: "",
        pull_request: {},
      },
      {
        number: 702,
        title: "Old form",
        html_url: "https://github.com/acme/demo/issues/702",
        body: null,
      },
    ],
  ],
};

const decisionLine = JSON.stringify({
  name: "await-in-loop",
  kind: "enable-rule",
  rule: "no-await-in-loop",
  shape: "Shape.",
  decision: "reject",
  links: ["https://github.com/acme/demo/pull/1#discussion_r1"],
  decidedAt: "2026-10-26T07:10:00Z",
  runId: "run-1",
});

const expectedFacts = {
  since,
  comments: [
    {
      pullRequest: 641,
      path: "src/queue.ts",
      line: 1,
      author: "greptile-apps[bot]",
      bot: true,
      text: "Finding 1",
      url: "https://github.com/acme/demo/pull/641#discussion_r1",
    },
    {
      pullRequest: 641,
      path: "README.md",
      line: 7,
      author: "greptile-apps[bot]",
      bot: true,
      text: "Finding 3",
      url: "https://github.com/acme/demo/pull/641#discussion_r3",
    },
    {
      pullRequest: 643,
      path: "src/queue.ts",
      line: null,
      author: "person",
      bot: false,
      text: "Finding 4",
      url: "https://github.com/acme/demo/pull/641#discussion_r4",
    },
  ],
  lintRules: {
    eqeqeq: "warn",
    "no-await-in-loop": "off",
    "no-console": "error",
  },
  qualityChecks: ["clones", "structure"],
  openTickets: [
    {
      number: 700,
      title: "Add the review check x",
      url: "https://github.com/acme/demo/issues/700",
      check: "await-in-loop",
    },
    {
      number: 702,
      title: "Old form",
      url: "https://github.com/acme/demo/issues/702",
      check: null,
    },
  ],
  decisions: [
    {
      name: "await-in-loop",
      shape: "Shape.",
      decision: "reject",
      links: ["https://github.com/acme/demo/pull/1#discussion_r1"],
    },
  ],
};

await test("CLV-316 review-comments prints the top-level review comments of the pull requests merged since the start of the week", async () => {
  const { calls, run } = fakeSystem(baseAnswers);
  const output = await factsOutput({
    commandArguments: folders,
    since,
    run,
    decisions: () => Promise.resolve(`${decisionLine}\n\n`),
    qualityChecks: () =>
      Promise.resolve(["structure.ts", "clones.ts", "notes.md", "types.d.ts"]),
  });
  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), expectedFacts);
  assert.deepEqual(
    calls.map((call) => call.github),
    [true, true, true, false, true],
  );
});

function missingFile(): Error {
  return Object.assign(new Error("spawn node_modules/.bin/eslint ENOENT"), {
    code: "ENOENT",
  });
}

async function printed(
  answers: Readonly<Record<string, unknown>>,
  fields: {
    readonly commandArguments?: readonly string[];
    readonly decisions?: string;
  } = {},
) {
  const { run } = fakeSystem(answers);
  return await factsOutput({
    commandArguments: fields.commandArguments ?? folders,
    since,
    run,
    decisions: () => Promise.resolve(fields.decisions ?? ""),
    qualityChecks: () => Promise.resolve([]),
  });
}

await test("CLV-316 review-comments refuses bad arguments and stops on a failed command or a bad decisions line", async () => {
  for (const commandArguments of [
    [],
    ["relative/gh", folders[1] ?? ""],
    folders.concat("/x"),
  ]) {
    const refused = await printed(baseAnswers, { commandArguments });
    assert.deepEqual(refused, {
      stdout: "",
      stderr:
        "Give the absolute GitHub CLI configuration folder and the absolute decisions file as the two arguments.\n",
      exitCode: 1,
    });
  }
  const failed = await printed(
    Object.assign({}, baseAnswers, {
      [comments(643)]: new Error("gh: not logged in"),
    }),
  );
  assert.deepEqual(failed, {
    stdout: "",
    stderr: "gh: not logged in\n",
    exitCode: 1,
  });
  const badLine = await printed(baseAnswers, {
    decisions: `${decisionLine}\nnot json\n`,
  });
  assert.deepEqual(badLine, {
    stdout: "",
    stderr: "The decisions file line 2 printed an unexpected response.\n",
    exitCode: 1,
  });
});

await test("CLV-316 review-comments gives no lint rules without ESLint, skips ignored files and keeps 200 comments", async () => {
  const none = await printed(
    Object.assign({}, baseAnswers, { [lint]: missingFile() }),
  );
  assert.equal(none.exitCode, 0, none.stderr);
  assert.deepEqual(record(JSON.parse(none.stdout))?.["lintRules"], {});
  const ignored = await printed(
    Object.assign({}, baseAnswers, { [lint]: "undefined\n" }),
  );
  assert.deepEqual(record(JSON.parse(ignored.stdout))?.["lintRules"], {});
  const many = Array.from({ length: 210 }, (_, index) =>
    reviewRow(index + 10, { path: "docs/notes.md" }),
  );
  const full = await printed(
    Object.assign({}, baseAnswers, {
      [comments(641)]: [many.slice(0, 100), many.slice(100)],
    }),
  );
  const kept = record(JSON.parse(full.stdout))?.["comments"];
  assert.ok(Array.isArray(kept));
  assert.equal(kept.length, 200);
  assert.equal(
    record(kept.at(-1))?.["url"],
    "https://github.com/acme/demo/pull/641#discussion_r209",
  );
});

await test("CLV-316 review-comments stops on an unexpected gh or ESLint response", async () => {
  for (const [key, answer, message] of [
    [comments(641), "not json", "gh printed an unexpected response."],
    [
      comments(641),
      [[reviewRow(1, { path: 5 })]],
      "gh printed an unexpected response.",
    ],
    [
      comments(641),
      [[reviewRow(1, { line: 0, original_line: 0 })]],
      "gh printed an unexpected response.",
    ],
    [comments(641), { pages: [] }, "gh printed an unexpected response."],
    [
      lint,
      { rules: { eqeqeq: "loud" } },
      "eslint printed an unexpected response.",
    ],
    [
      lint,
      Object.assign(new Error("eslint crashed"), { code: 2 }),
      "eslint crashed",
    ],
  ] as const) {
    const output = await printed(
      Object.assign({}, baseAnswers, { [key]: answer }),
    );
    assert.deepEqual(output, {
      stdout: "",
      stderr: `${message}\n`,
      exitCode: 1,
    });
  }
});
