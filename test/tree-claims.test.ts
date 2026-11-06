import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  abandonedClaim,
  claimReleased,
  releaseClaim,
  takeClaim,
} from "../src/daemon/tree-claims.ts";
import { endedProcess, ownedClaim } from "./tree-claim-fixture.ts";

const minute = 60_000;

async function withClaims(
  body: (claim: (name: string) => string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-claims-")));
  try {
    await body((name) => join(root, "tree-claims", name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function aged(path: string, milliseconds: number): Promise<void> {
  const when = new Date(Date.now() - milliseconds);
  await utimes(path, when, when);
}

await test("CLV-310 a claim is abandoned only when its owner ended, it has no owner for a minute, or it is older than 15 minutes", () =>
  withClaims(async (claim) => {
    assert.equal(await abandonedClaim(claim("none")), false);
    await ownedClaim(claim("live"), { processId: process.pid });
    assert.equal(await abandonedClaim(claim("live")), false);
    await ownedClaim(claim("ended"), { processId: endedProcess() });
    assert.equal(await abandonedClaim(claim("ended")), true);
    await ownedClaim(claim("other-user"), { processId: 1 });
    assert.equal(await abandonedClaim(claim("other-user")), false);
    await mkdir(claim("young-ownerless"), { recursive: true });
    assert.equal(await abandonedClaim(claim("young-ownerless")), false);
    await mkdir(claim("old-ownerless"), { recursive: true });
    await aged(claim("old-ownerless"), 2 * minute);
    assert.equal(await abandonedClaim(claim("old-ownerless")), true);
    await mkdir(claim("broken"), { recursive: true });
    await writeFile(join(claim("broken"), "owner.json"), "{not json");
    await aged(claim("broken"), 2 * minute);
    assert.equal(await abandonedClaim(claim("broken")), true);
    await ownedClaim(claim("text-owner"), { processId: 0 });
    await aged(claim("text-owner"), 2 * minute);
    assert.equal(await abandonedClaim(claim("text-owner")), true);
    await ownedClaim(claim("stale"), { processId: process.pid });
    await aged(claim("stale"), 16 * minute);
    assert.equal(await abandonedClaim(claim("stale")), true);
  }));

await test("CLV-310 a claim is taken once, refused while its owner lives, and taken again after release or abandonment", () =>
  withClaims(async (claim) => {
    assert.equal(await takeClaim(claim("one")), true);
    assert.deepEqual(
      JSON.parse(await readFile(join(claim("one"), "owner.json"), "utf8")),
      { processId: process.pid },
    );
    assert.equal(await takeClaim(claim("one")), false);
    await releaseClaim(claim("one"));
    assert.equal(existsSync(claim("one")), false);
    assert.equal(await takeClaim(claim("one")), true);
    await ownedClaim(claim("two"), { processId: endedProcess() });
    assert.equal(await takeClaim(claim("two")), true);
  }));

await test("CLV-310 a wait for a claim of a live owner of another user ends with work-tree-removing", () =>
  withClaims(async (claim) => {
    await ownedClaim(claim("held"), { processId: 1 });
    await assert.rejects(
      claimReleased(claim("held"), {
        signal: new AbortController().signal,
        milliseconds: 300,
      }),
      { message: "work-tree-removing" },
    );
    await claimReleased(claim("missing"), {
      signal: new AbortController().signal,
      milliseconds: 300,
    });
  }));
