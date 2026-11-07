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

function system(answers: Readonly<Record<string, CommandEnd | string>> = {}): {
  readonly calls: string[];
  readonly environments: string[];
  readonly run: (call: CommandCall) => Promise<CommandEnd>;
  readonly repository: string;
  readonly folder: string;
  readonly commandArguments: readonly string[];
} {
  const calls: string[] = [];
  const environments: string[] = [];
  const defaults: Readonly<Record<string, CommandEnd>> = {
    "git symbolic-ref --short refs/remotes/origin/HEAD":
      ended("origin/trunk\n"),
    "npm audit --json": ended(JSON.stringify(threeSeverities), 1),
    "npm ls --all --json": ended(JSON.stringify(installTree), 1),
    [issuesCall]: ended(JSON.stringify([[]])),
  };
  return {
    calls,
    environments,
    repository: "/work/repository",
    folder: "/work/audit",
    commandArguments: ["/work/github"],
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
    "/work/repository: git symbolic-ref --short refs/remotes/origin/HEAD",
    "/work/repository: git fetch --quiet origin trunk",
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
    const machine = { ...system(), commandArguments };
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
    "git fetch --quiet origin trunk": {
      error: { code: 128 },
      stdout: "",
      stderr: "fatal: unable to access the remote\n",
    },
  });
  assert.deepEqual(await auditOutput(machine), {
    stdout: "",
    stderr:
      "git fetch --quiet origin trunk failed: fatal: unable to access the remote\n",
    exitCode: 1,
  });
  assert.equal(machine.calls.length, 2);
  assert.deepEqual(
    await auditOutput(
      system({
        "git symbolic-ref --short refs/remotes/origin/HEAD": "spawn git ENOENT",
      }),
    ),
    { stdout: "", stderr: "spawn git ENOENT\n", exitCode: 1 },
  );
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
