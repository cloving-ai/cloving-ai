import assert from "node:assert/strict";
import filesystem, { mkdir, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import {
  selfUpdateMilliseconds,
  workerTurnActive,
} from "../tools/self-update-host.ts";
import { withUpdate } from "./self-update-fixture.ts";

await test("CLV-085 the worker journal blocks only started turns without results", async () => {
  await withUpdate(async ({ directory }) => {
    assert.equal(await workerTurnActive(directory), false);
    const turn = join(directory, "journal", "turn");
    await mkdir(turn, { recursive: true });
    await writeFile(join(turn, "started.json"), "{}");
    assert.equal(await workerTurnActive(directory), true);
    await writeFile(join(turn, "result.json"), "{}");
    assert.equal(await workerTurnActive(directory), false);
  });
});

await test("CLV-085 journal access rejects an ENOENT-shaped non-Error", async () => {
  const failure = Object.assign(new Error("missing"), { code: "ENOENT" });
  Object.setPrototypeOf(failure, null);
  assert.equal(failure instanceof Error, false);
  const access = filesystem.access;
  filesystem.access = () => Promise.reject(failure);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      workerTurnActive("unused"),
      (error) => error === failure,
    );
  } finally {
    filesystem.access = access;
    syncBuiltinESMExports();
  }
});

await test("CLV-085 self-update settings use real paths and whole seconds with inclusive bounds", async () => {
  await withUpdate(async ({ directory }) => {
    const product = join(directory, "product");
    const linked = join(directory, "linked");
    await mkdir(product);
    await symlink(product, linked);
    for (const seconds of ["30", "120", "3600"])
      assert.equal(
        await selfUpdateMilliseconds({ seconds, repository: linked, product }),
        Number(seconds) * 1000,
      );
    for (const seconds of [
      "10",
      "29",
      "3601",
      "30.5",
      "",
      "NaN",
      "1e2",
      " 30",
      "+30",
    ])
      await assert.rejects(
        selfUpdateMilliseconds({ seconds, repository: product, product }),
        /invalid-self-update-seconds/,
      );
    assert.equal(
      await selfUpdateMilliseconds({
        seconds: undefined,
        repository: "absent",
        product: "absent",
      }),
      undefined,
    );
  });
});
