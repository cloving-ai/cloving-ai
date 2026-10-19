import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withProject } from "./cli-fixture.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { structureImport } from "../src/chats/structure.ts";

const forkMessages = [
  { uuid: "root-id", parentUuid: null },
  { uuid: "first-id", parentUuid: "root-id" },
  { uuid: "side-id", parentUuid: "root-id", isSidechain: true },
].map((identity) => ({
  type: "user",
  sessionId: "private-session",
  ...identity,
  message: { role: "user", content: "synthetic-content-sentinel" },
}));
const forkSource = forkMessages
  .map((message) => JSON.stringify(message))
  .join("\n");
function importSelected(directory: string, paths: readonly string[]) {
  return spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "chats", "import", ...paths],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CLOVING_RUNTIME_DIR: join(directory, "runtime") },
    },
  );
}

const counts = {
  records: 8,
  knownSessions: 1,
  forks: 1,
  copies: 3,
  conflictGroups: 1,
  unknownIdentities: 1,
  missingParentTargets: 0,
};

await test(
  "CLV-110 CLI imports forks, copies and conflicts without leaking private metadata",
  chatPlatformScenario(async () => {
    await withProject(
      {
        "project with spaces/a": forkSource,
        "project with spaces/c": JSON.stringify({
          ...forkMessages[1],
          message: { role: "user", content: "conflict-content-sentinel" },
        }),
        "project with spaces/d": JSON.stringify({
          type: "user",
          sessionId: "private-session",
          message: { role: "user", content: "unknown-content-sentinel" },
        }),
      },
      async (_cli, directory) => {
        const runtime = join(directory, "runtime");
        const result = importSelected(directory, [
          "a",
          "a",
          "c",
          "d",
          "missing",
        ]);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, "");
        const imports = await readdir(join(runtime, "chats"));
        assert.equal(imports.length, 1);
        const importId = String(imports[0]);
        const output = join(runtime, "chats", importId);
        const records = parseCorpus(
          await readFile(join(output, "corpus.jsonl"), "utf8"),
        );
        assert.equal(records.length, 8);
        const text = await readFile(join(output, "structure.json"), "utf8");
        const structure: unknown = JSON.parse(text);
        assert.deepEqual(structure, {
          schemaVersion: 1,
          importId,
          ...structureImport(records),
        });
        assert.deepEqual(JSON.parse(result.stdout), {
          code: "import-partial",
          importId,
          included: 4,
          refused: 1,
          ...counts,
        });
        assert.doesNotMatch(text, /content-sentinel|"text"|"blocks"|"path"/);
        assert.equal(text.includes(directory), false);
        assert.doesNotMatch(
          result.stdout,
          /private-session|root-id|first-id|side-id|content-sentinel|"missing"/,
        );
        assert.equal(await readFile(join(directory, "a"), "utf8"), forkSource);
      },
    );
  }),
);

await test(
  "CLV-110 metadata-only imports write private structure with every zero count",
  chatPlatformScenario(async () => {
    await withProject(
      { "project with spaces/metadata": '{"type":"progress"}' },
      async (_cli, directory) => {
        const runtime = join(directory, "runtime");
        const result = spawnSync(
          process.execPath,
          [resolve("src/cli.ts"), "chats", "import", "metadata"],
          {
            cwd: directory,
            encoding: "utf8",
            env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
          },
        );
        assert.equal(result.status, 0);
        const imports = await readdir(join(runtime, "chats"));
        const importId = String(imports[0]);
        const text = await readFile(
          join(runtime, "chats", importId, "structure.json"),
          "utf8",
        );
        assert.deepEqual(JSON.parse(text), {
          schemaVersion: 1,
          importId,
          ...structureImport([]),
        });
        assert.deepEqual(JSON.parse(result.stdout), {
          code: "import-complete",
          importId,
          included: 1,
          refused: 0,
          ...structureImport([]).counts,
        });
      },
    );
  }),
);
