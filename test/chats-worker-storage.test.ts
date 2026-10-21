import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import filesystem, {
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { boundedAnalysisFile } from "../src/daemon/chats-files.ts";
import { analysisProposal } from "../src/chats/analysis-proposal.ts";
import { validateAnalysis } from "../src/chats/analysis.ts";
import { structureImport } from "../src/chats/structure.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import {
  candidate,
  records,
  structure,
  itemAt,
  ref,
} from "./chats-analysis-fixture.ts";
import {
  withAnalysis,
  assertRefused,
  cycleId,
  analysisIntent,
  corpus,
} from "./chats-worker-fixture.ts";
import { chatsWorker } from "../src/daemon/chats-worker.ts";

for (const text of [
  "x".repeat(65_536),
  "é".repeat(32_768),
  "😀".repeat(16_384),
]) {
  await test(
    `CLV-115 bounded file reader accepts exactly 65536 bytes of ${String(text[0])}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        const path = join(f.directory, "redacted.jsonl");
        await writeFile(path, text);
        assert.equal(await boundedAnalysisFile(path), text);
      });
    }),
  );
}

await test(
  "CLV-115 redaction cannot collapse original conflict and copy classifications",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      const collapsed = records.map((message) => ({
        ...message,
        text: "[PRIVATE_TEXT]",
        blocks: [],
      }));
      await f.write(
        "redacted.jsonl",
        collapsed.map((message) => JSON.stringify(message) + "\n").join(""),
      );
      const snapshot = await f.capture();
      assert.equal(structureImport(collapsed).conflictGroups.length, 0);
      const saved = record(JSON.parse(snapshot.structure));
      assert.deepEqual(saved?.["conflictGroups"], structure.conflictGroups);
      assert.equal(
        record(saved["counts"])?.["copies"],
        structure.counts.copies,
      );
    });
  }),
);

await test(
  "CLV-115 exact numeric tokens survive the captured snapshot as strings",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      const text = corpus
        .replace(
          '"blocks":[',
          '"blocks":[{"type":"tool_use","position":0,"id":"number","name":"synthetic","input":{"n":9007199254740993}},',
        )
        .replace('"position":0,"type":"text"', '"position":1,"type":"text"');
      await f.write("redacted.jsonl", text);
      const next = await f.capture();
      assert.match(next.corpus, /9007199254740993/);
      assert.match(
        JSON.stringify(parseCorpus(next.corpus)),
        /9007199254740993/,
      );
    });
  }),
);

await test(
  "CLV-115 proposal keeps limitations visible when descriptions exhaust its bound",
  chatPlatformScenario(() => {
    const value = candidate();
    value.process.name = "n".repeat(5_000);
    value.process.scope = "s".repeat(5_000);
    itemAt(value.process.stages).description = "d".repeat(5_000);
    const validation = validateAnalysis(value, { records, structure });
    assert.ok(validation.accepted);
    const proposal = analysisProposal(validation.result);
    assert.ok(proposal.length <= 4_000);
    assert.match(proposal, /not-established/);
    assert.match(proposal, /no authority/);
    assert.match(proposal, /synthetic:1/);
    assert.equal(proposal, analysisProposal(validation.result));
  }),
);

for (const kind of ["symlink", "hardlink", "directory", "missing-proposal"]) {
  await test(
    `CLV-115 refuses ${kind} output without changing existing bytes`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        await f.prepare();
        await f.deliver("save-analysis");
        const path = join(f.directory, `proposal-${cycleId}.txt`);
        const text = await readFile(path, "utf8");
        await rm(path);
        const other = join(f.runtimeDirectory, "existing");
        await writeFile(other, text);
        if (kind === "symlink" || kind === "hardlink")
          await (kind === "symlink" ? symlink : link)(other, path);
        if (kind === "directory") await mkdir(path);
        assertRefused(
          await f.deliver("save-analysis"),
          "analysis-output-failed",
        );
        assert.equal(await readFile(other, "utf8"), text);
      });
    }),
  );
}

for (const name of ["proposal", "analysis"]) {
  for (const operation of ["create", "write", "close"]) {
    await test(
      `CLV-115 ${name} ${operation} failure cannot report acceptance`,
      chatPlatformScenario(async () => {
        await withAnalysis(async (f) => {
          await f.prepare();
          const observer = interceptOutputFailure({ name, operation });
          try {
            assertRefused(
              await f.deliver("save-analysis"),
              "analysis-output-failed",
            );
            assert.ok(observer.handles.every((handle) => handle.fd === -1));
          } finally {
            observer.restore();
          }
        });
      }),
    );
  }
}

await test(
  "CLV-115 calls inside repositories and linked import directories fail closed",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      await mkdir(join(f.runtimeDirectory, ".git"));
      assertRefused(await f.deliver("read-analysis"), "analysis-input-refused");
      await rm(join(f.runtimeDirectory, ".git"), { recursive: true });
      const moved = join(f.runtimeDirectory, "moved");
      await mkdir(moved);
      await rm(f.directory, { recursive: true });
      await symlink(moved, f.directory);
      assertRefused(await f.deliver("read-analysis"), "analysis-input-refused");
    });
  }),
);

await test(
  "CLV-115 a restarted adapter reconciles the same completed save",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      await f.prepare();
      const first = await f.deliver("save-analysis");
      const restarted = chatsWorker(f.settings);
      assert.deepEqual(
        await restarted.reconcile(
          analysisIntent("save-analysis"),
          new AbortController().signal,
        ),
        first,
      );
    });
  }),
);

function interceptOutputFailure(options: { name: string; operation: string }) {
  const { name, operation } = options;
  const original = filesystem.open;
  const handles: FileHandle[] = [];
  filesystem.open = async (path, flags) => {
    if (
      !basename(String(path)).startsWith(`${name}-`) ||
      typeof flags !== "number" ||
      (flags & 1) !== 1
    )
      return original(path, flags);
    if (operation === "create") throw new Error("synthetic-create");
    const handle = await original(path, flags);
    handles.push(handle);
    if (operation === "write")
      handle.writeFile = () => Promise.reject(new Error("synthetic-write"));
    if (operation === "close") {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw new Error("synthetic-close");
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  return {
    handles,
    restore: () => {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

await test(
  "CLV-115 completed outputs with widened permissions are refused unchanged",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      await f.prepare();
      await f.deliver("save-analysis");
      const path = join(f.directory, `analysis-${cycleId}.json`);
      const text = await readFile(path, "utf8");
      await filesystem.chmod(path, 0o644);
      assertRefused(await f.deliver("save-analysis"), "analysis-output-failed");
      assert.equal(await readFile(path, "utf8"), text);
      assert.equal((await filesystem.stat(path)).mode & 0o777, 0o644);
    });
  }),
);

await test(
  "CLV-115 stopping an in-flight save waits until output I/O has ended",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      await f.prepare();
      const observer = heldProposal();
      const intent = analysisIntent("save-analysis");
      const running = f.worker.deliver(intent, new AbortController().signal);
      await observer.entered.promise;
      const stopped = { done: false };
      const stopping = f.worker
        .stop(intent, new AbortController().signal)
        .then((value) => {
          stopped.done = true;
          return value;
        });
      let settledBeforeRelease: boolean;
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        settledBeforeRelease = stopped.done;
      } finally {
        observer.release.resolve(undefined);
        observer.restore();
      }
      const result = await running;
      const actual = await stopping;
      assert.equal(settledBeforeRelease, false);
      assert.deepEqual(actual, result);
      assert.equal(result.kind, "completed");
    });
  }),
);

function heldProposal() {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const original = filesystem.open;
  filesystem.open = async (path, flags) => {
    const handle = await original(path, flags, 0o600);
    if (
      basename(String(path)).startsWith("proposal-") &&
      typeof flags === "number" &&
      (flags & 1) === 1
    ) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (text, options) => {
        entered.resolve(undefined);
        await release.promise;
        return write(text, options);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  return {
    entered,
    release,
    restore: () => {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

await test(
  "CLV-115 a short accepted proposal stays complete within the character bound",
  chatPlatformScenario(() => {
    const value = candidate();
    value.process.stages = value.process.stages.slice(0, 2);
    value.process.loops = [];
    value.process.gates = [];
    value.process.nonGates = [itemAt(value.process.nonGates)];
    const validation = validateAnalysis(value, { records, structure });
    assert.ok(validation.accepted);
    const proposal = analysisProposal(validation.result);
    assert.ok(proposal.length < 4_000);
    assert.doesNotMatch(proposal, /Summary shortened/);
    assert.match(proposal, /Input candidate-input: Candidate changes\./);
    assert.match(proposal, /Branch review -> repair: Defect found\./);
    assert.match(proposal, /counterevidence/);
  }),
);

await test(
  "CLV-115 large citation lists shorten only the proposal and retain full analysis evidence",
  chatPlatformScenario(() => {
    const value = candidate();
    const stage = itemAt(value.process.stages);
    stage.sourceRefs.push(...Array.from({ length: 300 }, () => ref(1)));
    const validation = validateAnalysis(value, { records, structure });
    assert.ok(validation.accepted);
    const proposal = analysisProposal(validation.result);
    assert.ok(proposal.length <= 4_000);
    assert.match(proposal, /Summary shortened; see complete analysis JSON/);
    assert.equal(
      itemAt(validation.result.process.stages).sourceRefs.length,
      303,
    );
    assert.deepEqual(
      itemAt(validation.result.process.stages).counterevidenceRefs,
      [ref(13)],
    );
    assert.equal(proposal, analysisProposal(validation.result));
  }),
);
