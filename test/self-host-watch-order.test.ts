import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { programs } from "./self-host-processes-fixture.ts";

function hosted(root: string, paths: Awaited<ReturnType<typeof programs>>) {
  return hostedPrograms({
    ...paths,
    repository: root,
    runtime: join(root, "host/run"),
    directory: join(root, "host"),
    watchPort: "3663",
    phoneRelay: "off",
    updateMilliseconds: undefined,
  });
}

await test("CLV-270 the host starts the watch page only after the daemon reports its start", () =>
  withFiles({}, async (root) => {
    const paths = await programs(root, {
      daemonMilliseconds: 100,
      announcedMilliseconds: 300,
    });
    assert.equal(await hosted(root, paths), 0);
    assert.equal(
      await readFile(join(root, "watch-saw-daemon"), "utf8"),
      "true",
    );
  }));

await test("CLV-270 the host starts no watch page when the daemon stops before it reports its start", () =>
  withFiles({}, async (root) => {
    const paths = await programs(root, {
      daemonMilliseconds: 100,
      readyPrograms: [],
      announcedMilliseconds: "never",
    });
    assert.equal(await hosted(root, paths), 0);
    assert.equal(existsSync(join(root, "watch-started")), false);
  }));
