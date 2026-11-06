import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTurn, type TurnStart } from "../src/daemon/claude-turn.ts";

const names = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
const script = `
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const folder = process.env.GH_CONFIG_DIR;
const names = ${JSON.stringify(names)};
const result = { folder, entries: folder ? readdirSync(folder) : null, tokens: names.filter((name) => name in process.env) };
if (folder) writeFileSync(join(folder, "hosts.yml"), "left over from a turn");
const message = process.argv[1] === "gemini"
  ? { type: "message", role: "assistant", content: JSON.stringify(result) }
  : process.argv[1] === "codex"
  ? { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }
  : { type: "result", result: JSON.stringify(result) };
process.stdout.write(JSON.stringify(message) + "\\n");
process.stdout.write(JSON.stringify({ type: process.argv[1] === "gemini" ? "result" : "turn.completed", status: "success" }) + "\\n");
`;

await test("CLV-075 CLV-083 each Claude, Codex and Gemini turn starts with empty gh configuration and no GitHub tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-turn-env-"));
  const saved = { ...process.env };
  try {
    const config = join(directory, "original");
    mkdirSync(config);
    writeFileSync(join(config, "hosts.yml"), "operator credential");
    process.env["GH_CONFIG_DIR"] = config;
    for (const name of names) process.env[name] = "test-credential";
    for (const worker of [
      "claude",
      "claude",
      "codex",
      "codex",
      "gemini",
      "gemini",
    ] as const) {
      const running = startTurn({
        worker,
        command: [
          process.execPath,
          "--input-type=module",
          "-e",
          script,
          worker,
        ],
        directory,
        folder: directory,
        prompt: "Research",
      });
      const ended = await running.ended;
      assert.equal(ended.exitCode, 0);
      const result: unknown = JSON.parse(String(ended.result?.text));
      assert.ok(typeof result === "object" && result !== null);
      assert.deepEqual(Reflect.get(result, "tokens"), []);
      assert.deepEqual(Reflect.get(result, "entries"), []);
      const folder: unknown = Reflect.get(result, "folder");
      assert.ok(typeof folder === "string");
      assert.notEqual(folder, config);
      assert.equal(existsSync(folder), false);
    }
    assert.equal(existsSync(join(config, "hosts.yml")), true);
  } finally {
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("CLV-075 removes temporary gh configuration after failed and stopped turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-turn-cleanup-"));
  try {
    const commands = [
      [join(directory, "absent-command")],
      [process.execPath, "-e", "process.exit(1)"],
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    ];
    for (const command of commands) {
      const running = startTurn({
        command,
        directory,
        folder: directory,
        prompt: "Research",
      });
      assert.equal(
        readdirSync(directory).filter((name) => name.startsWith("gh-config-"))
          .length,
        1,
      );
      if (command === commands[2]) running.stop(0);
      await running.ended;
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.startsWith("gh-config-")),
        [],
      );
    }
    assert.throws(() =>
      startTurn({
        command: [],
        directory,
        folder: directory,
        prompt: "Research",
      }),
    );
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith("gh-config-")),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  await test(`CLV-210 ${shell} startup cannot restore GitHub credentials to shell turns`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "cloving-shell-env-"));
    try {
      const config = join(directory, "operator config");
      mkdirSync(config);
      writeFileSync(join(config, "hosts.yml"), "operator credential");
      const startup = `
export ${names.map((name) => `${name}=startup-credential`).join(" ")}
export GH_CONFIG_DIR="${config}"
turn_worker() { "$@"; }
alias turn_alias='turn_worker'
`;
      writeFileSync(join(directory, ".bash_profile"), startup);
      writeFileSync(join(directory, ".zshrc"), startup);
      for (const worker of ["claude", "codex", "gemini"] as const) {
        for (const prefix of [[], ["turn_worker"], ["turn_alias"]]) {
          const running = startTurn({
            worker,
            shell,
            command: [
              ...prefix,
              process.execPath,
              "--input-type=module",
              "-e",
              script,
              worker,
            ],
            environment: { HOME: directory, ZDOTDIR: directory },
            directory,
            folder: directory,
            prompt: "Research",
          });
          const ended = await running.ended;
          assert.equal(ended.exitCode, 0);
          const result: unknown = JSON.parse(String(ended.result?.text));
          assert.ok(typeof result === "object" && result !== null);
          assert.deepEqual(Reflect.get(result, "tokens"), []);
          assert.deepEqual(Reflect.get(result, "entries"), []);
          const folder: unknown = Reflect.get(result, "folder");
          assert.ok(typeof folder === "string");
          assert.ok(folder.startsWith(join(directory, "gh-config-")));
          assert.equal(existsSync(folder), false);
        }
      }
      assert.equal(existsSync(join(config, "hosts.yml")), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

const probe = `
const names = JSON.parse(process.argv[2]);
const found = names.filter((name) => name in process.env);
const message = process.argv[1] === "codex"
  ? { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(found) } }
  : { type: "result", result: JSON.stringify(found) };
process.stdout.write(JSON.stringify(message) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", status: "success" }) + "\\n");
`;
const probed = [
  "SECRET_TEST_VALUE",
  "PROJECT_TEST_VALUE",
  "PROFILE_TEST_VALUE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "PATH",
  "HOME",
  "GH_TOKEN",
];

async function presentNames(
  directory: string,
  start: Pick<TurnStart, "variables" | "environment"> & {
    readonly worker: "claude" | "codex";
  },
): Promise<unknown> {
  const running = startTurn({
    ...start,
    command: [
      process.execPath,
      "--input-type=module",
      "-e",
      probe,
      start.worker,
      JSON.stringify(probed),
    ],
    directory,
    folder: directory,
    prompt: "Research",
  });
  const ended = await running.ended;
  assert.equal(ended.exitCode, 0);
  return JSON.parse(String(ended.result?.text));
}

await test("CLV-310 a turn gets only the base list, its harness login, the profile values and the listed variables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-turn-allow-"));
  const saved = { ...process.env };
  try {
    process.env["SECRET_TEST_VALUE"] = "operator secret";
    process.env["PROJECT_TEST_VALUE"] = "project value";
    process.env["ANTHROPIC_API_KEY"] = "claude login";
    process.env["OPENAI_API_KEY"] = "codex login";
    process.env["GH_TOKEN"] = "test-credential";
    process.env["HOME"] = directory;
    assert.deepEqual(await presentNames(directory, { worker: "claude" }), [
      "ANTHROPIC_API_KEY",
      "PATH",
      "HOME",
    ]);
    assert.deepEqual(
      await presentNames(directory, {
        worker: "codex",
        variables: ["PROJECT_TEST_VALUE", "GH_TOKEN"],
        environment: { PROFILE_TEST_VALUE: "profile value" },
      }),
      [
        "PROJECT_TEST_VALUE",
        "PROFILE_TEST_VALUE",
        "OPENAI_API_KEY",
        "PATH",
        "HOME",
      ],
    );
  } finally {
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("CLV-310 the value inherit gives a turn the whole daemon environment without GitHub tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-turn-inherit-"));
  const saved = { ...process.env };
  try {
    process.env["SECRET_TEST_VALUE"] = "operator secret";
    process.env["PROJECT_TEST_VALUE"] = "project value";
    process.env["ANTHROPIC_API_KEY"] = "claude login";
    process.env["OPENAI_API_KEY"] = "codex login";
    process.env["GH_TOKEN"] = "test-credential";
    process.env["HOME"] = directory;
    assert.deepEqual(
      await presentNames(directory, { worker: "codex", variables: "inherit" }),
      [
        "SECRET_TEST_VALUE",
        "PROJECT_TEST_VALUE",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "PATH",
        "HOME",
      ],
    );
  } finally {
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});
