import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectResources } from "../src/resource-files.ts";

await test("CLV-005 discovery digests only regular resources inside the workflow root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-resources-"));
  try {
    const root = join(directory, "root");
    await mkdir(join(root, "prompts", "folder"), { recursive: true });
    await mkdir(join(directory, "outside"));
    await writeFile(join(root, "prompts", "implement.md"), "implement");
    await writeFile(join(directory, "outside", "secret.md"), "secret");
    await symlink(
      join(directory, "outside", "secret.md"),
      join(root, "prompts", "escape.md"),
    );
    await symlink("implement.md", join(root, "prompts", "alias.md"));
    await writeFile(join(root, "prompts", "locked.md"), "locked");
    await chmod(join(root, "prompts", "locked.md"), 0o000);
    const digest = createHash("sha256").update("implement").digest("hex");
    assert.deepEqual(
      await collectResources(root, [
        "prompts/implement.md",
        "prompts/alias.md",
        "prompts/escape.md",
        "../outside/secret.md",
        join(directory, "outside", "secret.md"),
        "prompts/folder",
        "prompts/missing.md",
        "prompts/locked.md",
      ]),
      { "prompts/implement.md": digest, "prompts/alias.md": digest },
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
