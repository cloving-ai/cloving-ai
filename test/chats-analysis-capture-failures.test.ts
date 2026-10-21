import assert from "node:assert/strict";
import {
  chmod,
  link,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureAnalysisSnapshot,
  readCapturedAnalysisSnapshot,
} from "../src/daemon/chats-capture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import {
  withAnalysis,
  importId,
  manifest,
  sidecar,
  corpus,
} from "./chats-worker-fixture.ts";

const binding = { runId: "capture-failures", importId };

await test(
  "CLV-158 legacy checkpoint recovery verifies captured evidence before writing",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const capture = await captureAnalysisSnapshot(fixture.directory, binding);
      const folder = join(fixture.directory, `capture-${capture.key}`);
      for (const name of ["checkpoint-0.json", "proposal-0.txt"])
        await rm(join(folder, name));
      const path = join(folder, "redacted.jsonl");
      const damaged = corpus.replace("At most", "At least");
      await writeFile(path, damaged);
      const before = await readdir(folder);
      await assert.rejects(
        readCapturedAnalysisSnapshot(fixture.directory, capture),
        { message: "analysis-input-refused" },
      );
      await assert.rejects(
        captureAnalysisSnapshot(fixture.directory, binding),
        { message: "analysis-input-refused" },
      );
      assert.deepEqual(await readdir(folder), before);
      assert.equal(await readFile(path, "utf8"), damaged);
    });
  }),
);

for (const name of ["checkpoint-0.json", "proposal-0.txt"]) {
  await test(
    `CLV-158 refuses capture replay with a damaged initial ${name}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const capture = await captureAnalysisSnapshot(
          fixture.directory,
          binding,
        );
        const path = join(fixture.directory, `capture-${capture.key}`, name);
        await writeFile(path, "incomplete");
        await assert.rejects(
          captureAnalysisSnapshot(fixture.directory, binding),
          { message: "analysis-output-failed" },
        );
        assert.equal(await readFile(path, "utf8"), "incomplete");
      });
    }),
  );
}

for (const [name, value] of [
  ["redaction.json", { ...manifest, recordCount: 17 }],
  ["redaction.json", { ...manifest, importId: "other" }],
  ["structure.json", { ...sidecar, occurrences: [] }],
  [
    "structure.json",
    JSON.stringify(sidecar).replace("synthetic:0", "synthetic:other"),
  ],
  ["redacted.jsonl", corpus + "\n"],
  ["redacted.jsonl", Buffer.from([0xc3])],
] as const) {
  await test(
    `CLV-119 refuses inconsistent captured evidence ${name} without retaining a capture`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        if (Buffer.isBuffer(value))
          await writeFile(join(fixture.directory, name), value);
        else await fixture.write(name, value);
        const before = await fixture.files();
        await assert.rejects(
          captureAnalysisSnapshot(fixture.directory, binding),
        );
        assert.deepEqual(await fixture.files(), before);
      });
    }),
  );
}

for (const name of ["redaction.json", "structure.json"]) {
  await test(
    `CLV-119 retains the metadata file boundary for ${name}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const text = await readFile(join(fixture.directory, name), "utf8");
        const exact = text + " ".repeat(65_536 - Buffer.byteLength(text));
        await fixture.write(name, exact);
        const capture = await captureAnalysisSnapshot(
          fixture.directory,
          binding,
        );
        const snapshot = await readCapturedAnalysisSnapshot(
          fixture.directory,
          capture,
        );
        assert.equal(
          snapshot[name === "redaction.json" ? "redaction" : "structure"],
          exact,
        );
        await fixture.write(name, exact + " ");
        await assert.rejects(
          captureAnalysisSnapshot(fixture.directory, {
            ...binding,
            runId: "overflow",
          }),
          { message: "analysis-too-large" },
        );
      });
    }),
  );
}

for (const field of [
  "key",
  "digest",
  "totalRecords",
  "runId",
  "importId",
  "schemaVersion",
]) {
  await test(
    `CLV-119 refuses a mismatched capture reference ${field}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const capture = await captureAnalysisSnapshot(
          fixture.directory,
          binding,
        );
        const forged = { ...capture };
        Reflect.set(forged, field, field === "totalRecords" ? 17 : "forged");
        await assert.rejects(
          readCapturedAnalysisSnapshot(fixture.directory, forged),
        );
        assert.deepEqual(
          await readCapturedAnalysisSnapshot(fixture.directory, capture),
          {
            importId,
            redaction: JSON.stringify(manifest),
            corpus,
            structure: JSON.stringify(sidecar),
          },
        );
      });
    }),
  );
}

for (const kind of [
  "content",
  "permissions",
  "hardlink",
  "symlink",
  "directory-permissions",
  "missing-marker",
]) {
  await test(
    `CLV-119 refuses damaged private capture ${kind} without recapturing changed source`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const capture = await captureAnalysisSnapshot(
          fixture.directory,
          binding,
        );
        const folder = join(fixture.directory, `capture-${capture.key}`);
        const path = join(folder, "redacted.jsonl");
        if (kind === "content")
          await writeFile(path, corpus.replace("At most", "At least"));
        if (kind === "permissions") await chmod(path, 0o644);
        if (kind === "directory-permissions") await chmod(folder, 0o755);
        if (kind === "missing-marker") await rm(join(folder, "capture.json"));
        if (kind === "hardlink" || kind === "symlink") {
          await rm(path);
          await (kind === "hardlink" ? link : symlink)(
            join(fixture.directory, "redacted.jsonl"),
            path,
          );
        }
        await fixture.write("redacted.jsonl", "changed");
        const before = await readdir(fixture.directory, { recursive: true });
        await assert.rejects(
          readCapturedAnalysisSnapshot(fixture.directory, capture),
        );
        await assert.rejects(
          captureAnalysisSnapshot(fixture.directory, binding),
        );
        assert.deepEqual(
          await readdir(fixture.directory, { recursive: true }),
          before,
        );
      });
    }),
  );
}
