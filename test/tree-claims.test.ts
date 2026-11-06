import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimReleased,
  clearedTreeClaims,
  releaseClaim,
  takeClaim,
} from "../src/daemon/tree-claims.ts";

async function withState(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-claims-")),
  );
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("CLV-310 a claim is taken once, refused while held, and taken again after its release", () =>
  withState(async (directory) => {
    const claim = join(directory, "tree-claims", "one");
    assert.equal(await takeClaim(claim), true);
    assert.equal(await takeClaim(claim), false);
    await releaseClaim(claim);
    assert.equal(existsSync(claim), false);
    assert.equal(await takeClaim(claim), true);
  }));

await test("CLV-310 a wait for a held claim ends with work-tree-removing, and a missing claim does not wait", () =>
  withState(async (directory) => {
    const held = join(directory, "tree-claims", "held");
    await mkdir(held, { recursive: true });
    const signal = new AbortController().signal;
    await assert.rejects(claimReleased(held, { signal, milliseconds: 300 }), {
      message: "work-tree-removing",
    });
    await claimReleased(join(directory, "tree-claims", "missing"), {
      signal,
      milliseconds: 300,
    });
  }));

await test("CLV-310 a daemon start clears the claims that an ended daemon left", () =>
  withState(async (directory) => {
    await mkdir(join(directory, "tree-claims", "left"), { recursive: true });
    await clearedTreeClaims(directory);
    assert.equal(existsSync(join(directory, "tree-claims")), false);
    await clearedTreeClaims(directory);
  }));
