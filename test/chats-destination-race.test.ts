import assert from "node:assert/strict";
import filesystem, {
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import { withFiles } from "./quality/files-fixture.ts";

const source = JSON.stringify({
  type: "user",
  message: { role: "user", content: "private-race-sentinel" },
});

for (const name of ["corpus.jsonl", "coverage.json"] as const) {
  await test(`CLV-095 refuses an ancestor symlink swapped immediately before ${name} opens`, async () => {
    await withFiles(
      { source, "repo/.git": "gitdir: synthetic" },
      async (directory) => {
        const original = filesystem.open;
        const chats = join(directory, "runtime", "chats");
        let swapped = false;
        filesystem.open = async (path, flags) => {
          if (basename(String(path)) === name) {
            swapped = true;
            const importId = basename(dirname(String(path)));
            await rename(chats, join(directory, "saved-chats"));
            await mkdir(join(directory, "repo", importId));
            await symlink(join(directory, "repo"), chats);
          }
          return original(path, flags, 0o600);
        };
        syncBuiltinESMExports();
        try {
          const result = await importChats({
            paths: ["source"],
            workingDirectory: directory,
            runtimeDirectory: "runtime",
          });
          assert.equal(swapped, true);
          assert.equal(result.code, "destination-refused");
          const files = await readdir(join(directory, "repo"), {
            recursive: true,
          });
          assert.ok(
            files.every(
              (file) =>
                !file.endsWith(".jsonl") &&
                !file.endsWith(".json") &&
                !file.endsWith(".pending"),
            ),
          );
          assert.equal(
            await readFile(join(directory, "source"), "utf8"),
            source,
          );
        } finally {
          filesystem.open = original;
          syncBuiltinESMExports();
        }
      },
    );
  });
}
