import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { removeTemporaryDirectories } from "./authority-store-fixture.ts";
import { until } from "./claude-worker-fixture.ts";
import { withGithub } from "./github-worker-fixture.ts";
import {
  recoveryWorker,
  withRecovery,
  completedRecovery,
} from "./github-work-recovery-fixture.ts";
import { start, request } from "./queue-work-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-377 interrupting and reopening the real GitHub worker adopts its retained owned verification stage without a capacity gap", () =>
  withGithub((scene) =>
    withRecovery(scene, async (given) => {
      const { authority, marker } = given;
      await using first = recoveryWorker(scene, { ...given, mode: "first" });
      await first.ready();
      await until(() => existsSync(marker));
      await first.kill();
      assert.equal(
        (await authority.events()).filter(
          (event) => event.type === "operation.work-entered",
        ).length,
        1,
      );
      assert.equal(
        (await authority.events()).filter(
          (event) => event.type === "operation.work-left",
        ).length,
        0,
      );
      await start(authority, { runId: "waiting" });
      assert.equal(
        (await request(authority, { runId: "waiting" })).status,
        "waiting",
      );
      await using reopened = recoveryWorker(scene, {
        ...given,
        mode: "reopen",
      });
      await reopened.ready();
      await until(
        () =>
          readFileSync(marker, "utf8").split("check").length > 2 ||
          reopened.state.report !== undefined,
      );
      assert.equal(
        reopened.state.report,
        undefined,
        JSON.stringify(reopened.state),
      );
      assert.equal(
        (await authority.effects.operations("waiting"))[0]?.status,
        "waiting",
      );
      await completedRecovery(reopened, given);
      assert.equal(
        (await authority.effects.operations("waiting"))[0]?.status,
        "dispatch-pending",
      );
    }),
  ));

await test("CLV-377 a reopened GitHub worker reconciles a committed leave with a lost reply and reacquires normal current work capacity", () =>
  withGithub((scene) =>
    withRecovery(scene, async (given) => {
      const { authority, marker, release, limits } = given;
      writeFileSync(release, "go");
      await using first = recoveryWorker(scene, {
        ...given,
        mode: "first",
        leaveReply: "hold",
      });
      await first.ready();
      await until(() =>
        first.state.work.some(
          (row) => row.action === "leave" && row.kind === "accepted",
        ),
      );
      await first.kill();
      await start(authority, { runId: "blocking" });
      assert.equal(
        (await request(authority, { runId: "blocking" })).status,
        "dispatch-pending",
      );
      await using reopened = recoveryWorker(scene, {
        ...given,
        mode: "reopen",
      });
      await reopened.ready();
      await until(
        () =>
          reopened.state.work.some(
            (row) => row.reason === "queue-working-capacity-exceeded",
          ) || reopened.state.report !== undefined,
      );
      assert.equal(
        reopened.state.report,
        undefined,
        JSON.stringify(reopened.state),
      );
      assert.equal(readFileSync(marker, "utf8").split("check").length, 2);
      limits.queueWorkingLimit = 2;
      await completedRecovery(reopened, given);
      assert.equal(readFileSync(marker, "utf8").split("check").length, 3);
      const stages = (await authority.events()).filter(
        (event) => event.type === "operation.work-entered",
      );
      assert.equal(
        new Set(stages.map((event) => event.payload["stageId"])).size,
        2,
      );
    }),
  ));
