import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { executeInstalledCheck } from "../../quality/installed-check.ts";
import { installVerifier } from "../../quality/verifier-installation.ts";
import { snapshotTree } from "../../quality/tree-snapshot.ts";
import { withFiles } from "./files-fixture.ts";

const entry = `import { readFileSync } from "node:fs";
import { join } from "node:path";
const source = readFileSync(join(process.argv[2], "main.ts"), "utf8");
if (source.includes("forbidden")) { console.error("fixed-rule"); process.exit(1); }
console.log("fixed-check-completed");
`;

await test("QG-09 installed check ignores candidate and proposal replacement commands", async () => {
  await withFiles(
    {
      "proposal/tools/check-protected-quality.ts": entry,
      "candidate/main.ts": "forbidden",
      "candidate/package.json": '{"scripts":{"check":"exit 0"}}',
      "candidate/tools/check-protected-quality.ts": 'console.log("passed");',
    },
    async (root) => {
      const proposal = join(root, "proposal");
      const installed = await installVerifier(proposal, {
        directory: join(root, "installed"),
        identity: (await snapshotTree(proposal)).identity,
      });
      await writeFile(
        join(proposal, "tools/check-protected-quality.ts"),
        'console.log("passed");',
      );
      const candidate = join(root, "candidate");
      const rejected = await executeInstalledCheck(installed, {
        candidate,
        timeoutMilliseconds: 5000,
      });
      assert.equal(rejected.role, "static-analysis");
      assert.deepEqual(rejected.command, {
        id: "protected-quality",
        executable: await realpath(process.execPath),
        arguments: [
          join(installed.directory, "tools/check-protected-quality.ts"),
          await realpath(candidate),
        ],
        directory: installed.directory,
        timeoutMilliseconds: 5000,
      });
      assert.equal(rejected.execution.exit, 1);
      assert.match(rejected.execution.stderr, /fixed-rule/);
      await writeFile(join(candidate, "main.ts"), "valid");
      const accepted = await executeInstalledCheck(installed, {
        candidate,
        timeoutMilliseconds: 5000,
      });
      assert.equal(accepted.execution.exit, 0);
      assert.equal(accepted.execution.stdout, "fixed-check-completed\n");
      assert.notEqual(accepted.candidate, rejected.candidate);
      assert.equal(accepted.verifier, installed.identity);
    },
  );
});

await test("QG-10 missing installed entry and invalid deadlines fail before execution", async () => {
  await withFiles(
    { "proposal/other.ts": "export {};", "candidate/main.ts": "valid" },
    async (root) => {
      const proposal = join(root, "proposal");
      const installed = await installVerifier(proposal, {
        directory: join(root, "installed"),
        identity: (await snapshotTree(proposal)).identity,
      });
      const candidate = join(root, "candidate");
      await assert.rejects(
        executeInstalledCheck(installed, {
          candidate,
          timeoutMilliseconds: 5000,
        }),
        /ENOENT/,
      );
      await assert.rejects(
        executeInstalledCheck(installed, { candidate, timeoutMilliseconds: 0 }),
        /invalid-installed-check-timeout/,
      );
      await assert.rejects(
        executeInstalledCheck(installed, {
          candidate,
          timeoutMilliseconds: Infinity,
        }),
        /invalid-installed-check-timeout/,
      );
    },
  );
});
