import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertVerifierInstallation,
  installVerifier,
} from "../../quality/verifier-installation.ts";
import { snapshotTree } from "../../quality/tree-snapshot.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-09 installation requires the controller's reviewed tree identity", async () => {
  await withFiles(
    { "proposal/check.ts": "export const limit = 400;" },
    async (root) => {
      const proposal = join(root, "proposal");
      const accepted = await snapshotTree(proposal);
      await writeFile(join(proposal, "check.ts"), "export const limit = 1000;");
      await assert.rejects(
        installVerifier(proposal, join(root, "installed"), accepted.identity),
        /unreviewed-verifier-inputs/,
      );
      await assert.rejects(access(join(root, "installed")), /ENOENT/);
    },
  );
});

await test("QG-09 installed verifier bytes remain separate from later proposal changes", async () => {
  await withFiles(
    { "proposal/check.ts": "export const limit = 400;" },
    async (root) => {
      const proposal = join(root, "proposal");
      const accepted = await snapshotTree(proposal);
      const installed = await installVerifier(
        proposal,
        join(root, "installed"),
        accepted.identity,
      );
      await writeFile(join(proposal, "check.ts"), "export const limit = 1000;");
      assert.equal(
        await readFile(join(installed.directory, "check.ts"), "utf8"),
        "export const limit = 400;",
      );
      await assertVerifierInstallation(installed);
      await writeFile(
        join(installed.directory, "check.ts"),
        "export const limit = 0;",
      );
      await assert.rejects(
        assertVerifierInstallation(installed),
        /verifier-installation-changed/,
      );
    },
  );
});

await test("QG-09 installation preserves existing destinations and rejects candidate-contained paths", async () => {
  await withFiles(
    {
      "proposal/check.ts": "export const limit = 400;",
      "existing/kept": "preserved",
    },
    async (root) => {
      const proposal = join(root, "proposal");
      const accepted = await snapshotTree(proposal);
      await assert.rejects(
        installVerifier(
          proposal,
          join(proposal, "installed"),
          accepted.identity,
        ),
        /overlapping-staging-paths/,
      );
      await assert.rejects(
        installVerifier(proposal, join(root, "existing"), accepted.identity),
        /EEXIST/,
      );
      assert.equal(
        await readFile(join(root, "existing/kept"), "utf8"),
        "preserved",
      );
    },
  );
});
