import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import filesystem, { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import {
  importDirectory,
  validateDestination,
} from "../src/chats/destination.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test(
  "CLV-095 destination inspection errors refuse output before creating artifacts",
  chatPlatformScenario(async () => {
    await withFiles({}, async (directory) => {
      const original = filesystem.lstat;
      filesystem.lstat = (): Promise<never> =>
        Promise.reject(
          Object.assign(new Error("private-access-error"), { code: "EACCES" }),
        );
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          importDirectory(join(directory, "runtime"), "new-import"),
          /destination-refused/,
        );
      } finally {
        filesystem.lstat = original;
        syncBuiltinESMExports();
      }
      assert.deepEqual(await filesystem.readdir(directory), []);
    });
  }),
);

await test(
  "CLV-095 refuses a chats directory replaced by a regular file after validation",
  chatPlatformScenario(async () => {
    await withFiles({}, async (directory) => {
      const chats = join(directory, "runtime", "chats");
      await mkdir(chats, { recursive: true });
      const original = Object.getOwnPropertyDescriptor(filesystem, "lstat");
      assert.ok(original);
      const lstat = filesystem.lstat;
      let inspections = 0;
      Object.defineProperty(filesystem, "lstat", {
        configurable: true,
        value: async (path: string) => {
          if (path === chats && ++inspections === 2) {
            await rm(chats, { recursive: true });
            await writeFile(chats, "replacement");
          }
          return lstat(path);
        },
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          importDirectory(join(directory, "runtime"), "new-import"),
          /destination-refused/,
        );
        assert.equal(inspections, 2);
        assert.equal(await filesystem.readFile(chats, "utf8"), "replacement");
      } finally {
        Object.defineProperty(filesystem, "lstat", original);
        syncBuiltinESMExports();
      }
    });
  }),
);

await test(
  "CLV-095 rejects changed destination aliases even when they lead outside repositories",
  chatPlatformScenario(async () => {
    await withFiles({}, async (directory) => {
      await mkdir(join(directory, "target"));
      await symlink(join(directory, "target"), join(directory, "alias"));
      await assert.rejects(
        validateDestination(join(directory, "alias")),
        /destination-refused/,
      );
    });
  }),
);

await test(
  "CLV-095 output open errors report only a fixed code",
  chatPlatformScenario(async () => {
    await withFiles({}, async (directory) => {
      const original = filesystem.open;
      filesystem.open = () =>
        Promise.reject(
          Object.assign(new Error("private-output-path"), { code: "EACCES" }),
        );
      syncBuiltinESMExports();
      try {
        const result = await importChats({
          paths: ["source"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.equal(result.code, "output-failed");
        assert.equal(result.importId, null);
        assert.doesNotMatch(
          JSON.stringify(result),
          /private-output-path|source/,
        );
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
    });
  }),
);

await test("CLV-095 an unqualified platform refuses output without a weaker open mode", async () => {
  await withFiles({}, async (directory) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(descriptor);
    Object.defineProperty(process, "platform", {
      value: "unqualified",
      configurable: true,
    });
    try {
      await assert.rejects(
        importDirectory(join(directory, "runtime"), "new-import"),
        /platform-unsupported/,
      );
      assert.deepEqual(await filesystem.readdir(directory), []);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
