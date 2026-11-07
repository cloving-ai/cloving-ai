import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installTree,
  minimist,
  threeSeverities,
} from "./dependency-audit-fixture.ts";
import {
  auditOutput,
  commandFailure,
  type CommandCall,
  type CommandEnd,
} from "../templates/dependency-audit/dependency-audit/audit-run.mts";
import { record } from "../src/protocol.ts";

const issuesCall =
  "gh api --paginate --slurp repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20security&per_page=100";

function names(stdout: string): readonly unknown[] {
  const printed: unknown = JSON.parse(stdout);
  return Array.isArray(printed)
    ? printed.map((item: unknown) => record(item)?.["name"])
    : [];
}

function ended(stdout: string, code: unknown = 0): CommandEnd {
  return { error: code === 0 ? null : { code }, stdout, stderr: "" };
}

const listCall = "git worktree list --porcelain";
const remoteCall = "git ls-remote --symref origin HEAD";
const fetchCall =
  "git fetch --quiet origin +refs/heads/trunk:refs/remotes/origin/trunk";

interface FakeSystem {
  readonly calls: string[];
  readonly environments: string[];
  readonly removed: string[];
  readonly run: (call: CommandCall) => Promise<CommandEnd>;
  readonly alive: (processId: number) => boolean;
  readonly temporary: {
    readonly names: () => Promise<readonly string[]>;
    readonly remove: (name: string) => Promise<void>;
  };
  readonly repository: string;
  readonly folder: string;
  readonly commandArguments: readonly string[];
}

function system(
  answers: Readonly<Record<string, CommandEnd | string>> = {},
  temporaryNames: readonly string[] = [],
): FakeSystem {
  const calls: string[] = [];
  const environments: string[] = [];
  const removed: string[] = [];
  const defaults: Readonly<Record<string, CommandEnd>> = {
    [remoteCall]: ended(
      "ref: refs/heads/trunk\tHEAD\n4f3c2a1b0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a\tHEAD\n",
    ),
    "npm audit --json": ended(JSON.stringify(threeSeverities), 1),
    "npm ls --all --json": ended(JSON.stringify(installTree), 1),
    [issuesCall]: ended(JSON.stringify([[]])),
  };
  return {
    calls,
    environments,
    removed,
    repository: "/work/repository",
    folder: "/work/audit",
    commandArguments: ["/work/github"],
    alive: (processId) => processId === 41,
    temporary: {
      names: () => Promise.resolve(temporaryNames),
      remove: async (name) => {
        calls.push(`remove ${name}`);
        removed.push(name);
        await Promise.resolve();
      },
    },
    run: async (call) => {
      const command = `${call.file} ${call.args.join(" ")}`;
      calls.push(`${call.cwd}: ${command}`);
      environments.push(`${call.file} ${JSON.stringify(call.environment)}`);
      const answer = answers[command] ?? defaults[command] ?? ended("");
      if (typeof answer === "string") throw new Error(answer);
      return await Promise.resolve(answer);
    },
  };
}

await test("CLV-318 the audit runs in a clean detached work tree of the newest default branch and removes it", async () => {
  const machine = system();
  const output = await auditOutput(machine);
  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stderr, "");
  assert.deepEqual(names(output.stdout), ["minimist", "undici"]);
  assert.deepEqual(machine.calls, [
    `/work/repository: ${listCall}`,
    `/work/repository: ${remoteCall}`,
    `/work/repository: ${fetchCall}`,
    "/work/repository: git worktree add --quiet --detach /work/audit/tree origin/trunk",
    "/work/audit/tree: npm ci --ignore-scripts --no-audit --no-fund",
    "/work/audit/tree: npm audit --json",
    "/work/audit/tree: npm ls --all --json",
    `/work/repository: ${issuesCall}`,
    "/work/repository: git worktree remove --force /work/audit/tree",
  ]);
});

await test("CLV-318 the audit gives the GitHub CLI configuration folder of its argument to git and gh, not to npm", async () => {
  const machine = system();
  assert.equal((await auditOutput(machine)).exitCode, 0);
  const login = '{"GH_CONFIG_DIR":"/work/github"}';
  assert.deepEqual(machine.environments, [
    `git ${login}`,
    `git ${login}`,
    `git ${login}`,
    `git ${login}`,
    "npm {}",
    "npm {}",
    "npm {}",
    `gh ${login}`,
    `git ${login}`,
  ]);
});

await test("CLV-318 the audit needs the absolute path of a GitHub CLI configuration folder as its only argument", async () => {
  for (const commandArguments of [
    [],
    ["github"],
    ["/work/github", "/work/other"],
  ]) {
    const machine = {
      ...system({}, ["cloving-audit-7-a1b2c3"]),
      commandArguments,
    };
    assert.deepEqual(await auditOutput(machine), {
      stdout: "",
      stderr:
        "Give the absolute path of a GitHub CLI configuration folder as the only argument.\n",
      exitCode: 1,
    });
    assert.deepEqual(machine.calls, []);
  }
});

await test("CLV-318 the audit prints the open-ticket filter result", async () => {
  const output = await auditOutput(
    system({
      [issuesCall]: ended(
        JSON.stringify([[{ title: "Fix", body: minimist.url }]]),
      ),
    }),
  );
  assert.deepEqual(names(output.stdout), ["undici"]);
});

await test("CLV-318 a failed command prints no candidates, names the command and still removes the work tree", async () => {
  for (const [answers, message] of [
    [
      {
        "npm ci --ignore-scripts --no-audit --no-fund": {
          error: { code: 1 },
          stdout: "",
          stderr: "npm error code EUSAGE\nnpm error lock file mismatch\n",
        },
      },
      "npm ci --ignore-scripts --no-audit --no-fund failed: npm error lock file mismatch\n",
    ],
    [
      { "npm audit --json": ended("{}", 2) },
      "npm audit --json failed: exit code 2\n",
    ],
    [
      { "npm ls --all --json": ended("", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") },
      "npm ls --all --json failed: exit code ERR_CHILD_PROCESS_STDIO_MAXBUFFER\n",
    ],
    [
      { "npm audit --json": ended("npm error network", 1) },
      "npm audit printed an unexpected report.\n",
    ],
    [{ [issuesCall]: ended("{}\n") }, "gh printed an unexpected report.\n"],
  ] as const) {
    const machine = system(answers);
    assert.deepEqual(await auditOutput(machine), {
      stdout: "",
      stderr: message,
      exitCode: 1,
    });
    assert.equal(
      machine.calls.at(-1),
      "/work/repository: git worktree remove --force /work/audit/tree",
    );
  }
});

await test("CLV-318 a failed git step stops before the work tree or names the failure", async () => {
  const machine = system({
    [fetchCall]: {
      error: { code: 128 },
      stdout: "",
      stderr: "fatal: unable to access the remote\n",
    },
  });
  assert.deepEqual(await auditOutput(machine), {
    stdout: "",
    stderr: `${fetchCall} failed: fatal: unable to access the remote\n`,
    exitCode: 1,
  });
  assert.equal(machine.calls.length, 3);
  assert.deepEqual(
    await auditOutput(system({ [remoteCall]: "spawn git ENOENT" })),
    { stdout: "", stderr: "spawn git ENOENT\n", exitCode: 1 },
  );
});

await test("CLV-318 the audit reads the default branch from the remote, not from the local origin/HEAD", async () => {
  const machine = system({
    [remoteCall]: ended(
      "ref: refs/heads/release/2026\tHEAD\n4f3c2a1b0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a\tHEAD\n",
    ),
  });
  assert.equal((await auditOutput(machine)).exitCode, 0);
  assert.deepEqual(machine.calls.slice(2, 4), [
    "/work/repository: git fetch --quiet origin +refs/heads/release/2026:refs/remotes/origin/release/2026",
    "/work/repository: git worktree add --quiet --detach /work/audit/tree origin/release/2026",
  ]);
});

await test("CLV-318 a remote that names no default branch stops the audit before the fetch", async () => {
  for (const answer of [
    ended("4f3c2a1b0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a\tHEAD\n"),
    ended("ref: refs/tags/v1\tHEAD\n"),
    ended(""),
  ]) {
    const machine = system({ [remoteCall]: answer });
    assert.deepEqual(await auditOutput(machine), {
      stdout: "",
      stderr: "The remote origin names no default branch.\n",
      exitCode: 1,
    });
    assert.equal(machine.calls.at(-1), `/work/repository: ${remoteCall}`);
  }
});

await test("CLV-318 the audit first removes the folders and the work trees of earlier audits whose process ended", async () => {
  const trees = [
    "/tmp/cloving-audit-7-a1b2c3/tree",
    "/tmp/cloving-audit-41-d4e5f6/tree",
    "/tmp/cloving-audit-0-g7h8i9/tree",
    "/tmp/cloving-audit-8-j1k2l3/other",
    "/work/cloving-audit-9-m4n5o6/tree",
    "/work/project",
  ];
  const machine = system(
    {
      [listCall]: ended(
        trees
          .map((tree) => `worktree ${tree}\nHEAD 4f3c2a1b\ndetached\n`)
          .join("\n"),
      ),
    },
    [
      "cloving-audit-7-a1b2c3",
      "cloving-audit-41-d4e5f6",
      "cloving-audit-12x-p7q8r9",
      "cloving-audit-0-s1t2u3",
      "cloving-audit-v4w5x6",
      "cloving-audit-10-",
      "cloving-audit-11-y7z8a9",
      "other-17-b1c2d3",
    ],
  );
  assert.equal((await auditOutput(machine)).exitCode, 0);
  assert.deepEqual(machine.removed, [
    "cloving-audit-7-a1b2c3",
    "cloving-audit-11-y7z8a9",
  ]);
  assert.deepEqual(machine.calls.slice(0, 6), [
    "remove cloving-audit-7-a1b2c3",
    "remove cloving-audit-11-y7z8a9",
    `/work/repository: ${listCall}`,
    "/work/repository: git worktree remove --force --force /tmp/cloving-audit-7-a1b2c3/tree",
    "/work/repository: git worktree remove --force --force /work/cloving-audit-9-m4n5o6/tree",
    `/work/repository: ${remoteCall}`,
  ]);
});

await test("CLV-318 a failed removal of an abandoned work tree stops the audit before the remote", async () => {
  const machine = system({
    [listCall]: ended("worktree /tmp/cloving-audit-7-a1b2c3/tree\ndetached\n"),
    "git worktree remove --force --force /tmp/cloving-audit-7-a1b2c3/tree": {
      error: { code: 128 },
      stdout: "",
      stderr: "fatal: permission denied\n",
    },
  });
  assert.deepEqual(await auditOutput(machine), {
    stdout: "",
    stderr:
      "git worktree remove --force --force /tmp/cloving-audit-7-a1b2c3/tree failed: fatal: permission denied\n",
    exitCode: 1,
  });
  assert.equal(machine.calls.length, 2);
});

await test("CLV-318 a rejected command gives its exit code, its output and its error text", () => {
  assert.deepEqual(
    commandFailure(
      Object.assign(new Error("Command failed: npm ci"), {
        code: 1,
        stdout: "partial",
        stderr: "npm error lock file mismatch\n",
      }),
    ),
    {
      error: { code: 1 },
      stdout: "partial",
      stderr: "npm error lock file mismatch\n",
    },
  );
  assert.deepEqual(
    commandFailure(
      Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }),
    ),
    { error: { code: "ENOENT" }, stdout: "", stderr: "spawn npm ENOENT" },
  );
  assert.deepEqual(commandFailure("stopped"), {
    error: { code: undefined },
    stdout: "",
    stderr: "stopped",
  });
});
