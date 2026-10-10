import type { TreeSnapshot } from "./tree-snapshot.ts";
import type {
  VerificationInputs,
  VerificationReceipt,
} from "./verification-types.ts";
import type { VerifierActivation } from "./verifier-activation.ts";
import { join, sep } from "node:path";
import { parseReport } from "./acceptance-evidence.ts";
import { validateVerificationReceipt } from "./verification.ts";
import { captureVerificationInputs } from "./verification-inputs.ts";

export async function checkDiagnosticEvidence(
  receipt: VerificationReceipt,
  trusted: {
    readonly activation: VerifierActivation;
    readonly directory: string;
    readonly snapshot: TreeSnapshot;
    readonly executable: string;
  },
): Promise<void> {
  const { plan } = trusted.activation;
  const inventory = recordedInventory(receipt);
  validateVerificationReceipt(receipt, {
    identity: receipt.identity,
    inputs: await captureVerificationInputs(inventory),
    requiredChecks: plan.diagnosticChecks,
  });
  const files = firstPartyFiles(trusted.directory, trusted.snapshot);
  checkDiagnosticCommands(receipt, { ...trusted, files });
  checkInventoryCoverage(inventory, { directory: trusted.directory, files });
  const completed = receipt.executions
    .map((execution) => reportedTests(execution.stdout))
    .reduce((total, count) => total + count, 0);
  if (completed < plan.minimumTests)
    throw new Error("insufficient-diagnostic-tests");
}

function checkDiagnosticCommands(
  receipt: VerificationReceipt,
  trusted: {
    readonly activation: VerifierActivation;
    readonly directory: string;
    readonly executable: string;
    readonly files: readonly string[];
  },
): void {
  const { activation } = trusted;
  const tests = trusted.files
    .filter(
      (file) =>
        file.startsWith(join(trusted.directory, "test") + sep) &&
        file.endsWith(".test.ts"),
    )
    .sort();
  const expected = JSON.stringify([
    ...activation.plan.confinement,
    trusted.executable,
    "--test",
    "--test-concurrency=2",
    `--test-reporter=${join(activation.verifier.directory, "quality/test-reporter.ts")}`,
    ...tests,
  ]);
  for (const command of receipt.plan.commands) {
    if (
      command.directory !== trusted.directory ||
      JSON.stringify([command.executable, ...command.arguments]) !== expected
    )
      throw new Error("untrusted-diagnostic-command");
  }
}

function checkInventoryCoverage(
  inventory: VerificationInputs,
  candidate: { readonly directory: string; readonly files: readonly string[] },
): void {
  const { directory, files } = candidate;
  const covered = new Set([
    ...inventory.source,
    ...inventory.tests,
    ...inventory.dependencies,
  ]);
  const tests = files.filter((file) =>
    file.startsWith(join(directory, "test") + sep),
  );
  if (
    covered.size !== files.length ||
    files.some((file) => !covered.has(file)) ||
    JSON.stringify([...inventory.tests].sort()) !==
      JSON.stringify([...tests].sort())
  )
    throw new Error("incomplete-diagnostic-inventory");
}

function firstPartyFiles(directory: string, snapshot: TreeSnapshot): string[] {
  return Object.entries(snapshot.entries)
    .filter(
      ([name, entry]) =>
        parseReport(entry)?.["kind"] === "file" &&
        !name.startsWith(`node_modules${sep}`) &&
        !name.startsWith(`dist${sep}`),
    )
    .map(([name]) => join(directory, name))
    .sort();
}

function recordedInventory(receipt: VerificationReceipt): VerificationInputs {
  const files = (kind: keyof VerificationInputs): string[] =>
    (receipt.inventory.groups[kind] ?? []).map((entry) => {
      const path = parseReport(entry)?.["path"];
      if (typeof path !== "string")
        throw new Error("invalid-verification-receipt");
      return path;
    });
  return {
    source: files("source"),
    tests: files("tests"),
    dependencies: files("dependencies"),
    tools: files("tools"),
    policy: files("policy"),
    exceptions: files("exceptions"),
  };
}

function reportedTests(output: string): number {
  const report = parseReport(output);
  if (!report) return 0;
  const { completed, failures, skipped } = report;
  if (
    typeof completed !== "number" ||
    !Array.isArray(failures) ||
    !Array.isArray(skipped) ||
    failures.length > 0 ||
    skipped.length > 0
  )
    throw new Error("insufficient-diagnostic-tests");
  return completed;
}
