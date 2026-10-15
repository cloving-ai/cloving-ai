import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeWorkerSettings } from "../src/daemon/claude-worker.ts";
import {
  intent,
  journalKey,
  resultOf,
  until,
  type Scene,
} from "./claude-worker-fixture.ts";

export const checker = {
  env: { REVIEW_ONLY: "1", TURN_NAME: "{turn}" },
  allowedTools: ["Read", "Grep", "Skill", "Agent"],
  maxBudgetUsd: 15,
  workflows: ["review-loop"],
};

export const signal = new AbortController().signal;

export function command(scene: Scene): readonly string[] {
  const script = join(scene.directory, "profile-worker.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
for await (const chunk of process.stdin) String(chunk);
writeFileSync(${JSON.stringify(join(scene.directory, "profile-ran"))}, "ran");
const names = ["REVIEW_ONLY", "TURN_NAME", "CLOVING_TURN_ID", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR"];
const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ env, arguments: process.argv.slice(2) }) }));
`,
  );
  return [process.execPath, script];
}

export async function turn(
  scene: Scene,
  options: {
    readonly method?: string;
    readonly settings: Partial<ClaudeWorkerSettings>;
  },
): Promise<Readonly<Record<string, unknown>>> {
  const operationId = `operation-${String(scene.reports.length + 1)}`;
  const worker = scene.worker("bare", options.settings);
  assert.deepEqual(
    await worker.deliver(
      intent({ operationId, method: options.method ?? "run-turn:checker" }),
      signal,
    ),
    { receipt: journalKey(operationId), worker: "claude" },
  );
  await until(() =>
    scene.reports.some((item) => item.operationId === operationId),
  );
  const report = scene.reports.find((item) => item.operationId === operationId);
  assert.equal(report?.outcome, "completed");
  return resultOf(resultOf(report.result)["summary"]);
}
