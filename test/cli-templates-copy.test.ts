import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cliOptions, entry } from "./cli-workflows-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { record } from "../src/protocol.ts";
import {
  readyIssue,
  runScript,
  writeFakeGithub,
} from "./develop-ticket-scripts-fixture.ts";
import {
  filesBelow,
  repository,
  templateFiles,
  listed,
  templates,
} from "./cli-templates-fixture.ts";

for (const present of [
  "develop.ts",
  "develop/turn.ts",
  "develop.declaration.json",
])
  await test(`CLV-223 templates copy over an existing ${present} leaves only the files that were present`, () =>
    withFiles(
      { ...repository, [`repo/.cloving/workflows/${present}`]: "changed" },
      async (root) => {
        const folder = join(root, "repo/.cloving/workflows");
        const again = templates(root, ["copy", "develop"]);
        assert.equal(again.status, 1);
        assert.match(again.stderr, /workflow-exists/);
        assert.deepEqual(await filesBelow(folder), [present]);
        assert.equal(await readFile(join(folder, present), "utf8"), "changed");
      },
    ));

await test("CLV-223 templates copy over a complete copy changes no file", () =>
  withFiles(repository, async (root) => {
    assert.equal(templates(root, ["copy", "develop"]).status, 0);
    const folder = join(root, "repo/.cloving/workflows");
    await writeFile(join(folder, "develop.ts"), "changed");
    const before = await filesBelow(folder);
    const again = templates(root, ["copy", "develop"]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /workflow-exists/);
    assert.deepEqual(await filesBelow(folder), before);
    assert.equal(await readFile(join(folder, "develop.ts"), "utf8"), "changed");
  }));

await test("CLV-223 two copies at the same time leave one complete copy", () =>
  withFiles(repository, async (root) => {
    const run = () =>
      new Promise<{ status: number | null; stderr: string }>((settle) => {
        const child = spawn(
          process.execPath,
          [entry, "templates", "copy", "develop"],
          cliOptions(root),
        );
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += String(chunk);
        });
        child.once("close", (status) => {
          settle({ status, stderr });
        });
      });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [0, 1],
      JSON.stringify(results),
    );
    assert.match(
      results.find((result) => result.status === 1)?.stderr ?? "",
      /workflow-exists/,
    );
    const expected = await templateFiles();
    assert.deepEqual(
      await filesBelow(join(root, "repo/.cloving/workflows")),
      expected,
    );
  }));

await test("CLV-223 templates copy prints JSON and ignores unreadable declarations", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/broken.declaration.json": "{",
      "repo/.cloving/workflows/folder.declaration.json/.gitkeep": "",
    },
    (root) => {
      const result = templates(root, [
        "copy",
        "develop",
        "--json",
        "--repository",
        join(root, "repo"),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const printed = record(JSON.parse(result.stdout));
      assert.equal(printed?.["workflowId"], "develop");
      assert.equal(printed["template"], "develop");
      assert.deepEqual(printed["queueWorkflows"], ["develop"]);
      const files = printed["files"];
      assert.ok(Array.isArray(files) && files.includes("develop.ts"));
      assert.doesNotMatch(result.stderr, /queue-workflow-conflict/);
    },
  ));

const developDeclaration = await readFile(
  "templates/develop/develop.declaration.json",
  "utf8",
);

await test("CLV-223 copied function names avoid reserved words and names of other workflows", () =>
  withFiles(repository, async (root) => {
    const folder = join(root, "repo/.cloving/workflows");
    for (const [id, name] of [
      ["delete", "deleteWorkflow"],
      ["dev-1", "dev1"],
      ["dev1", "dev1Workflow"],
      ["develop-ticket", "developTicket"],
    ] as const) {
      const copied = templates(root, ["copy", "develop", "--id", id]);
      assert.equal(copied.status, 0, copied.stderr);
      assert.match(
        await readFile(join(folder, `${id}.ts`), "utf8"),
        new RegExp(`export async function ${name}\\(`),
        id,
      );
    }
  }));

await test("CLV-223 templates copy reads the settings before it writes a file", () =>
  withFiles(
    { ...repository, "repo/.cloving/config.json": "{" },
    async (root) => {
      const copied = templates(root, ["copy", "develop"]);
      assert.equal(copied.status, 1);
      assert.doesNotMatch(copied.stderr, /workflow-exists/);
      assert.deepEqual(await filesBelow(join(root, "repo/.cloving")), [
        "config.json",
      ]);
    },
  ));

await test("CLV-223 templates copy reports a write error with its own cause", () =>
  withFiles(
    { ...repository, "repo/.cloving/workflows/.gitkeep": "" },
    async (root) => {
      const folder = join(root, "repo/.cloving/workflows");
      await chmod(folder, 0o555);
      try {
        const copied = templates(root, ["copy", "develop"]);
        assert.equal(copied.status, 1);
        assert.doesNotMatch(copied.stderr, /workflow-exists/);
        assert.match(copied.stderr, /EACCES|permission/i);
      } finally {
        await chmod(folder, 0o755);
      }
      assert.deepEqual(await filesBelow(folder), [".gitkeep"]);
    },
  ));

await test("CLV-223 the queue warning counts only declarations that discovery admits", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/old.declaration.json":
        developDeclaration.replace(
          '"workflowId": "develop"',
          '"workflowId": "old"',
        ),
      "repo/.cloving/workflows/bad.ts": "export async function bad() {}\n",
      "repo/.cloving/workflows/bad.declaration.json": JSON.stringify({
        workflow: { workflowId: "bad", queue: true },
      }),
    },
    (root) => {
      const copied = templates(root, ["copy", "develop", "--json"]);
      assert.equal(copied.status, 0, copied.stderr);
      assert.doesNotMatch(copied.stderr, /queue-workflow-conflict/);
      assert.deepEqual(record(JSON.parse(copied.stdout))?.["queueWorkflows"], [
        "develop",
      ]);
    },
  ));

function shellWords(line: string): readonly string[] {
  const words = spawnSync("/bin/sh", ["-c", `printf '%s\\n' ${line}`], {
    encoding: "utf8",
  });
  assert.equal(words.status, 0, words.stderr);
  return words.stdout.split("\n").slice(0, -1);
}

async function assertCopiedNextTicket(
  root: string,
  script: string,
): Promise<void> {
  await writeFakeGithub(root, {
    issues: [
      readyIssue(2, { createdAt: "2026-11-02T08:00:00Z" }),
      readyIssue(3, {
        createdAt: "2026-11-01T08:00:00Z",
        body: "## Dependencies\nNeeds #2\n",
      }),
    ],
  });
  const next = runScript(script, { directory: root });
  assert.equal(next.status, 0, next.warnings.join("\n"));
  assert.equal(next.stdout, "2\n");
}

await test("CLV-363 templates copy retains the scripts without next or ready command settings", () =>
  withFiles(
    {
      ...repository,
      "it's/package.json": JSON.stringify({ type: "commonjs" }),
      "bin/.gitkeep": "",
    },
    async (root) => {
      const project = join(root, "it's");
      const folder = join(project, ".cloving/workflows");
      const copied = templates(root, [
        ...["copy", "develop", "--id", "dev2", "--repository", project],
      ]);
      assert.equal(copied.status, 0, copied.stderr);
      assert.deepEqual(
        copied.stdout
          .split("\n")
          .filter((line) => line.startsWith("  cloving config set "))
          .map(shellWords),
        [],
      );
      const printed = templates(root, [
        ...["copy", "develop", "--id", "dev3", "--repository", project],
        "--json",
      ]);
      assert.equal(printed.status, 0, printed.stderr);
      assert.deepEqual(record(JSON.parse(printed.stdout))?.["settings"], []);
      await assertCopiedNextTicket(root, join(folder, "dev2/next-ticket.mts"));
    },
  ));

await test("CLV-316 templates copy writes the time zone of the operator into a calendar schedule and keeps an interval", () =>
  withFiles(repository, async (root) => {
    const schedule = async (name: string) => {
      const copied = spawnSync(
        process.execPath,
        [entry, "templates", "copy", name],
        cliOptions(root, { environment: { TZ: "America/Los_Angeles" } }),
      );
      assert.equal(copied.status, 0, copied.stderr);
      const path = `repo/.cloving/workflows/${name}.declaration.json`;
      const value: unknown = JSON.parse(
        await readFile(join(root, path), "utf8"),
      );
      return record(record(value)?.["workflow"])?.["schedule"];
    };
    assert.deepEqual(await schedule("review-checks"), {
      at: "07:00",
      timeZone: "America/Los_Angeles",
      weekdays: ["monday"],
      input: {},
    });
    assert.deepEqual(await schedule("dependency-audit"), {
      everySeconds: 86400,
      input: {},
    });
  }));

await test("CLV-363 a copied feed avoids an exported function name and updates its test references", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/reserved.ts":
        'export async function siteDevelopFeed() { "use workflow"; return {}; }',
    },
    async (root) => {
      const result = templates(root, [
        "copy",
        "develop",
        "--id",
        "site-develop",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const folder = join(root, "repo/.cloving/workflows");
      const declaration = record(
        JSON.parse(
          await readFile(join(folder, "site-develop.declaration.json"), "utf8"),
        ),
      );
      const queue = record(record(declaration?.["workflow"])?.["queue"]);
      assert.equal(queue?.["feed"], "siteDevelopFeedWorkflow");
      assert.match(
        await readFile(join(folder, "site-develop.ts"), "utf8"),
        /export async function siteDevelopFeedWorkflow\(/,
      );
      assert.match(
        await readFile(join(folder, "site-develop/feed-tests.ts"), "utf8"),
        /import \{ siteDevelopFeedWorkflow \} from "\.\.\/site-develop.ts"/,
      );
    },
  ));

await test("CLV-363 a maximum-length workflow ID keeps its copied feed within the declaration bound", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/reserved.ts": `export async function ${"a".repeat(60)}Feed() { "use workflow"; return {}; }
export async function ${"a".repeat(56)}Workflow() { "use workflow"; return {}; }`,
    },
    async (root) => {
      const id = "a".repeat(64);
      const copied = templates(root, ["copy", "develop", "--id", id]);
      assert.equal(copied.status, 0, copied.stderr);
      const declaration = record(
        JSON.parse(
          await readFile(
            join(root, `repo/.cloving/workflows/${id}.declaration.json`),
            "utf8",
          ),
        ),
      );
      const feed = record(record(declaration?.["workflow"])?.["queue"])?.[
        "feed"
      ];
      assert.equal(typeof feed, "string");
      assert.ok(typeof feed === "string" && feed.length <= 64);
      assert.equal(
        listed(root).find((item) => item["workflowId"] === id)?.["admitted"],
        true,
      );
    },
  ));

await test("CLV-363 the default template ID also renames a feed whose name is already taken", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/reserved.ts":
        'export async function developFeed() { "use workflow"; return {}; }',
    },
    async (root) => {
      const copied = templates(root, ["copy", "develop"]);
      assert.equal(copied.status, 0, copied.stderr);
      const folder = join(root, "repo/.cloving/workflows");
      assert.match(
        await readFile(join(folder, "develop.ts"), "utf8"),
        /export async function developFeedWorkflow\(/,
      );
      assert.match(
        await readFile(join(folder, "develop/feed-tests.ts"), "utf8"),
        /import \{ developFeedWorkflow \} from "\.\.\/develop.ts"/,
      );
      assert.equal(
        listed(root).find((item) => item["workflowId"] === "develop")?.[
          "admitted"
        ],
        true,
      );
    },
  ));
