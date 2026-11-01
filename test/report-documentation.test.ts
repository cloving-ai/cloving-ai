import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  configuredReportCli,
  fixRoundEvents,
  reportReply,
  withReportSource,
} from "./report-fixture.ts";

const names = [
  "ci.jobMinutes.localMacos",
  "ci.jobLimitShare.localMacos",
  "ci.runnerWaitMinutes.localMacos",
  "ci.timeouts",
  "ci.reruns",
  "operator.merges",
  "operator.labelChanges",
  "quality.mainFirstPassShare",
  "quality.flakyFailures",
  "quality.realFailures",
  "quality.revertedPullRequests",
  "quality.reopenedTickets",
  "quality.reviewScore.round1",
  "fixRounds.medianPerMergedPullRequest",
  "leadTime.medianHours",
  "phases.workerTurn.medianMinutes",
  "phases.codeReview.medianMinutes",
  "phases.merge.medianMinutes",
  "cost.medianCompletedTicketUsd",
  "flow.busyLaneShare",
  "flow.idleLaneHoursWithReadyTicket",
  "flow.peakActiveRuns",
  "flow.readyWaitHours.dependency",
  "flow.readyWaitHours.noLane",
  "flow.scheduleSkips",
  "flow.unsuccessfulStreak.current",
  "flow.unsuccessfulStreak.longest",
];

await test("CLV-243 README documents every new report value and completed-ticket details", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const section = readme.slice(
    readme.indexOf("Run `cloving report"),
    readme.indexOf("## Daily development"),
  );
  for (const name of [...names, "completedTicketCosts"])
    assert.ok(section.includes(name), name);
});

await test("CLV-243 text report shows new medians, evidence and completed-ticket details", async () => {
  await withReportSource(
    reportReply(fixRoundEvents(Date.now() - 3_600_000)),
    async (harness) => {
      const output = await configuredReportCli(harness, []);
      for (const name of names)
        assert.ok(output.stdout.includes(`${name}:`), name);
      assert.match(output.stdout, /fixRounds.medianPerMergedPullRequest: 1/);
      assert.match(output.stdout, /leadTime.medianHours: 30/);
      assert.match(output.stdout, /Completed ticket costs \(USD\):/);
      assert.match(output.stdout, /evidence:.*pullRequest/);
    },
  );
});
