import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { releasePrOutput } from "./watch-pr-cli-fixture.ts";

await test("CLV-179 watch command fixtures publish complete responses during an interrupted write", () =>
  withFiles({ "run/.keep": "" }, async (directory) => {
    const file = join(directory, "gh-response");
    const write = filesystem.writeFile;
    const partial: string[] = [];
    const output = {
      stdout: "HTTP/2.0 200 OK",
      stderr: "",
      status: 0,
      errorCode: null,
    };
    filesystem.writeFile = async (target, data) => {
      await write(target, "");
      if (existsSync(file)) partial.push(readFileSync(file, "utf8"));
      await write(target, data);
    };
    syncBuiltinESMExports();
    try {
      await releasePrOutput(join(directory, "run"), output);
      assert.deepEqual(partial, []);
      const published: unknown = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(published, output);
    } finally {
      filesystem.writeFile = write;
      syncBuiltinESMExports();
    }
  }));
