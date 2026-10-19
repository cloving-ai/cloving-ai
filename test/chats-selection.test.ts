import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import filesystem, { mkdir, symlink, chmod } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { selectChatSources } from "../src/chats/selection.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { withLargeScanMetadata } from "./chats-selection-fixture.ts";

await test("CLV-111 parses root-only and mixed literal selections", () => {
  for (const paths of [[], ["--root", "--exclude-project", "--help"]]) {
    assert.deepEqual(
      parseInvocation([
        "chats",
        "import",
        "--root",
        "B",
        "--exclude-project",
        "keep.case",
        "--root",
        "A",
        "--",
        ...paths,
      ]),
      {
        kind: "chats-import",
        paths,
        roots: ["B", "A"],
        excludeProjects: ["keep.case"],
      },
    );
  }
  assert.deepEqual(
    parseInvocation(["chats", "import", "a", "a", "--root", "A"]),
    {
      kind: "chats-import",
      paths: ["a", "a"],
      roots: ["A"],
      excludeProjects: [],
    },
  );
});

await test("CLV-111 rejects incomplete, unsafe and unselected scan options", () => {
  for (const args of [
    ["--root"],
    ["--root", ""],
    ["--root", "--"],
    ["--exclude-project"],
    ["--exclude-project", "a"],
    ["--root", "A", "--exclude-project", ""],
    ...[".", "..", "a/b", "a\\b", "../a", "*", "[ab]"].map((name) => [
      "--root",
      "A",
      "--exclude-project",
      name,
    ]),
    ["--root", "A", "--unknown"],
  ])
    assert.equal(
      parseInvocation(["chats", "import", ...args]).kind,
      "usage-error",
    );
});

await test(
  "CLV-111 sorts metadata before reading and prunes exact project exclusions",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "A/keep/a.jsonl": "",
        "A/skip/sentinel": "",
        "A/Other/b.jsonl": "",
        "B/keep/b.jsonl": "",
      },
      async (directory) => {
        const original = filesystem.readdir;
        const listed: string[] = [];
        Object.defineProperty(filesystem, "readdir", {
          configurable: true,
          value: async (path: string) => {
            listed.push(path);
            const entries = await original(path, { withFileTypes: true });
            return entries.reverse();
          },
        });
        syncBuiltinESMExports();
        try {
          const result = await selectChatSources({
            paths: ["same", "same"],
            roots: ["B", "A", "A"],
            excludeProjects: ["skip"],
            workingDirectory: directory,
          });
          assert.deepEqual(
            result.roots,
            ["A", "A", "B"].map((path) => join(directory, path)),
          );
          assert.deepEqual(
            result.entries.map((entry) =>
              entry.path.slice(directory.length + 1),
            ),
            [
              "same",
              "same",
              "A/Other/b.jsonl",
              "A/keep/a.jsonl",
              "A/skip",
              "A/Other/b.jsonl",
              "A/keep/a.jsonl",
              "A/skip",
              "B/keep/b.jsonl",
            ],
          );
          assert.ok(listed.every((path) => !path.includes("/skip")));
          assert.deepEqual(result.entries[4]?.outcome, {
            status: "excluded",
            reason: "project-excluded",
          });
        } finally {
          filesystem.readdir = original;
          syncBuiltinESMExports();
        }
      },
    );
  }),
);

await test(
  "CLV-111 preserves case in project exclusions",
  chatPlatformScenario(async () => {
    await withFiles({ "A/skip/sentinel.jsonl": "" }, async (directory) => {
      const result = await selectChatSources({
        paths: [],
        roots: ["A"],
        excludeProjects: ["SKIP"],
        workingDirectory: directory,
      });
      assert.equal(
        result.entries[0]?.path,
        join(directory, "A/skip/sentinel.jsonl"),
      );
      assert.equal(result.entries[0].outcome, undefined);
    });
  }),
);

await test(
  "CLV-111 orders roots by canonical spelling on the supported filesystem",
  chatPlatformScenario(async () => {
    await withFiles(
      { "A/project/a.jsonl": "", "B/project/b.jsonl": "" },
      async (directory) => {
        const result = await selectChatSources({
          paths: [],
          roots: [
            existsSync(join(directory, "b")) ? "b" : "B",
            existsSync(join(directory, "a")) ? "a" : "A",
          ],
          workingDirectory: directory,
        });
        assert.deepEqual(result.roots, [
          join(directory, "A"),
          join(directory, "B"),
        ]);
        assert.deepEqual(
          result.entries.map((entry) => entry.outcome),
          [undefined, undefined],
        );
      },
    );
  }),
);

await test(
  "CLV-111 refuses roots in repositories and links in roots or ancestors",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "repo/.git": "gitdir: synthetic",
        "repo/projects/a.jsonl": "",
        "outside/a.jsonl": "",
      },
      async (directory) => {
        await symlink(join(directory, "outside"), join(directory, "alias"));
        await mkdir(join(directory, "outside/projects"));
        const result = await selectChatSources({
          paths: [],
          roots: ["repo", "repo/projects", "alias", "alias/projects"],
          excludeProjects: [],
          workingDirectory: directory,
        });
        assert.deepEqual(
          result.entries.map((entry) => [entry.kind, entry.outcome?.reason]),
          [
            ["subtree", "symbolic-link"],
            ["subtree", "symbolic-link"],
            ["subtree", "repository-root"],
            ["subtree", "repository-root"],
          ],
        );
      },
    );
  }),
);

await test(
  "CLV-111 refuses bare repository roots and their descendants using metadata",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "bare/HEAD": "ref: refs/heads/main",
        "bare/objects/sentinel": "",
        "bare/refs/heads/sentinel": "",
        "bare/projects/sentinel.jsonl": "",
      },
      async (directory) => {
        const result = await selectChatSources({
          paths: [],
          roots: ["bare", "bare/projects"],
          workingDirectory: directory,
        });
        assert.deepEqual(
          result.entries.map((entry) => [entry.kind, entry.outcome?.reason]),
          [
            ["subtree", "repository-root"],
            ["subtree", "repository-root"],
          ],
        );
      },
    );
  }),
);

await test(
  "CLV-111 selects lowercase JSONL and stops before entering depth-four folders",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "A/project/session.jsonl": "",
        "A/project/upper.JSONL": "",
        "A/project/session/subagents/agent.jsonl": "",
        "A/project/session/subagents/deeper/sentinel.jsonl": "",
        "A/project/other.txt": "",
      },
      async (directory) => {
        const result = await selectChatSources({
          paths: [],
          roots: ["A"],
          workingDirectory: directory,
        });
        assert.deepEqual(
          result.entries.map((entry) => [
            entry.path.slice(directory.length + 1),
            entry.outcome?.reason,
          ]),
          [
            ["A/project/other.txt", "unsupported-extension"],
            ["A/project/session.jsonl", undefined],
            ["A/project/session/subagents/agent.jsonl", undefined],
            ["A/project/session/subagents/deeper", "depth-limit"],
            ["A/project/upper.JSONL", "unsupported-extension"],
          ],
        );
        assert.equal(result.entries[3]?.kind, "subtree");
        assert.equal(result.entries[3].outcome?.status, "pending");
      },
    );
  }),
);

await test(
  "CLV-111 budgets candidates 100 and 101 after ordering all roots and repetitions",
  chatPlatformScenario(async () => {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        `A/project/${String(index).padStart(3, "0")}.jsonl`,
        "invalid",
      ]),
    );
    await withFiles(
      { ...files, "B/project/last.jsonl": "", "A/project/skipped.txt": "" },
      async (directory) => {
        const result = await selectChatSources({
          paths: ["B/project/last.jsonl"],
          roots: ["B", "A", "A"],
          workingDirectory: directory,
        });
        const candidates = result.entries.filter((entry) =>
          entry.path.endsWith(".jsonl"),
        );
        assert.equal(candidates.length, 122);
        assert.equal(candidates[100]?.outcome, undefined);
        assert.deepEqual(candidates[101]?.outcome, {
          status: "pending",
          reason: "file-limit",
        });
        assert.equal(
          candidates.filter((entry) => entry.outcome?.status === "pending")
            .length,
          21,
        );
        assert.deepEqual(candidates[100]?.selection, {
          kind: "root",
          index: 1,
        });
      },
    );
  }),
);

await test(
  "CLV-111 reports inaccessible directories and entries without descendant inventory",
  chatPlatformScenario(async () => {
    await withFiles(
      { "root/project/sentinel.jsonl": "", "root/ok.jsonl": "" },
      async (directory) => {
        await chmod(join(directory, "root/project"), 0);
        try {
          const result = await selectChatSources({
            paths: [],
            roots: ["root", "missing", "root/ok.jsonl"],
            workingDirectory: directory,
          });
          assert.deepEqual(
            result.entries.map((entry) => entry.outcome?.reason),
            [
              "source-unreadable",
              undefined,
              "source-unreadable",
              "non-directory-root",
            ],
          );
          assert.ok(
            result.entries.every(
              (entry) => !entry.path.endsWith("sentinel.jsonl"),
            ),
          );
        } finally {
          await chmod(join(directory, "root/project"), 0o700);
        }
      },
    );
  }),
);

for (const root of ["root/project", "root"]) {
  await test(
    `CLV-111 retains large scans selected at ${root} and applies the file budget`,
    chatPlatformScenario(async () => {
      await withFiles(
        { "root/project/source.jsonl": "" },
        async (directory) => {
          await withLargeScanMetadata(directory, async (names) => {
            const result = await selectChatSources({
              paths: [],
              roots: [root],
              workingDirectory: directory,
            });
            assert.equal(result.entries.length, names.length);
            assert.deepEqual(
              result.entries.map((entry) => entry.path),
              names.map((name) => join(directory, "root/project", name)),
            );
            assert.equal(
              result.entries.filter((entry) => entry.outcome === undefined)
                .length,
              100,
            );
            for (const entry of result.entries.slice(100))
              assert.deepEqual(entry.outcome, {
                status: "pending",
                reason: "file-limit",
              });
          });
        },
      );
    }),
  );
}
