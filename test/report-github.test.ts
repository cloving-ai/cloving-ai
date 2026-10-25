import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import type {
  WatchCommandOutput,
  WatchCommandRequest,
} from "../src/cli/watch-pr-command.ts";

const since = "2026-10-17T00:00:00.000Z";
const output = (value: unknown): WatchCommandOutput => ({
  stdout: JSON.stringify(value),
  stderr: "",
  status: 0,
  errorCode: null,
});
const issue = (
  number: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  number,
  html_url: `https://github.example/fixture/demo/issues/${String(number)}`,
  closed_at: "2026-10-24T12:00:00Z",
  state: "closed",
  state_reason: "completed",
  ...extra,
});
const pull = (
  number: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  number,
  html_url: `https://github.example/fixture/demo/pull/${String(number)}`,
  updated_at: "2026-10-24T12:00:00Z",
  merged_at: "2026-10-24T12:00:00Z",
  ...extra,
});

function projectedIssues(values: unknown, query: string | undefined) {
  if (
    query !==
    'map({number, html_url, closed_at, state, state_reason} + (if has("pull_request") then {pull_request: {}} else {} end))'
  )
    throw new Error("invalid-fixture-projection");
  if (!Array.isArray(values)) throw new Error("invalid-fixture-rows");
  return values.map((value: unknown) =>
    Object.fromEntries(
      Object.entries(value ?? {}).filter(([key]) =>
        [
          "number",
          "html_url",
          "closed_at",
          "state",
          "state_reason",
          "pull_request",
        ].includes(key),
      ),
    ),
  );
}

function issueOutput(
  request: WatchCommandRequest,
  input: { readonly pages: unknown; readonly limit: number | undefined },
): WatchCommandOutput {
  const { pages, limit } = input;
  const endpoint =
    request.command.find((part) => part.startsWith("repos/")) ?? "";
  const page = Number(/page=(\d+)$/.exec(endpoint)?.[1] ?? 1);
  let values: unknown = pages;
  if (Array.isArray(pages) && !request.command.includes("--slurp"))
    values = page <= pages.length ? pages[page - 1] : [];
  const query = request.command.indexOf("--jq");
  if (query !== -1)
    values = projectedIssues(values, request.command[query + 1]);
  const result = output(values);
  return limit !== undefined && Buffer.byteLength(result.stdout) > limit
    ? {
        ...result,
        stdout: "",
        status: 1,
        errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }
    : result;
}

function fixture(
  options: {
    readonly issues?: unknown;
    readonly pulls?: unknown;
    readonly pullPages?: readonly unknown[];
    readonly failures?: readonly WatchCommandOutput[];
    readonly created?: string;
    readonly repositoryName?: string;
    readonly issueOutputLimit?: number;
  } = {},
) {
  const commands: (readonly string[])[] = [];
  let attempts = 0;
  const issueRows = options.issues ?? [[]];
  const pullPages = options.pullPages ?? [options.pulls ?? []];
  const metadata = {
    full_name: options.repositoryName ?? "fixture/demo",
    created_at: options.created ?? "2026-01-01T00:00:00Z",
  };
  const execute = (
    request: WatchCommandRequest,
  ): Promise<WatchCommandOutput> => {
    commands.push(request.command);
    if (request.command[0] === "git")
      return Promise.resolve({
        ...output(null),
        stdout: "git@github.example:fixture/demo.git\n",
      });
    const endpoint =
      request.command.find((part) => part.startsWith("repos/")) ?? "";
    if (endpoint === "repos/fixture/demo")
      return Promise.resolve(output(metadata));
    if (endpoint.includes("/issues?")) {
      const failure = options.failures?.[attempts];
      attempts += 1;
      return Promise.resolve(
        failure ??
          issueOutput(request, {
            pages: issueRows,
            limit: options.issueOutputLimit,
          }),
      );
    }
    const page = Number(/page=(\d+)$/.exec(endpoint)?.[1] ?? 1);
    return Promise.resolve(output(pullPages[page - 1] ?? []));
  };
  return {
    commands,
    attempts: () => attempts,
    settings: {
      repository: "/fixture/repo",
      githubCommand: JSON.stringify(["fake-gh", "prefix"]),
      execute,
    },
  };
}

await test("CLV-199 GitHub reads validate repository identity and separate completed tickets from merged pull requests", async () => {
  const scene = fixture({
    issues: [
      [
        issue(1),
        issue(2, { state_reason: "not_planned" }),
        issue(3, { pull_request: {} }),
      ],
      [],
    ],
    pulls: [pull(4), pull(5, { merged_at: null })],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.equal(result.issues?.length, 1);
  assert.equal(result.pulls?.length, 1);
  assert.deepEqual(result.issues[0]?.evidence, { issue: 1 });
  assert.deepEqual(result.pulls[0]?.evidence, { pullRequest: 4 });
  assert.ok(
    scene.commands
      .slice(1)
      .every(
        (command) =>
          command.slice(0, 2).join(" ") === "fake-gh prefix" &&
          command.includes("GET") &&
          command.includes("github.example"),
      ),
  );
});

await test("CLV-199 large GitHub issue pages keep ticket counts and baseline evidence within the CLI output limit", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    issue(index + 1, { body: "x".repeat(65_536) }),
  );
  const scene = fixture({
    issues: [
      first,
      [
        issue(101, { closed_at: "2026-10-20T12:00:00Z" }),
        issue(102, { pull_request: {} }),
        issue(103, { state_reason: "not_planned" }),
      ],
    ],
    issueOutputLimit: 1024 * 1024,
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.equal(result.sources.issues.status, "available");
  assert.equal(result.issues?.length, 101);
  assert.deepEqual(result.issues.at(-1), {
    at: Date.parse("2026-10-20T12:00:00Z"),
    value: 1,
    evidence: { issue: 101 },
  });
  assert.equal(scene.attempts(), 2);
});

await test("CLV-199 an unreadable later issue page retries without reporting partial ticket counts", async () => {
  const first = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const failure = { ...output(null), status: 1, stderr: "HTTP 502 (HTTP 502)" };
  const scene = fixture({
    failures: [output(first), failure, failure, failure],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.equal(scene.attempts(), 4);
  assert.equal(result.issues, null);
  assert.equal(result.sources.issues.reason, "github-network-failed");
  assert.equal(result.sources.pulls.status, "available");
  const repeated = await readReportGithub({
    since,
    settings: fixture({ issues: [first, first] }).settings,
  });
  assert.equal(repeated.issues, null);
});

await test("CLV-199 transient GitHub reads use three attempts and keep other sources available", async () => {
  const failure = {
    stdout: "",
    stderr: "HTTP 502 (HTTP 502)",
    status: 1,
    errorCode: null,
  };
  const scene = fixture({ failures: [failure, failure, failure] });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.equal(scene.attempts(), 3);
  assert.equal(result.issues, null);
  assert.deepEqual(result.pulls, []);
  assert.equal(result.sources.issues.status, "unavailable");
  assert.equal(result.sources.issues.reason, "github-network-failed");
});

await test("CLV-199 invalid configuration and foreign response identities are unavailable", async () => {
  const malformed = await readReportGithub({
    since,
    settings: { ...fixture().settings, githubCommand: "[]" },
  });
  assert.equal(malformed.issues, null);
  const foreign = await readReportGithub({
    since,
    settings: fixture({
      issues: [
        [issue(1, { html_url: "https://other.example/owner/repo/issues/1" })],
      ],
    }).settings,
  });
  assert.equal(foreign.issues, null);
});

await test("CLV-199 a young repository has short history rather than seven invented days", async () => {
  const result = await readReportGithub({
    since,
    settings: fixture({ created: "2026-10-23T00:00:00Z" }).settings,
  });
  assert.equal(result.observedSince, Date.parse("2026-10-23T00:00:00Z"));
});

await test("CLV-199 repository creation identity is case insensitive", async () => {
  const result = await readReportGithub({
    since,
    settings: fixture({ repositoryName: "Fixture/Demo" }).settings,
  });
  assert.equal(result.sources.history.status, "available");
  assert.equal(result.observedSince, Date.parse("2026-01-01T00:00:00Z"));
});

await test("CLV-199 GitHub pagination reads later merges and rejects repeated pages", async () => {
  const first = Array.from({ length: 100 }, (_, index) => pull(index + 1));
  const scene = fixture({ pullPages: [first, [pull(101)]] });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.equal(result.pulls?.length, 101);
  const repeated = await readReportGithub({
    since,
    settings: fixture({ pullPages: [first, first] }).settings,
  });
  assert.equal(repeated.pulls, null);
});

await test("CLV-199 malformed GitHub sources remain unavailable and authentication errors are not retried", async () => {
  for (const issues of [
    "invalid",
    [null],
    [[null]],
    [[issue(1), issue(1)]],
    [[issue(1, { state_reason: null })]],
    [[issue(1, { closed_at: "bad" })]],
  ]) {
    const result = await readReportGithub({
      since,
      settings: fixture({ issues }).settings,
    });
    assert.equal(result.issues, null);
    assert.equal(result.sources.issues.status, "unavailable");
  }
  const scene = fixture({
    failures: [
      { ...output(null), status: 4, stderr: "authentication required" },
    ],
  });
  const denied = await readReportGithub({ since, settings: scene.settings });
  assert.equal(denied.issues, null);
  assert.equal(scene.attempts(), 1);
});

await test("CLV-199 one network failure retries a GET and then reports readable data", async () => {
  const scene = fixture({
    failures: [{ ...output(null), status: 1, stderr: "TLS handshake timeout" }],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: { ...scene.settings, githubCommand: undefined },
  });
  assert.deepEqual(result.issues, []);
  assert.equal(scene.attempts(), 2);
  assert.ok(scene.commands.some((command) => command[0] === "gh"));
  for (const githubCommand of ["not json", '["fake-gh",0]', '[""]']) {
    const unavailable = await readReportGithub({
      since,
      settings: { ...scene.settings, githubCommand },
    });
    assert.equal(unavailable.issues, null);
  }
});
