import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import {
  legacyRuntimeDirectory,
  runtimeDirectory,
} from "../src/cli/runtime-directory.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { readRootOutput } from "./chats-selection-fixture.ts";

const source = JSON.stringify({
  type: "user",
  message: { role: "user", content: "private synthetic transcript" },
});

await test("CLV-095 selects runtime locations without resolving relative overrides", () => {
  assert.equal(
    runtimeDirectory({
      CLOVING_RUNTIME_DIR: "relative",
      XDG_RUNTIME_DIR: "xdg",
    }),
    "relative",
  );
  assert.equal(
    legacyRuntimeDirectory({ CLOVING_RUNTIME_DIR: "", XDG_RUNTIME_DIR: "xdg" }),
    join("xdg", "cloving"),
  );
  assert.equal(
    legacyRuntimeDirectory({ XDG_STATE_HOME: "state", HOME: "home" }),
    join("state", "cloving", "run"),
  );
  assert.equal(
    legacyRuntimeDirectory({ HOME: "home" }),
    join("home", ".local", "state", "cloving", "run"),
  );
  assert.equal(runtimeDirectory({}), undefined);
});

await test(
  "CLV-095 creates separate private imports and keeps source bytes unchanged",
  chatPlatformScenario(async () => {
    await withFiles({ "source.jsonl": source }, async (directory) => {
      const request = {
        paths: ["source.jsonl"],
        workingDirectory: directory,
        runtimeDirectory: "relative/runtime",
      };
      const first = await importChats(request);
      assert.equal(first.code, "import-complete");
      assert.ok(first.importId);
      const second = await importChats(request);
      assert.ok(second.importId);
      assert.notEqual(first.importId, second.importId);
      const chats = join(directory, "relative/runtime/chats");
      for (const path of [
        "relative",
        "relative/runtime",
        "relative/runtime/chats",
        `relative/runtime/chats/${first.importId}`,
      ]) {
        assert.equal((await stat(join(directory, path))).mode & 0o777, 0o700);
      }
      for (const name of ["corpus.jsonl", "structure.json", "coverage.json"])
        assert.equal(
          (await stat(join(chats, first.importId, name))).mode & 0o777,
          0o600,
        );
      assert.equal(
        await readFile(join(chats, first.importId, "corpus.jsonl"), "utf8"),
        await readFile(join(chats, second.importId, "corpus.jsonl"), "utf8"),
      );
      assert.equal(
        await readFile(join(directory, "source.jsonl"), "utf8"),
        source,
      );
    });
  }),
);

await test(
  "CLV-095 refuses unavailable runtime and repository destinations before creating artifacts",
  chatPlatformScenario(async () => {
    await withFiles(
      { "source.jsonl": source, "repo/.git": "gitdir: elsewhere" },
      async (directory) => {
        const unavailable = await importChats({
          paths: ["source.jsonl"],
          workingDirectory: directory,
          runtimeDirectory: undefined,
        });
        assert.equal(unavailable.code, "runtime-directory-unknown");
        assert.equal(unavailable.importId, null);
        await symlink(join(directory, "repo"), join(directory, "alias"));
        await mkdir(join(directory, "outside"));
        await symlink(
          join(directory, "repo"),
          join(directory, "outside", "chats"),
        );
        const before = await readdir(directory, { recursive: true });
        for (const runtime of ["repo/private", "alias/private", "outside"]) {
          const result = await importChats({
            paths: ["source.jsonl"],
            workingDirectory: directory,
            runtimeDirectory: runtime,
          });
          assert.equal(result.code, "destination-refused", runtime);
        }
        assert.deepEqual(await readdir(directory, { recursive: true }), before);
      },
    );
  }),
);

await test(
  "CLV-095 leaves no completed manifest after a corpus write failure",
  chatPlatformScenario(async () => {
    await withFiles(
      { "source.jsonl": source, probe: "" },
      async (directory) => {
        const probe = await open(join(directory, "probe"), "r");
        const prototype: unknown = Object.getPrototypeOf(probe);
        assert.ok(
          prototype &&
            typeof prototype === "object" &&
            "writeFile" in prototype,
        );
        const descriptor = Object.getOwnPropertyDescriptor(
          prototype,
          "writeFile",
        );
        assert.ok(descriptor);
        Object.defineProperty(prototype, "writeFile", {
          value: () => Promise.reject(new Error("injected private failure")),
          configurable: true,
        });
        try {
          const result = await importChats({
            paths: ["source.jsonl"],
            workingDirectory: directory,
            runtimeDirectory: "runtime",
          });
          assert.equal(result.code, "output-failed");
          const files = await readdir(join(directory, "runtime"), {
            recursive: true,
          });
          assert.ok(files.every((file) => !file.endsWith("coverage.json")));
        } finally {
          Object.defineProperty(prototype, "writeFile", descriptor);
          await probe.close();
        }
      },
    );
  }),
);

await test(
  "CLV-111 exclusions alone succeed, pending subtrees require partial status and files remain explicit",
  chatPlatformScenario(async () => {
    await withFiles(
      {
        "root/skip/sentinel.jsonl": source,
        "root/keep/session/subagents/deep/later.jsonl": source,
      },
      async (directory) => {
        const request = {
          paths: [],
          roots: ["root"],
          excludeProjects: ["skip", "keep"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        };
        const excluded = await importChats(request);
        assert.equal(excluded.code, "import-complete");
        assert.deepEqual(
          [
            excluded.included,
            excluded.refused,
            excluded.excluded,
            excluded.pending,
          ],
          [0, 0, 2, 0],
        );
        const pending = await importChats({
          ...request,
          excludeProjects: ["skip"],
        });
        assert.equal(pending.code, "import-partial");
        assert.deepEqual(
          [
            pending.included,
            pending.refused,
            pending.excluded,
            pending.pending,
          ],
          [0, 0, 1, 1],
        );
        assert.ok(pending.importId);
        const output = await readRootOutput(directory, pending.importId);
        assert.doesNotMatch(output.coverage, /later.jsonl|sentinel.jsonl/);
        const later = await importChats({
          ...request,
          paths: ["root/keep/session/subagents/deep/later.jsonl"],
          roots: [],
        });
        assert.equal(later.code, "import-complete");
        assert.equal(later.included, 1);
        for (const name of ["corpus.jsonl", "coverage.json", "structure.json"])
          assert.equal(
            (await stat(join(output.output, name))).mode & 0o777,
            0o600,
          );
      },
    );
  }),
);

await test(
  "CLV-113 writes private revisions, increments evidence and preserves earlier files",
  chatPlatformScenario(async () => {
    await withFiles({ "source.jsonl": source }, async (directory) => {
      const request = {
        paths: ["source.jsonl"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
      };
      const first = await importChats(request);
      assert.ok(first.importId);
      const base = join(directory, "runtime/chats", first.importId);
      const before = await Promise.all(
        ["corpus.jsonl", "structure.json", "coverage.json"].map((name) =>
          readFile(join(base, name)),
        ),
      );
      const second = await importChats({
        ...request,
        previousImportId: first.importId,
      });
      assert.equal(second.code, "import-complete");
      assert.ok(second.importId);
      const output = join(directory, "runtime/chats", second.importId);
      assert.equal((await stat(output)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(output, "revision.json"))).mode & 0o777,
        0o600,
      );
      assert.deepEqual(
        await Promise.all(
          ["corpus.jsonl", "structure.json", "coverage.json"].map((name) =>
            readFile(join(base, name)),
          ),
        ),
        before,
      );
      const third = await importChats({
        ...request,
        previousImportId: second.importId,
      });
      assert.ok(third.importId);
      const text = await readFile(
        join(directory, "runtime/chats", third.importId, "revision.json"),
        "utf8",
      );
      assert.match(text, /"evidenceRevision": 2/);
      assert.match(text, /"unchanged": 1/);
      assert.doesNotMatch(text, /synthetic transcript|"text"|"blocks"/);
    });
  }),
);
