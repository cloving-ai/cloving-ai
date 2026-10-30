import assert from "node:assert/strict";
import { chmod, mkdir, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { initPromptFacts } from "../src/cli/init-prompt-command.ts";
import { initPrompt } from "../src/cli/init-prompt.ts";
import type { ProbeOutput, ProbeRunner } from "../src/cli/probe-command.ts";
import { withFiles } from "./quality/files-fixture.ts";

function probe(
  outputs: Readonly<Record<string, ProbeOutput>> = {},
): ProbeRunner {
  return (_program, options) => {
    const tool = options.arguments[0]?.includes("template-command")
      ? "template"
      : "workflow";
    if (options.arguments[0]?.includes("-command"))
      return Promise.resolve(outputs[tool] ?? { stdout: "[]", reason: null });
    return Promise.resolve({ stdout: "", reason: "fixture-unavailable" });
  };
}

function originProbe(origin: string, commands: string[][]): ProbeRunner {
  const fallback = probe();
  return (program, options) => {
    if (program === "git")
      return Promise.resolve({ stdout: origin, reason: null });
    if (program === "gh") {
      commands.push([...options.arguments]);
      return Promise.resolve({ stdout: "repository-user\n", reason: null });
    }
    return fallback(program, options);
  };
}

await test("CLV-226 setup facts inventory Claude Code without reading chat contents", () =>
  withFiles(
    {
      ".claude/projects/example/first.jsonl": "private first chat",
      ".claude/projects/example/nested/second.jsonl": "private second chat",
    },
    async (repository) => {
      const first = join(repository, ".claude/projects/example/first.jsonl");
      const second = join(
        repository,
        ".claude/projects/example/nested/second.jsonl",
      );
      await utimes(first, new Date("2025-01-01Z"), new Date("2025-01-01Z"));
      await utimes(second, new Date("2026-01-01Z"), new Date("2026-01-01Z"));
      await chmod(first, 0);
      await chmod(second, 0);
      const facts = await initPromptFacts({
        repository,
        environment: { HOME: repository, PATH: "" },
        probe: probe(),
      });
      assert.deepEqual(facts.chatStores, [
        {
          name: "Claude Code",
          path: join(repository, ".claude/projects"),
          format: "JSONL",
          documentation: "https://code.claude.com/docs/en/claude-directory",
          fileCount: 2,
          totalBytes: 37,
          oldestFileDate: "2025-01-01T00:00:00.000Z",
          newestFileDate: "2026-01-01T00:00:00.000Z",
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(facts),
        /private first chat|private second chat/,
      );
    },
  ));

await test("CLV-225 failed fact probes remain unavailable and omit private settings", () =>
  withFiles({}, async (repository) => {
    const facts = await initPromptFacts({
      repository,
      environment: { HOME: repository, PATH: "" },
      probe: probe(),
    });
    assert.equal(facts.origin, "unavailable");
    assert.equal(facts.login, "unavailable");
    assert.deepEqual(facts.templates, []);
    assert.deepEqual(facts.workflows, []);
    assert.deepEqual(facts.chatStores, []);
  }));

await test("CLV-226 an unreadable chat directory does not block setup or other stores", () =>
  withFiles(
    {
      ".claude/projects/private/session.jsonl": "private chat",
      ".codex/sessions/rollout.jsonl.zst": "compressed fixture",
    },
    async (repository) => {
      const folder = join(repository, ".claude/projects/private");
      await chmod(folder, 0);
      try {
        const facts = await initPromptFacts({
          repository,
          environment: { HOME: repository, PATH: "" },
          probe: probe(),
        });
        assert.deepEqual(facts.chatStores[0], {
          name: "Claude Code",
          path: join(repository, ".claude/projects"),
          format: "JSONL",
          documentation: "https://code.claude.com/docs/en/claude-directory",
          unavailable: "EACCES",
          fileCount: null,
          totalBytes: null,
          oldestFileDate: null,
          newestFileDate: null,
        });
        assert.equal(facts.chatStores[1]?.name, "Codex");
        assert.equal(facts.chatStores[1].fileCount, 1);
        assert.equal(facts.chatStores[1].totalBytes, 18);
        assert.match(initPrompt(facts), /# Steps\n/);
        assert.doesNotMatch(JSON.stringify(facts), /private chat/);
      } finally {
        await chmod(folder, 0o700);
      }
    },
  ));

await test("CLV-226 each known store reports recursive file metadata and a documented format", () =>
  withFiles(
    {
      ".codex/sessions/2026/rollout.jsonl.zst": "compressed fixture",
      ".gemini/tmp/project/chats/session.json": "gemini fixture",
      ".local/share/opencode/opencode.db": "database fixture",
      ".grok/sessions/project/id/updates.jsonl": "grok fixture",
      ".cursor/projects/project/agent-transcripts/session.jsonl":
        "cursor fixture",
      "elsewhere/private.jsonl": "excluded fixture",
    },
    async (repository) => {
      await mkdir(join(repository, ".claude/projects/empty"), {
        recursive: true,
      });
      await symlink(
        join(repository, "elsewhere"),
        join(repository, ".codex/sessions/linked"),
      );
      const facts = await initPromptFacts({
        repository,
        environment: { HOME: repository, PATH: "" },
        probe: probe(),
      });
      const stores = facts.chatStores;
      assert.deepEqual(
        stores.map(({ name, fileCount, totalBytes }) => ({
          name,
          fileCount,
          totalBytes,
        })),
        [
          { name: "Claude Code", fileCount: 0, totalBytes: 0 },
          { name: "Codex", fileCount: 1, totalBytes: 18 },
          { name: "Gemini CLI", fileCount: 1, totalBytes: 14 },
          { name: "opencode", fileCount: 1, totalBytes: 16 },
          { name: "grok", fileCount: 1, totalBytes: 12 },
          { name: "Cursor Agent", fileCount: 1, totalBytes: 14 },
        ],
      );
      assert.equal(stores[0]?.oldestFileDate, null);
      assert.equal(stores[0].newestFileDate, null);
      for (const store of stores.slice(1)) {
        assert.ok(store.path.startsWith(repository));
        assert.match(store.documentation, /^https:\/\//);
        assert.match(store.format, /JSON|SQLite/);
        assert.match(store.oldestFileDate ?? "", /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(store.newestFileDate, store.oldestFileDate);
      }
      assert.match(stores[1]?.format ?? "", /zstd -dc/);
      assert.match(stores[4]?.format ?? "", /updates\.jsonl/);
      assert.equal(
        stores[4]?.documentation,
        "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md",
      );
    },
  ));

await test("CLV-225 invalid or failed listing results cannot become setup facts", () =>
  withFiles({}, async (repository) => {
    for (const output of [
      { stdout: "[]", reason: "probe-timeout" },
      { stdout: "{}", reason: null },
      { stdout: "[null]", reason: null },
      {
        stdout: '[{"scope":5,"workflowId":"custom","file":"workflow.ts"}]',
        reason: null,
      },
    ]) {
      await assert.rejects(
        initPromptFacts({
          repository,
          environment: { HOME: repository, PATH: "" },
          probe: probe({ workflow: output }),
        }),
        /workflow-inspection/,
      );
    }
  }));

await test("CLV-225 a missing repository gives a clear prerequisite", async () => {
  await assert.rejects(
    initPromptFacts({ repository: undefined, environment: {}, probe: probe() }),
    /repository-unknown/,
  );
});

await test("CLV-225 login uses the origin host despite a different GH_HOST", () =>
  withFiles({}, async (repository) => {
    for (const [origin, host] of [
      ["git@github.example.com:example/project.git", "github.example.com"],
      ["https://github.example.com/example/project.git", "github.example.com"],
      ["git@github.com:example/project.git", "github.com"],
    ] as const) {
      const commands: string[][] = [];
      const facts = await initPromptFacts({
        repository,
        environment: {
          HOME: repository,
          PATH: "",
          GH_HOST: "other.example.com",
        },
        probe: originProbe(origin, commands),
      });
      assert.deepEqual(commands, [
        ["api", "user", "--hostname", host, "--jq", ".login"],
      ]);
      assert.equal(facts.origin, origin);
      assert.equal(facts.login, "repository-user");
    }
  }));
