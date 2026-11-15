import type { QueueSettingRequest } from "../src/queue-setting-operation.ts";

export const declared = {
  workflowId: "alpha",
  functionName: "alpha",
  effectLimit: 1,
  capabilities: ["claude"],
  input: { maximumBytes: 100, fields: { ticket: { type: "ticket" } } },
  queue: { lanes: 3 },
} as const;
export const request: QueueSettingRequest = {
  commandId: "edit",
  scope: "workflow",
  workflowId: "alpha",
  field: "lanes",
  action: "set",
  expectedValue: 3,
  value: 2,
};
export const settings = {
  turnSettings: {
    profiles: { review: { model: "new" } },
    fallbackModels: [],
    tokenPrices: {},
  },
  settingDigests: {
    queues: "old:new",
    profiles: "new",
    "effects.reserved": "new",
  },
  queueLimits: { lanes: 2, workingLanes: 1, reserved: 3 },
  queueWorkflowLimits: { alpha: { lanes: 2, workingLanes: 1, reserved: 3 } },
};
export function command(output: unknown) {
  return [
    process.execPath,
    "-e",
    `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`,
    "--",
  ];
}
