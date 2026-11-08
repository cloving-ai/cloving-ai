import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandFailure,
  scanOutput,
  type CommandCall,
  type CommandEnd,
} from "../templates/docs-drift/docs-drift/docs-scan.mts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "@@ -1 +1 @@",
  '+const key = "queue.seconds";',
].join("\n");

function system(outputs: Readonly<Record<string, CommandEnd | string>>) {
  const calls: CommandCall[] = [];
  const answers: Record<string, CommandEnd | string> = Object.assign(
    {
      "ls-remote": "ref: refs/heads/main\tHEAD\n0000\tHEAD\n",
      fetch: "",
      "rev-parse": `${commit}\n`,
      "ls-tree": "README.md\0AGENTS.md\0src/a.ts\0",
      "hash-object": "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n",
      diff,
      show: "Set `queue.seconds`.\n",
      api: "[[]]",
    },
    outputs,
  );
  return {
    calls,
    scan: {
      repository: "/repository",
      commandArguments: ["/login", "/record.json", "*.md"],
      read: () => Promise.resolve(null),
      run: (call: CommandCall) => {
        calls.push(call);
        const answer = answers[call.args[0] ?? ""] ?? "";
        return Promise.resolve(
          typeof answer === "string"
            ? { error: null, stdout: answer, stderr: "" }
            : answer,
        );
      },
    },
  };
}

await test("CLV-317 a remote with no default branch stops docs-candidates with a clear message", async () => {
  const fake = system({ "ls-remote": "0000\tHEAD\n" });
  assert.deepEqual(await scanOutput(fake.scan), {
    stdout: "",
    stderr: "The remote origin names no default branch.\n",
    exitCode: 1,
  });
});

await test("CLV-317 a gh report that is not a list of pages stops docs-candidates", async () => {
  for (const api of ["{}", "not json"]) {
    const result = await scanOutput(system({ api }).scan);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "gh printed an unexpected report.\n");
  }
});

await test("CLV-317 docs-candidates ignores pages and issues that have no title", async () => {
  const fake = system({
    api: JSON.stringify([{}, [7, null, { number: 3 }, { title: 9 }]]),
  });
  const result = await scanOutput(fake.scan);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    commit,
    candidates: [
      { doc: "AGENTS.md", since: null, code: ["src/a.ts"], codeCount: 1 },
      { doc: "README.md", since: null, code: ["src/a.ts"], codeCount: 1 },
    ],
    more: 0,
  });
  assert.equal(fake.calls.filter((call) => call.args[0] === "diff").length, 1);
  for (const call of fake.calls)
    assert.deepEqual(call.environment, { GH_CONFIG_DIR: "/login" });
});

await test("CLV-317 a failed git call with no error text names its exit code", async () => {
  const fake = system({
    fetch: { error: { code: 128 }, stdout: "", stderr: "" },
  });
  const result = await scanOutput(fake.scan);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^git fetch .+ failed: exit code 128\n$/);
});

await test("CLV-317 commandFailure keeps the code, the output and the error text of a failed process", () => {
  assert.deepEqual(commandFailure("boom"), {
    error: { code: undefined },
    stdout: "",
    stderr: "boom",
  });
  assert.deepEqual(
    commandFailure(
      Object.assign(new Error("Command failed: git"), {
        code: 1,
        stdout: "out",
        stderr: "",
      }),
    ),
    { error: { code: 1 }, stdout: "out", stderr: "Command failed: git" },
  );
  assert.deepEqual(
    commandFailure({ code: 2, stdout: 3, stderr: "fatal: no" }),
    { error: { code: 2 }, stdout: "", stderr: "fatal: no" },
  );
});
