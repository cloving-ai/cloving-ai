import assert from "node:assert/strict";
import type { ProtectedResult } from "cloving/workflows";
import { fakeStepBridge } from "cloving/workflows/testing";
import { release } from "../release.ts";
import {
  approvals,
  commit,
  completed,
  effects,
  input,
  merged,
  methods,
  pullStates,
  ready,
  reported,
  waits,
} from "./scenarios.ts";

export interface ReleaseTest {
  readonly name: string;
  readonly run: () => Promise<void>;
}

type Changed = Readonly<Record<string, readonly ProtectedResult[]>>;

async function blockedBy(changed: Changed, reason: string): Promise<void> {
  using bridge = fakeStepBridge({
    effects: { ...effects(), ...changed },
    commandWaits: waits(),
    decisions: approvals(),
  });
  assert.deepEqual(await release(input), {
    kind: "blocked",
    cycleId: "release-1",
    reason,
    evidenceId: "release",
  });
  assert.equal(methods(bridge.requests).includes("wait release-status"), false);
}

export const refusalTests: ReleaseTest[] = [
  {
    name: "CLV-304 an invalid prepare, turn or pull request result, or a report with no release notes, blocks the release",
    run: async () => {
      const open = completed({ number: 650, url: "pull/650", commit: "main" });
      for (const [changed, reason] of [
        [
          { "github prepare": [completed({ base: "../main" })] },
          "invalid-release-result",
        ],
        [{ "github prepare": [completed(["main"])] }, "invalid-release-result"],
        [
          { "claude run-turn": [reported("Set the version.")] },
          "release-notes-missing",
        ],
        [
          { "claude run-turn": [reported("Release notes:\n")] },
          "release-notes-missing",
        ],
        [
          { "claude run-turn": [completed({ commit })] },
          "invalid-release-report",
        ],
        [{ "github open-pr": [open] }, "invalid-pull-request"],
      ] as const)
        await blockedBy(changed, reason);
    },
  },
  {
    name: "CLV-304 a failed push-tag command or an invalid push-tag result blocks the release before the status wait",
    run: async () => {
      const unreadable: ProtectedResult = {
        kind: "completed",
        operationId: "tag",
        receipt: null,
        result: "{",
      };
      const failed: ProtectedResult = {
        kind: "failed",
        operationId: "tag",
        reason: "command-failed",
      };
      for (const [result, reason] of [
        [
          completed({ tag: "v1.6.0", commit: merged }),
          "invalid-push-tag-result",
        ],
        [
          completed({ tag: "v1.7.0", commit: "HEAD" }),
          "invalid-push-tag-result",
        ],
        [unreadable, "invalid-push-tag-result"],
        [failed, "command-failed"],
      ] as const)
        await blockedBy({ "command run:push-tag": [result] }, reason);
    },
  },
  {
    name: "CLV-304 a pull request status with an open or a missing pull request blocks the release",
    run: async () => {
      for (const answer of [
        pullStates([
          [641, "merged"],
          [643, "open"],
        ]),
        pullStates([[641, "merged"]]),
        ready({ pulls: "641" }),
        ready({ pulls: [{ number: "641", state: "merged" }] }),
        ready([]),
      ]) {
        using bridge = fakeStepBridge({
          effects: effects(),
          commandWaits: { "release-pulls": [answer] },
          decisions: approvals(),
        });
        assert.deepEqual(await release(input), {
          kind: "blocked",
          cycleId: "release-1",
          reason: "invalid-release-status",
          evidenceId: "release",
        });
        assert.deepEqual(methods(bridge.requests), ["wait release-pulls"]);
      }
    },
  },
];
