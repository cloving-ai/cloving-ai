import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import { listen } from "../src/service/transport.ts";
import { withHarness } from "./service-fixture.ts";

interface PendingScene {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly mark: string;
  readonly lines: string[];
  readonly counts: { scans: number; submissions: number };
  readonly submittedWorkflowIds: string[];
  readonly commands: () => Promise<string>;
  readonly stop: () => Promise<void>;
}

export async function withPendingUpdate(
  timestamp: number,
  body: (scene: PendingScene) => Promise<void>,
): Promise<void> {
  await withHarness(async (harness) => {
    const { stateDirectory: directory, runtimeDirectory } = harness;
    const { workflow } = await writeDeclaredWorkflow(harness.projectDirectory);
    const mark = join(directory, "pending-self-update");
    await writeFile(mark, `${String(timestamp)}\n`);
    const counts = { scans: 0, submissions: 0 };
    const submittedWorkflowIds: string[] = [];
    const lines: string[] = [];
    const output = process.stderr.write.bind(process.stderr);
    process.stderr.write = (line: string | Uint8Array) => {
      lines.push(String(line));
      return true;
    };
    const listener = await listen({
      path: join(runtimeDirectory, "control.sock"),
      handle: (request) => {
        if (request.operation === "status") {
          counts.scans += 1;
          return Promise.resolve({
            kind: "result",
            result: { runs: [], next: null },
          });
        }
        counts.submissions += 1;
        submittedWorkflowIds.push(String(request.parameters["workflowId"]));
        return Promise.resolve({
          kind: "error",
          error: { code: "no-ready-ticket", detail: "No ready ticket." },
        });
      },
    });
    const queue = issueQueue({
      workflowId: workflow.workflowId,
      directory,
      runtimeDirectory,
      intervalMilliseconds: 5,
    });
    try {
      await body({
        directory,
        runtimeDirectory,
        mark,
        lines,
        counts,
        submittedWorkflowIds,
        stop: queue.stop,
        commands: () =>
          readFile(join(directory, "queue-commands.json"), "utf8"),
      });
    } finally {
      await queue.stop();
      await listener.close();
      process.stderr.write = output;
    }
  });
}
