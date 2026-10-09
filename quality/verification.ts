import type {
  VerificationInputs,
  VerificationPlan,
  VerificationReceipt,
} from "./verification-types.ts";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import {
  captureVerificationInputs,
  snapshotVerificationInputs,
} from "./verification-inputs.ts";
import { captureExecution } from "./verification-process.ts";

export async function executeVerification(
  proposedPlan: VerificationPlan,
  proposedInventory: VerificationInputs,
): Promise<VerificationReceipt> {
  const inventory = structuredClone(proposedInventory);
  const copiedPlan = structuredClone(proposedPlan);
  validatePlan(copiedPlan);
  const commands = await Promise.all(
    copiedPlan.commands.map(async (command) => ({
      ...command,
      executable: await realpath(command.executable),
      directory: await realpath(command.directory),
    })),
  );
  const plan = { ...copiedPlan, commands };
  const tools = await Promise.all(
    inventory.tools.map((file) => realpath(file)),
  );
  for (const command of plan.commands) {
    if (!tools.includes(await realpath(command.executable)))
      throw new Error("unbound-verification-tool");
  }
  const snapshot = await snapshotVerificationInputs(inventory);
  const inputs = snapshot.identity;
  const executions = [];
  for (const command of plan.commands) {
    executions.push(await captureExecution(command));
  }
  if (inputs !== (await captureVerificationInputs(inventory)))
    throw new Error("verification-inputs-changed");
  const record = {
    authority: "diagnostic-only" as const,
    inputs,
    inventory: snapshot,
    plan,
    executions,
  };
  return { identity: digest(record), ...record };
}

export function validateVerificationReceipt(
  receipt: VerificationReceipt,
  expected: {
    readonly identity: string;
    readonly inputs: string;
    readonly requiredChecks: readonly string[];
  },
): void {
  const { identity, ...record } = receipt;
  if (identity !== expected.identity || identity !== digest(record))
    throw new Error("invalid-verification-receipt");
  if (receipt.inputs !== expected.inputs)
    throw new Error("stale-verification-inputs");
  validatePlan(receipt.plan);
  if (
    JSON.stringify(receipt.plan.requiredChecks) !==
    JSON.stringify(expected.requiredChecks)
  )
    throw new Error("missing-required-verification-check");
  if (
    JSON.stringify(receipt.executions.map((item) => item.id)) !==
    JSON.stringify(receipt.plan.requiredChecks)
  )
    throw new Error("missing-verification-execution");
  if (
    receipt.executions.some(
      (item) => item.exit !== 0 || item.error !== null || item.signal !== null,
    )
  )
    throw new Error("verification-failed");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validatePlan(plan: VerificationPlan): void {
  const identities = plan.commands.map((command) => command.id);
  if (
    identities.length === 0 ||
    identities.some((identity) => identity.trim().length === 0) ||
    new Set(identities).size !== identities.length ||
    JSON.stringify(identities) !== JSON.stringify(plan.requiredChecks)
  )
    throw new Error("invalid-verification-plan");
  for (const command of plan.commands) {
    if (
      !isAbsolute(command.executable) ||
      !isAbsolute(command.directory) ||
      !Number.isFinite(command.timeoutMilliseconds) ||
      command.timeoutMilliseconds <= 0
    )
      throw new Error("invalid-verification-command");
  }
}
