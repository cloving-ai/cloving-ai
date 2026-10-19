import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import filesystem, {
  chmod,
  link,
  lstat,
  mkdir,
  rename,
  symlink,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import {
  contained,
  inspectScanSource,
  noFollowPath,
  refuseRepositoryRoot,
  sourceFailure,
  verifyOpenSource,
  verifyScanAncestor,
  verifyScanSource,
} from "../src/chats/source.ts";
import { selectChatSources } from "../src/chats/selection.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test(
  "CLV-111 containment distinguishes parents, siblings and shared prefixes",
  chatPlatformScenario(() => {
    for (const [root, path, expected] of [
      ["/synthetic/root", "/synthetic/root", true],
      ["/synthetic/root", "/synthetic/root/file", true],
      ["/synthetic/root", "/synthetic", false],
      ["/synthetic/root", "/synthetic/other/file", false],
      ["/synthetic/root", "/synthetic/root-escape/file", false],
      ["/", "/synthetic/root", true],
    ] as const)
      assert.equal(contained(root, path), expected);
    assert.throws(() => {
      noFollowPath("relative");
    }, /source-unreadable/);
  }),
);

await test("CLV-111 source failures expose only fixed refusal reasons", () => {
  assert.equal(sourceFailure(null), "source-unreadable");
  assert.equal(sourceFailure(new Error("private-fault")), "source-unreadable");
  assert.equal(
    sourceFailure(
      Object.assign(new Error("private-fault"), { code: "EACCES" }),
    ),
    "source-unreadable",
  );
  assert.equal(
    sourceFailure(Object.assign(new Error("private-fault"), { code: "ELOOP" })),
    "symbolic-link",
  );
  assert.equal(sourceFailure(new Error("source-changed")), "source-changed");
});

await test(
  "CLV-111 rejects stale serialized source identities, sizes and timestamps",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "root/project/source.jsonl": "source",
        "root/other/source.jsonl": "other",
      },
      async (directory) => {
        const path = join(directory, "root/project/source.jsonl");
        const source = await inspectScanSource(path, join(directory, "root"));
        const other = await inspectScanSource(
          join(directory, "root/other/source.jsonl"),
          join(directory, "root"),
        );
        await assert.rejects(
          verifyScanSource({ ...source, identities: other.identities }),
          /source-changed/,
        );
        for (const field of ["size", "modified", "changed"] as const)
          await assert.rejects(
            verifyScanSource({ ...source, [field]: source[field] + 1 }),
            /source-changed/,
          );
      },
    );
  }),
);

await test(
  "CLV-111 binds opened source handles and descendant metadata to inspected identities",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "root/project/source.jsonl": "source",
        "root/other/source.jsonl": "other",
      },
      async (directory) => {
        const path = join(directory, "root/project/source.jsonl");
        const source = await inspectScanSource(path, join(directory, "root"));
        const other = await inspectScanSource(
          join(directory, "root/other/source.jsonl"),
          join(directory, "root"),
        );
        const stats = await lstat(path);
        verifyOpenSource(source, stats);
        assert.throws(() => {
          verifyOpenSource({ ...source, identities: [] }, stats);
        }, /source-changed/);
        assert.throws(() => {
          verifyOpenSource(other, stats);
        }, /source-changed/);
        for (const field of ["size", "modified", "changed"] as const)
          assert.throws(() => {
            verifyOpenSource({ ...source, [field]: source[field] + 1 }, stats);
          }, /source-changed/);
        const root = await inspectScanSource(
          join(directory, "root"),
          join(directory, "root"),
        );
        const directoryStats = await lstat(join(directory, "root"));
        assert.throws(() => {
          verifyOpenSource(source, directoryStats);
        }, /source-changed/);
        verifyScanAncestor(root, source);
        for (const field of ["device", "inode"] as const) {
          const identities = source.identities.map((identity, index) =>
            index === 0
              ? { ...identity, [field]: identity[field] + 1 }
              : identity,
          );
          assert.throws(() => {
            verifyOpenSource({ ...source, identities }, stats);
          }, /source-changed/);
          const ancestors = root.identities.map((identity, index) =>
            index === 0
              ? { ...identity, [field]: identity[field] + 1 }
              : identity,
          );
          assert.throws(() => {
            verifyScanAncestor({ ...root, identities: ancestors }, source);
          }, /source-changed/);
        }
      },
    );
  }),
);

await test(
  "CLV-111 refuses an ancestor replaced while preserving the source inode",
  chatPlatformScenario(async () => {
    await withFiles(
      { "root/project/source.jsonl": "source" },
      async (directory) => {
        const path = join(directory, "root/project/source.jsonl");
        const original = filesystem.realpath;
        let changed = false;
        Object.defineProperty(filesystem, "realpath", {
          configurable: true,
          value: async (selected: string) => {
            if (selected === path && !changed) {
              changed = true;
              await rename(
                join(directory, "root/project"),
                join(directory, "root/old"),
              );
              await mkdir(join(directory, "root/project"));
              await link(join(directory, "root/old/source.jsonl"), path);
            }
            return original(selected);
          },
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(
            inspectScanSource(path, join(directory, "root")),
            /source-changed/,
          );
        } finally {
          filesystem.realpath = original;
          syncBuiltinESMExports();
        }
      },
    );
  }),
);

await test(
  "CLV-111 refuses nonregular entries and every linked ancestor",
  chatPlatformScenario(async () => {
    await withFiles(
      { "root/project/source.jsonl": "source" },
      async (directory) => {
        const root = join(directory, "root");
        await symlink(join(root, "project"), join(root, "alias"));
        await assert.rejects(
          inspectScanSource(join(root, "alias/source.jsonl"), root),
          /ELOOP|symbolic-link/,
        );
        const fifo = join(root, "fifo.jsonl");
        assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
        await assert.rejects(inspectScanSource(fifo, root), /nonregular-file/);
      },
    );
  }),
);

for (const files of [
  { "root/HEAD": "ordinary" },
  { "root/HEAD": "ordinary", "root/objects": "ordinary" },
  {
    "root/HEAD": "ordinary",
    "root/objects/entry": "ordinary",
    "root/refs": "ordinary",
  },
]) {
  await test(
    "CLV-111 ordinary folders with partial Git-like metadata remain selectable",
    chatPlatformScenario(async () => {
      await withFiles(files, async (directory) => {
        await refuseRepositoryRoot(join(directory, "root"));
      });
    }),
  );
}

await test("CLV-111 inaccessible root metadata yields an unreadable subtree", async () => {
  await withFiles({ "root/source.jsonl": "source" }, async (directory) => {
    await chmod(join(directory, "root"), 0);
    try {
      const selected = await selectChatSources({
        paths: [],
        roots: ["root"],
        workingDirectory: directory,
      });
      assert.deepEqual(
        selected.entries.map((entry) => entry.outcome),
        [{ status: "unreadable", reason: "source-unreadable" }],
      );
    } finally {
      await chmod(join(directory, "root"), 0o700);
    }
  });
});
