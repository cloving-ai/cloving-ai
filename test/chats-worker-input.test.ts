import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import filesystem, {
  link,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import {
  analysisPrompt,
  analysisLaunchBytes,
} from "../src/chats/analysis-prompt.ts";
import {
  withAnalysis,
  assertRefused,
  importId,
  manifest,
  sidecar,
  corpus,
} from "./chats-worker-fixture.ts";

for (const id of [
  "../escape",
  importId.toUpperCase().replace("11111111", "ABCDEF12"),
  "11111111-1111-1111-8111-111111111111",
  "",
  3,
]) {
  await test(
    `CLV-115 refuses import ID ${String(id)} before file access`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        f.payloads.set("read-analysis", JSON.stringify({ importId: id }));
        assertRefused(
          await f.deliver("read-analysis"),
          typeof id === "string" && id !== ""
            ? "invalid-import-id"
            : "analysis-input-refused",
        );
      });
    }),
  );
}

for (const name of ["redaction.json", "redacted.jsonl", "structure.json"]) {
  await test(
    `CLV-115 refuses missing ${name}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        await rm(join(f.directory, name));
        assertRefused(
          await f.deliver("read-analysis"),
          name === "structure.json"
            ? "analysis-input-refused"
            : "redaction-required",
        );
      });
    }),
  );
}

for (const value of [
  null,
  {},
  { ...manifest, schemaVersion: 2 },
  { ...manifest, ruleVersion: 2 },
  { ...manifest, importId: "other" },
  { ...manifest, recordCount: 0 },
  { ...manifest, counts: { ...manifest.counts, token: -1 } },
  { ...manifest, totalCount: 1 },
  { ...manifest, counts: { ...manifest.counts, token: 0.5 } },
]) {
  await test(
    `CLV-115 refuses invalid manifest ${JSON.stringify(value)}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        await f.write("redaction.json", value);
        assertRefused(
          await f.deliver("read-analysis"),
          "analysis-input-refused",
        );
      });
    }),
  );
}

for (const value of [
  null,
  {},
  { ...sidecar, schemaVersion: 2 },
  { ...sidecar, importId: "other" },
  { ...sidecar, sessions: [] },
  { ...sidecar, counts: { ...sidecar.counts, copies: 0 } },
  { ...sidecar, conflictGroups: [] },
  {
    ...sidecar,
    occurrences: sidecar.occurrences.map((item) => ({
      ...item,
      sessionId: "forged",
    })),
  },
]) {
  await test(
    `CLV-115 refuses inconsistent sidecar ${JSON.stringify(value).slice(0, 100)}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        await f.write("structure.json", value);
        assertRefused(
          await f.deliver("read-analysis"),
          "analysis-input-refused",
        );
      });
    }),
  );
}

for (const kind of [
  "symlink",
  "hardlink",
  "directory",
  "invalid-utf8",
  "invalid-json",
]) {
  await test(
    `CLV-115 refuses ${kind} evidence`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        const path = join(f.directory, "redacted.jsonl");
        await rm(path);
        if (kind === "symlink" || kind === "hardlink") {
          const other = join(f.runtimeDirectory, "other");
          await writeFile(other, corpus);
          await (kind === "symlink" ? symlink : link)(other, path);
        }
        if (kind === "directory") await mkdir(path);
        if (kind === "invalid-utf8") await writeFile(path, Buffer.from([0xff]));
        if (kind === "invalid-json") await writeFile(path, "{");
        assertRefused(
          await f.deliver("read-analysis"),
          "analysis-input-refused",
        );
      });
    }),
  );
}

await test(
  "CLV-115 opens only the three permitted evidence files",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      const opened: string[] = [];
      const original = filesystem.open;
      filesystem.open = (path, flags) => {
        opened.push(basename(String(path)));
        return original(path, flags);
      };
      syncBuiltinESMExports();
      try {
        await f.capture();
        assert.deepEqual(opened, [
          "redaction.json",
          "redacted.jsonl",
          "structure.json",
        ]);
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
    });
  }),
);

for (const content of [
  "x".repeat(65_537),
  "é".repeat(32_769),
  JSON.stringify({ schemaVersion: 1 }) + "\n",
]) {
  await test(
    `CLV-115 bounds corpus input ${String(Buffer.byteLength(content))}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        await f.write("redacted.jsonl", content);
        assertRefused(
          await f.deliver("read-analysis"),
          Buffer.byteLength(content) > 65_536
            ? "analysis-too-large"
            : "analysis-input-refused",
        );
      });
    }),
  );
}

await test(
  "CLV-115 preflights complete serialized model input including escape overhead",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      const snapshot = await f.capture();
      const filler = '\\"'.repeat(8_000);
      const padded = record(
        JSON.parse(snapshot.corpus.split("\n")[0] ?? "null"),
      );
      assert.ok(padded);

      const text =
        JSON.stringify({ ...padded, text: filler }) +
        "\n" +
        snapshot.corpus.split("\n").slice(1).join("\n");
      assert.ok(Buffer.byteLength(text) < 65_536);
      assert.ok(
        analysisLaunchBytes(analysisPrompt({ ...snapshot, corpus: text })) >
          65_536,
      );
      await f.write("redacted.jsonl", text);
      assertRefused(await f.deliver("read-analysis"), "analysis-too-large");
    });
  }),
);

for (const payload of [
  "{",
  "null",
  "{}",
  JSON.stringify({ importId, cycleId: "../escape", snapshot: {}, reply: "{}" }),
]) {
  await test(
    `CLV-115 malformed protected payload is refused ${payload.slice(0, 50)}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (f) => {
        f.payloads.set("save-analysis", payload);
        assertRefused(
          await f.deliver("save-analysis"),
          "analysis-input-refused",
        );
      });
    }),
  );
}

await test(
  "CLV-115 missing private worker document fails with a fixed code",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      f.payloads.clear();
      assertRefused(await f.deliver("read-analysis"), "payload-not-available");
    });
  }),
);

await test(
  "CLV-115 dangling import links are unsafe evidence rather than missing redaction",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      await rm(f.directory, { recursive: true });
      await symlink(join(f.runtimeDirectory, "missing"), f.directory);
      assertRefused(await f.deliver("read-analysis"), "analysis-input-refused");
    });
  }),
);

await test(
  "CLV-115 dangling chats ancestors are refused before missing-redaction classification",
  chatPlatformScenario(async () => {
    await withAnalysis(async (f) => {
      const chats = join(f.runtimeDirectory, "chats");
      await rm(chats, { recursive: true });
      await symlink(join(f.runtimeDirectory, "missing"), chats);
      assertRefused(await f.deliver("read-analysis"), "analysis-input-refused");
    });
  }),
);
