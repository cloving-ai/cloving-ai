import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { heldWork } from "../src/work-gap.ts";
import { activityOutput } from "../src/daemon/turn-activity.ts";
import { startTurn } from "../src/daemon/claude-turn.ts";
import { hostWorkReads } from "../tools/self-update-host.ts";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import {
  gatedHarness,
  harnessOutputs,
  harnessProcesses,
  openGate,
  operationFile,
  processGroup,
  stopHarnessGroups,
  transcriptLines,
} from "./harness-detached-fixture.ts";

const signal = new AbortController().signal;
const compared = [
  "summary",
  "costUsd",
  "estimatedCostUsd",
  "usage",
  "sessionId",
  "turns",
  "model",
] as const;

function picked(result: unknown): Readonly<Record<string, unknown>> {
  const fields = resultOf(result);
  return Object.fromEntries(compared.map((name) => [name, fields[name]]));
}

async function uninterrupted(scene: Scene, worker: string) {
  const harness = gatedHarness(scene, {
    worker,
    name: `${worker}-reference`,
    output: harnessOutputs[worker] ?? { head: [], tail: [] },
  });
  openGate(harness);
  const reference = intent({
    operationId: "operation-2",
    target: "ticket/two",
  });
  await scene.worker("unused", harness.settings).deliver(reference, signal);
  await until(() => scene.reports.length === 1);
  return {
    result: picked(scene.reports[0]?.result),
    transcript: transcriptLines(scene, "operation-2"),
  };
}

function keptLaunch(scene: Scene): unknown {
  return field(record(scene, "operation-1/started.json"), "launch");
}

async function keptTurn(
  scene: Scene,
  harness: ReturnType<typeof gatedHarness>,
) {
  const first = scene.worker("unused", harness.settings);
  await first.deliver(intent(), signal);
  await until(
    () =>
      transcriptLines(scene, "operation-1").length >= 1 &&
      harnessProcesses(harness).length === 1 &&
      keptLaunch(scene) !== undefined,
  );
  const [turn] = harnessProcesses(harness);
  assert.ok(turn);
  assert.equal(field(keptLaunch(scene), "processId"), turn.parentId);
  assert.equal(processGroup(turn.processId), turn.parentId);
  assert.notEqual(processGroup(turn.processId), processGroup(process.pid));
  const errors = { operationId: "operation-1", name: "turn.stderr.log" };
  assert.ok(existsSync(operationFile(scene, errors)));
  const reads = hostWorkReads({
    directory: scene.directory,
    runtimeDirectory: scene.directory,
  });
  assert.deepEqual(await heldWork(reads), []);
  await first.close({ turns: "keep" });
  assert.equal(alive(turn.processId), true);
  assert.equal(record(scene, "operation-1/result.json"), undefined);
}

for (const worker of Object.keys(harnessOutputs))
  await test(`CLV-349 a ${worker} turn keeps its process through a restart and ends with its result and its cost`, () =>
    withScene(async (scene) => {
      const reference = await uninterrupted(scene, worker);
      const harness = gatedHarness(scene, {
        worker,
        name: worker,
        output: harnessOutputs[worker] ?? { head: [], tail: [] },
      });
      try {
        await keptTurn(scene, harness);
        const noted: unknown[] = [];
        const next = scene.worker("unused", {
          ...harness.settings,
          recovered: (recovery) => noted.push(recovery),
        });
        assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
        assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
        openGate(harness);
        await until(() => scene.reports.length === 2);
        assert.equal(scene.reports[1]?.outcome, "completed");
        const result = picked(scene.reports[1].result);
        assert.deepEqual(result, reference.result);
        assert.equal(
          typeof (result["costUsd"] ?? result["estimatedCostUsd"]),
          "number",
        );
        assert.deepEqual(
          transcriptLines(scene, "operation-1"),
          reference.transcript,
        );
        assert.equal(harnessProcesses(harness).length, 1);
      } finally {
        stopHarnessGroups(harness);
      }
    }));

await test("CLV-349 a codex turn that ends while no worker runs ends with its result after the start", () =>
  withScene(async (scene) => {
    const reference = await uninterrupted(scene, "codex");
    const harness = gatedHarness(scene, {
      worker: "codex",
      name: "codex",
      output: harnessOutputs["codex"] ?? { head: [], tail: [] },
    });
    try {
      const first = scene.worker("unused", harness.settings);
      await first.deliver(intent(), signal);
      await until(
        () =>
          transcriptLines(scene, "operation-1").length >= 1 &&
          keptLaunch(scene) !== undefined,
      );
      await first.close({ turns: "keep" });
      openGate(harness);
      await until(() =>
        existsSync(
          operationFile(scene, {
            operationId: "operation-1",
            name: "turn.exit.json",
          }),
        ),
      );
      const next = scene.worker("unused", harness.settings);
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      await until(() => scene.reports.length === 2);
      assert.deepEqual(picked(scene.reports[1]?.result), reference.result);
      assert.deepEqual(
        transcriptLines(scene, "operation-1"),
        reference.transcript,
      );
    } finally {
      stopHarnessGroups(harness);
    }
  }));

await test("CLV-349 the startup recovery of a worker connects to a kept gemini turn", () =>
  withScene(async (scene) => {
    const harness = gatedHarness(scene, {
      worker: "gemini",
      name: "gemini",
      output: harnessOutputs["gemini"] ?? { head: [], tail: [] },
    });
    try {
      const first = scene.worker("unused", harness.settings);
      await first.deliver(intent(), signal);
      await until(() => keptLaunch(scene) !== undefined);
      await first.close({ turns: "keep" });
      const noted: unknown[] = [];
      const next = scene.worker("unused", {
        ...harness.settings,
        recovered: (recovery) => noted.push(recovery),
      });
      assert.equal(await next.hold(intent()), true);
      await next.recover(intent());
      assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
      openGate(harness);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
    } finally {
      stopHarnessGroups(harness);
    }
  }));

await test("CLV-349 a stop of a kept gemini turn that no worker follows is unknown, as for a kept Claude turn", () =>
  withScene(async (scene) => {
    const harness = gatedHarness(scene, {
      worker: "gemini",
      name: "gemini",
      output: harnessOutputs["gemini"] ?? { head: [], tail: [] },
    });
    try {
      const first = scene.worker("unused", harness.settings);
      await first.deliver(intent(), signal);
      await until(() => keptLaunch(scene) !== undefined);
      await first.close({ turns: "keep" });
      const next = scene.worker("unused", harness.settings);
      assert.equal((await next.stop(intent(), signal)).kind, "unknown");
      const [turn] = harnessProcesses(harness);
      assert.equal(alive(turn?.processId ?? 0), true);
      assert.equal(record(scene, "operation-1/result.json"), undefined);
    } finally {
      stopHarnessGroups(harness);
    }
  }));

await test("CLV-349 a shell harness turn keeps its process group through a restart and ends with its result", () =>
  withScene(async (scene) => {
    const harness = gatedHarness(scene, {
      worker: "codex",
      name: "codex",
      output: harnessOutputs["codex"] ?? { head: [], tail: [] },
    });
    const settings = {
      ...harness.settings,
      shell: "/bin/bash",
      harness: { name: "codex", kind: "shell" } as const,
    };
    try {
      const first = scene.worker("unused", settings);
      await first.deliver(intent(), signal);
      await until(
        () =>
          harnessProcesses(harness).length === 1 &&
          keptLaunch(scene) !== undefined,
      );
      const [turn] = harnessProcesses(harness);
      assert.ok(turn);
      const leader = field(keptLaunch(scene), "processId");
      assert.equal(processGroup(turn.processId), leader);
      await first.close({ turns: "keep" });
      assert.equal(alive(turn.processId), true);
      const next = scene.worker("unused", settings);
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      openGate(harness);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(
        resultOf(scene.reports[0].result)["summary"],
        "Ticket status: complete",
      );
    } finally {
      stopHarnessGroups(harness);
    }
  }));

await test("CLV-349 the README Restart section lists each kind of turn that keeps running and each kind that still stops", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(
    readme.indexOf("### Restart"),
    readme.indexOf("## Continuous process"),
  );
  for (const kind of [
    "- A Claude turn.",
    "- A turn of the Codex, Gemini, Cursor, OpenCode and Grok harnesses.",
    '- A turn of a shell harness (`kind: "shell"`).',
    "- A turn of the `host`, `seatbelt` and `container` runners.",
  ])
    assert.ok(
      section.includes(
        `These kinds of turns keep running through a restart:\n\n`,
      ) && section.includes(kind),
      kind,
    );
  assert.match(
    section.replaceAll("\n", " "),
    /A turn of a text harness \(a harness with `turn` and no stream output\) and a turn that waits for a retry still stop at a restart\./,
  );
});

await test("CLV-349 a later attempt in the pipe start appends its transcript after a blank line", async () => {
  const folder = mkdtempSync(join(tmpdir(), "cloving-activity-"));
  try {
    writeFileSync(join(folder, "turn.jsonl"), "first\n");
    const output = activityOutput({
      folder,
      laterAttempt: { folder, attempt: 2 },
      prompt: "Continue.",
    });
    await new Promise<void>((settle) => {
      output.end("second\n", () => {
        settle();
      });
    });
    assert.equal(
      readFileSync(join(folder, "turn.jsonl"), "utf8"),
      "first\n\nsecond\n",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const relativeCodex = [
  "#!/bin/sh",
  ...[
    ...(harnessOutputs["codex"]?.head ?? []),
    ...(harnessOutputs["codex"]?.tail ?? []),
  ].map((line) => `printf '%s\\n' '${JSON.stringify(line)}'`),
].join("\n");

await test("CLV-349 a stream turn finds its program in a relative or empty PATH folder from its work tree, keeps it, and ends with its result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-relative-path-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "tools"), { recursive: true });
    writeFileSync(join(tree, "tools", "relative-codex"), relativeCodex);
    chmodSync(join(tree, "tools", "relative-codex"), 0o755);
    for (const [place, folder] of [
      ["tools", tree],
      ["", join(tree, "tools")],
    ] as const) {
      const turn = startTurn({
        worker: "codex",
        command: ["relative-codex"],
        directory: folder,
        folder: directory,
        prompt: "Research",
        environment: { PATH: `${place}${delimiter}/usr/bin${delimiter}/bin` },
      });
      const ended = await turn.ended;
      assert.equal(ended.result?.text, "Ticket status: complete", place);
      assert.equal(typeof field(await turn.launch, "processId"), "number");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
