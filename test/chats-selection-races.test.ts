import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import filesystem, { rename, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { selectChatSources } from "../src/chats/selection.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test(
  "CLV-111 refuses a directory replaced by a link at enumeration without listing its target",
  chatPlatformScenario(async () => {
    await withFiles(
      { "root/project/source.jsonl": "", "outside/target.jsonl": "" },
      async (directory) => {
        const original = filesystem.readdir;
        let listedTarget = false;
        Object.defineProperty(filesystem, "readdir", {
          configurable: true,
          value: async (path: string) => {
            if (path.endsWith("/root/project")) {
              await rename(
                join(directory, "root/project"),
                join(directory, "root/old"),
              );
              await symlink(
                join(directory, "outside"),
                join(directory, "root/project"),
              );
            }
            const entries = await original(path, { withFileTypes: true });
            if (entries.some((entry) => entry.name === "target.jsonl"))
              listedTarget = true;
            return entries;
          },
        });
        syncBuiltinESMExports();
        try {
          const result = await selectChatSources({
            paths: [],
            roots: ["root"],
            workingDirectory: directory,
          });
          assert.equal(listedTarget, false);
          assert.deepEqual(
            result.entries.map((entry) => [entry.kind, entry.outcome?.reason]),
            [["subtree", "symbolic-link"]],
          );
        } finally {
          filesystem.readdir = original;
          syncBuiltinESMExports();
        }
      },
    );
  }),
);

for (const replacement of ["outside", "same-inode"]) {
  await test(
    `CLV-111 refuses ${replacement} root canonicalization races`,
    chatPlatformScenario(async () => {
      await withFiles(
        { "A/project/a.jsonl": "", "B/project/b.jsonl": "" },
        async (directory) => {
          const original = filesystem.realpath;
          let replaced = false;
          Object.defineProperty(filesystem, "realpath", {
            configurable: true,
            value: async (path: string) => {
              if (path === join(directory, "A") && !replaced) {
                replaced = true;
                await rename(path, `${path}.old`);
                await symlink(
                  replacement === "outside"
                    ? join(directory, "B")
                    : `${path}.old`,
                  path,
                );
              }
              return original(path);
            },
          });
          syncBuiltinESMExports();
          try {
            const result = await selectChatSources({
              paths: [],
              roots: ["A"],
              workingDirectory: directory,
            });
            assert.equal(result.entries.length, 1);
            assert.equal(result.entries[0]?.kind, "subtree");
            assert.equal(result.entries[0].outcome?.status, "unsupported");
            assert.equal(result.entries[0].path, join(directory, "A"));
          } finally {
            filesystem.realpath = original;
            syncBuiltinESMExports();
          }
        },
      );
    }),
  );
}
