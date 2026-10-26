import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

await test("CLV-208 setup requires runnable zsh and Bash before shell tests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-setup-shells-"));
  const check = (): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [resolve("tools/check-shells.ts"), directory], {
      encoding: "utf8",
    });
  try {
    const missing = check();
    assert.equal(missing.status, 1);
    assert.match(
      String(missing.stderr),
      /zsh is required.*Development of Cloving/,
    );
    for (const name of ["zsh", "bash"]) {
      await writeFile(join(directory, name), "#!/bin/sh\nexit 0\n");
      await chmod(join(directory, name), 0o755);
    }
    assert.equal(check().status, 0);
    await writeFile(join(directory, "bash"), "#!/bin/sh\nexit 2\n");
    const broken = check();
    assert.equal(broken.status, 1);
    assert.match(String(broken.stderr), /bash is required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
