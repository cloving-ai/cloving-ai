import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { workspacePermits } from "../src/cli/workspace-permit.ts";
import { eventually } from "./service-fixture.ts";
import {
  failedDetail,
  restarted,
  withSupervisor,
} from "./workspace-restart-fixture.ts";

await test("CLV-312 the workspace restart holds the queue runs of all repositories and restarts all repositories at a common gap", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha, beta] = members;
    assert.ok(alpha !== undefined && beta !== undefined);
    alpha.active = true;
    const reply = restarted(folder, {
      commandId: "restart-1",
      at: "gap",
      resumeQueue: true,
    });
    const permit = workspacePermits(join(folder, "control.sock"));
    await eventually(async () => {
      const held = await permit();
      return held.kind === "held" && held.hold.reason === "workspace-restart"
        ? held
        : undefined;
    });
    const reads = alpha.gapReads;
    await eventually(() => (alpha.gapReads >= reads + 2 ? true : undefined));
    assert.deepEqual(
      members.map((member) => member.restarts.length),
      [0, 0],
    );
    alpha.active = false;
    assert.deepEqual(await reply, {
      kind: "result",
      result: {
        kind: "workspace-restart",
        commandId: "restart-1",
        repositories: [
          { name: "alpha", serviceStartedAt: "alpha-start-restarted" },
          { name: "beta", serviceStartedAt: "beta-start-restarted" },
        ],
      },
    });
    assert.deepEqual(
      members.map((member) => member.restarts),
      [
        [{ commandId: "restart-1", at: "now", resumeQueue: true }],
        [{ commandId: "restart-1", at: "now", resumeQueue: true }],
      ],
    );
    assert.equal((await permit()).kind, "admitted");
  }));

await test("CLV-312 a workspace restart at now does not wait for a gap, and a second restart with another command ID is refused while one is pending", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha] = members;
    assert.ok(alpha !== undefined);
    alpha.active = true;
    const first = restarted(folder, { commandId: "slow", at: "gap" });
    await eventually(async () => {
      const held = await workspacePermits(join(folder, "control.sock"))();
      return held.kind === "held" ? held : undefined;
    });
    const second = await restarted(folder, { commandId: "other", at: "now" });
    assert.ok(second.kind === "error");
    assert.equal(second.error.code, "workspace-restart-pending");
    alpha.active = false;
    assert.equal((await first).kind, "result");
    alpha.active = true;
    const now = await restarted(folder, {
      commandId: "fast",
      at: "now",
      settings: "files",
    });
    assert.equal(now.kind, "result");
    assert.deepEqual(alpha.restarts.at(-1), {
      commandId: "fast",
      at: "now",
      settings: "files",
    });
    const invalid = await restarted(folder, { commandId: "bad", at: "later" });
    assert.ok(invalid.kind === "error");
    assert.equal(invalid.error.code, "invalid-request");
  }));

await test("CLV-312 a repeated workspace restart with the same command ID joins the pending restart, a refusal of one repository fails the restart, and a stop of the supervisor ends a pending restart", () =>
  withSupervisor(async ({ folder, members, close }) => {
    const [alpha, beta] = members;
    assert.ok(alpha !== undefined && beta !== undefined);
    alpha.active = true;
    const first = restarted(folder, { commandId: "same" });
    const second = restarted(folder, { commandId: "same" });
    await eventually(() => (alpha.gapReads >= 2 ? true : undefined));
    alpha.active = false;
    assert.deepEqual(await second, await first);
    beta.refuses = true;
    const refused = await restarted(folder, {
      commandId: "refused",
      at: "now",
    });
    assert.ok(refused.kind === "error");
    assert.equal(refused.error.code, "workspace-restart-failed");
    assert.match(refused.error.detail, /beta \(restart-unavailable\)/);
    alpha.active = true;
    const reads = alpha.gapReads;
    const stopped = restarted(folder, { commandId: "stopped" });
    await eventually(() => (alpha.gapReads > reads ? true : undefined));
    await close();
    assert.equal((await stopped).kind, "error");
  }));

await test("CLV-312 a permit request that the supervisor reads while a workspace restart arrives gets the restart hold", () =>
  withSupervisor(
    async ({ folder, members }) => {
      const [alpha] = members;
      assert.ok(alpha !== undefined);
      const answer = Promise.withResolvers<undefined>();
      alpha.queueAnswer = answer.promise;
      const permit = workspacePermits(join(folder, "control.sock"))();
      await eventually(() => (alpha.queueReads >= 1 ? true : undefined));
      alpha.active = true;
      const reads = alpha.gapReads;
      const reply = restarted(folder, { commandId: "during-reads" });
      await eventually(() => (alpha.gapReads > reads ? true : undefined));
      answer.resolve(undefined);
      const held = await permit;
      assert.ok(held.kind === "held");
      assert.equal(held.hold.reason, "workspace-restart");
      alpha.active = false;
      assert.equal((await reply).kind, "result");
    },
    { limits: { lanes: 4 } },
  ));

await test("CLV-312 a workspace restart at a gap waits until every granted permit ends", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha] = members;
    assert.ok(alpha !== undefined);
    const granted = await workspacePermits(join(folder, "control.sock"))();
    assert.ok(granted.kind === "admitted");
    const reads = alpha.gapReads;
    const reply = restarted(folder, { commandId: "after-permit", at: "gap" });
    await eventually(() => (alpha.gapReads >= reads + 2 ? true : undefined));
    assert.deepEqual(
      members.map((member) => member.restarts.length),
      [0, 0],
    );
    granted.release();
    assert.equal((await reply).kind, "result");
    assert.deepEqual(
      members.map((member) => member.restarts.length),
      [1, 1],
    );
  }));

await test("CLV-312 a workspace restart keeps waiting while a repository does not answer the gap read", () =>
  withSupervisor(async ({ folder, members }) => {
    const [, beta] = members;
    assert.ok(beta !== undefined);
    const before = await restarted(folder, { commandId: "before" });
    assert.equal(before.kind, "result");
    beta.down = true;
    const reads = beta.gapReads;
    const reply = restarted(folder, { commandId: "while-down", at: "gap" });
    await eventually(() => (beta.gapReads >= reads + 2 ? true : undefined));
    beta.down = false;
    assert.equal((await reply).kind, "result");
  }));

await test("CLV-337 a workspace restart that keeps turns does not wait for a gap and asks each repository to keep its turns", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha] = members;
    assert.ok(alpha !== undefined);
    alpha.active = true;
    const kept = await restarted(folder, { commandId: "kept", at: "keep" });
    assert.equal(kept.kind, "result");
    assert.deepEqual(
      members.map((member) => member.restarts.at(-1)?.["at"]),
      ["keep", "keep"],
    );
  }));

await test("CLV-312 a workspace restart sends the command ID of the request to each repository, also an ID of 128 characters", () =>
  withSupervisor(async ({ folder, members }) => {
    const commandId = "a".repeat(128);
    assert.equal(
      (await restarted(folder, { commandId, at: "now" })).kind,
      "result",
    );
    assert.deepEqual(
      members.map((member) => member.restarts.at(-1)?.["commandId"]),
      [commandId, commandId],
    );
  }));

await test("CLV-312 a workspace restart fails and ends its queue hold when a repository fails its restart, another command cancels it, or the new service refuses a queue workflow", () =>
  withSupervisor(async ({ folder, members }) => {
    const [alpha, beta] = members;
    assert.ok(alpha !== undefined && beta !== undefined);
    beta.fails = "restart-build-failed";
    assert.match(
      await failedDetail(folder, "build"),
      /: beta \(restart-build-failed\)\.$/,
    );
    beta.fails = undefined;
    beta.cancels = true;
    alpha.bare = true;
    assert.match(
      await failedDetail(folder, "cancelled"),
      /: alpha \(restart-reply-invalid\), beta \(restart-cancelled\)\.$/,
    );
    alpha.bare = false;
    beta.cancels = false;
    beta.admits = [];
    assert.equal(
      await failedDetail(folder, "workflow"),
      [
        "The restart failed in these repositories: beta (restart-workflow-refused).",
        "beta: queue workflow develop: workflow-missing",
      ].join("\n"),
    );
  }));

await test("CLV-312 a workspace restart fails and names the repository when its service accepts a connection but does not answer", () =>
  withSupervisor(
    async ({ folder, members }) => {
      const [alpha, beta] = members;
      assert.ok(alpha !== undefined && beta !== undefined);
      beta.mute = "status";
      assert.match(
        await failedDetail(folder, "unanswered"),
        /: beta \(restart-start-unanswered\)\.$/,
      );
      beta.mute = undefined;
      alpha.mute = "restart";
      assert.match(
        await failedDetail(folder, "no-reply"),
        /: alpha \(outcome-unknown\)\.$/,
      );
    },
    { answerMilliseconds: 200 },
  ));
