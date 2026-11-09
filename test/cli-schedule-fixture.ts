import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduleConnection } from "../src/daemon/schedule-control.ts";
import { workflowSchedules } from "../src/daemon/workflow-schedules.ts";
import type { DeclaredWorkflow } from "../src/workflow-declaration.ts";
import { scheduledWorkflow } from "./workflow-scheduler-fixture.ts";
import { withHarness, type Harness } from "./service-fixture.ts";

export async function withSchedule(
  body: (harness: Harness) => Promise<void>,
  scheduling: {
    readonly declarations: readonly DeclaredWorkflow[];
    readonly clock: number;
    readonly initial?: unknown;
  } = { declarations: [scheduledWorkflow], clock: 0 },
): Promise<void> {
  await withHarness(async (harness) => {
    await mkdir(join(harness.stateDirectory, "state"));
    if (scheduling.initial !== undefined)
      await writeFile(
        join(harness.stateDirectory, "state", "schedules.json"),
        JSON.stringify(scheduling.initial),
      );
    const connection = scheduleConnection();
    await harness.start({ schedule: connection.request });
    const scheduler = await workflowSchedules({
      directory: harness.stateDirectory,
      runtimeDirectory: harness.runtimeDirectory,
      declarations: scheduling.declarations,
      scheduleClock: () => scheduling.clock,
      submit: () =>
        Promise.resolve({ kind: "accepted", sequence: 1, intents: [] }),
    });
    connection.connect(scheduler.request);
    try {
      await body(harness);
    } finally {
      await scheduler.stop();
    }
  });
}
