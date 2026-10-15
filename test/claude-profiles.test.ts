import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checker, command, signal, turn } from "./claude-profiles-fixture.ts";
import {
  field,
  intent,
  journalKey,
  withScene,
} from "./claude-worker-fixture.ts";

await test("CLV-086 checker applies the operator environment, tools and budget with the journal turn ID", () =>
  withScene(async (scene) => {
    const observed = await turn(scene, {
      settings: {
        command: [
          ...command(scene),
          "--allowedTools",
          "Bash,Read",
          "--max-budget-usd",
          "5",
        ],
        profiles: { checker },
        workflowId: () => Promise.resolve("review-loop"),
      },
    });
    const turnId = `run-1-${journalKey("operation-1")}`;
    assert.equal(field(observed["env"], "REVIEW_ONLY"), "1");
    assert.equal(field(observed["env"], "TURN_NAME"), turnId);
    assert.equal(field(observed["env"], "CLOVING_TURN_ID"), turnId);
    assert.deepEqual(observed["arguments"], [
      "--allowedTools",
      "Read,Grep,Skill,Agent",
      "--max-budget-usd",
      "15",
    ]);
  }));

await test("CLV-086 an unknown profile refuses the effect before the command starts", () =>
  withScene(async (scene) => {
    const worker = scene.worker("bare", { command: command(scene) });
    assert.deepEqual(
      await worker.deliver(intent({ method: "run-turn:unknown" }), signal),
      {
        kind: "failed",
        reason: "unknown-profile",
      },
    );
    assert.equal(existsSync(join(scene.directory, "profile-ran")), false);
    assert.equal(existsSync(scene.journal), false);
  }));

await test("CLV-086 fixer follows checker without inheriting its environment and unprofiled turns keep their command", () =>
  withScene(async (scene) => {
    const argumentsList = [
      "--allowedTools",
      "Read",
      "Bash",
      "--model",
      "sonnet",
      "prompt",
    ];
    const settings = {
      command: [...command(scene), ...argumentsList],
      profiles: { checker, fixer: { env: { TURN_NAME: "{turn}/{turn}" } } },
      workflowId: () => Promise.resolve("review-loop"),
    };
    await turn(scene, { settings });
    const fixed = await turn(scene, { method: "run-turn:fixer", settings });
    const turnId = `run-1-${journalKey("operation-2")}`;
    assert.equal(field(fixed["env"], "REVIEW_ONLY"), undefined);
    assert.equal(field(fixed["env"], "TURN_NAME"), `${turnId}/${turnId}`);
    assert.equal(field(fixed["env"], "CLOVING_TURN_ID"), turnId);
    assert.deepEqual(fixed["arguments"], argumentsList);
    const plain = await turn(scene, { method: "run-turn", settings });
    assert.deepEqual(plain["arguments"], argumentsList);
    assert.equal(field(plain["env"], "TURN_NAME"), undefined);
    assert.equal(field(plain["env"], "REVIEW_ONLY"), undefined);
    assert.equal(
      field(plain["env"], "CLOVING_TURN_ID"),
      `run-1-${journalKey("operation-3")}`,
    );
  }));

const refusalCases = [
  { settings: { profiles: {} }, reason: "unknown-profile" },
  { settings: {}, reason: "profile-not-allowed" },
  {
    settings: { workflowId: () => Promise.resolve(undefined) },
    reason: "profile-not-allowed",
  },
  {
    settings: { workflowId: () => Promise.resolve("other") },
    reason: "profile-not-allowed",
  },
  {
    settings: {
      workflowId: () => Promise.reject(new Error("unavailable")),
    },
    reason: "profile-not-allowed",
  },
  {
    settings: {
      workflowId: (): Promise<string> => {
        throw new Error("unavailable synchronously");
      },
    },
    reason: "profile-not-allowed",
  },
  {
    settings: { worker: "codex" as const },
    reason: "profile-needs-claude",
  },
];

await test("CLV-086 profile refusals never run a command or create a journal", () =>
  withScene(async (scene) => {
    const base = { command: command(scene), profiles: { checker } };
    for (const { settings, reason } of refusalCases) {
      const worker = scene.worker("bare", { ...base, ...settings });
      assert.deepEqual(
        await worker.deliver(
          intent({ method: "run-turn:checker", workflow: "review-loop" }),
          signal,
        ),
        { kind: "failed", reason },
      );
    }
    const inherited = scene.worker("bare", { ...base, profiles: {} });
    assert.deepEqual(
      await inherited.deliver(
        intent({ method: "run-turn:constructor" }),
        signal,
      ),
      { kind: "failed", reason: "unknown-profile" },
    );
    assert.equal(existsSync(join(scene.directory, "profile-ran")), false);
    assert.equal(existsSync(scene.journal), false);
  }));

const commandCases = [
  {
    before: ["-p"],
    profile: { model: "opus" },
    after: ["-p", "--model", "opus"],
  },
  {
    before: ["--allowedTools", "Read", "Bash", "--verbose"],
    profile: { allowedTools: ["Skill", "Agent"] },
    after: ["--verbose", "--allowedTools", "Skill,Agent"],
  },
  {
    before: ["--model", "sonnet", "prompt text"],
    profile: { model: "opus" },
    after: ["prompt text", "--model", "opus"],
  },
  {
    before: ["--model=sonnet", "--", "--model", "untouched", "prompt"],
    profile: { model: "opus" },
    after: ["--model", "opus", "--", "--model", "untouched", "prompt"],
  },
  {
    before: [
      "--allowed-tools=Read,Bash",
      "--allowedTools",
      "Read",
      "Bash",
      "--permission-mode=acceptEdits",
      "--max-budget-usd=5",
      "--model",
      "sonnet",
    ],
    profile: { allowedTools: [], permissionMode: "plan", maxBudgetUsd: 15 },
    after: [
      "--model",
      "sonnet",
      "--allowedTools",
      "",
      "--permission-mode",
      "plan",
      "--max-budget-usd",
      "15",
    ],
  },
  {
    before: ["--allowed-tools", "Read", "Bash", "--", "Read", "Bash"],
    profile: { allowedTools: ["Grep"] },
    after: ["--allowedTools", "Grep", "--", "Read", "Bash"],
  },
  {
    before: [
      "--permission-mode",
      "acceptEdits",
      "prompt",
      "--model=sonnet",
      "--model",
      "haiku",
    ],
    profile: { permissionMode: "plan", model: "opus" },
    after: ["prompt", "--model", "opus", "--permission-mode", "plan"],
  },
];

await test("CLV-086 command overrides preserve other arguments and the first double dash boundary", () =>
  withScene(async (scene) => {
    for (const item of commandCases) {
      const observed = await turn(scene, {
        settings: {
          command: [...command(scene), ...item.before],
          profiles: { checker: item.profile },
        },
      });
      assert.deepEqual(observed["arguments"], item.after);
    }
  }));
