import type { AcceptancePlan } from "./acceptance-plan.ts";
import type { VerifierInstallation } from "./verifier-installation.ts";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleAcceptancePlan, isAcceptancePlan } from "./acceptance-plan.ts";
import { assertVerifierInstallation } from "./verifier-installation.ts";

export interface VerifierActivation {
  readonly identity: string;
  readonly verifier: VerifierInstallation;
  readonly plan: AcceptancePlan;
  readonly review: string;
}

export async function activateVerifier(
  state: string,
  installation: VerifierInstallation,
  proposedPlan: AcceptancePlan,
): Promise<VerifierActivation> {
  const directory = await realpath(state);
  const verifier = structuredClone(installation);
  await assertVerifierInstallation(verifier);
  const plan = currentPlan(proposedPlan);
  const review = await approvedReview(directory, verifier, plan);
  const record = { verifier, plan, review: review.digest };
  const activation = { identity: digest(JSON.stringify(record)), ...record };
  try {
    await writeFile(
      join(directory, "activation.json"),
      JSON.stringify(activation),
      { flag: "wx", mode: 0o400 },
    );
  } catch (error) {
    throw new Error("verifier-activation-exists", { cause: error });
  }
  return activation;
}

export async function readVerifierActivation(
  state: string,
): Promise<VerifierActivation> {
  const directory = await realpath(state);
  const activation = parseActivation(
    await readFile(join(directory, "activation.json"), "utf8"),
  );
  const { identity, ...record } = activation;
  const plan = currentPlan(activation.plan);
  const review = await approvedReview(directory, activation.verifier, plan);
  if (
    identity !== digest(JSON.stringify(record)) ||
    review.digest !== activation.review
  )
    throw new Error("invalid-verifier-activation");
  await assertVerifierInstallation(activation.verifier);
  return activation;
}

function parseActivation(text: string): VerifierActivation {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object")
    throw new Error("invalid-verifier-activation");
  const { identity, verifier, plan, review } = Object.fromEntries(
    Object.entries(value),
  );
  if (
    typeof identity !== "string" ||
    typeof review !== "string" ||
    !isInstallation(verifier) ||
    !isAcceptancePlan(plan)
  )
    throw new Error("invalid-verifier-activation");
  return { identity, verifier, plan, review };
}

function isInstallation(value: unknown): value is VerifierInstallation {
  if (!value || typeof value !== "object") return false;
  const { directory, identity } = Object.fromEntries(Object.entries(value));
  return typeof directory === "string" && typeof identity === "string";
}

function currentPlan(plan: AcceptancePlan): AcceptancePlan {
  const current = assembleAcceptancePlan(plan);
  if (current.identity !== plan.identity)
    throw new Error("invalid-acceptance-plan");
  return current;
}

async function approvedReview(
  directory: string,
  verifier: VerifierInstallation,
  plan: AcceptancePlan,
): Promise<{ digest: string }> {
  const review = await readReview(directory);
  if (
    review.value["decision"] !== "approved" ||
    review.value["verifier"] !== verifier.identity ||
    review.value["directory"] !== verifier.directory ||
    review.value["plan"] !== plan.identity
  )
    throw new Error("unreviewed-verifier-activation");
  return review;
}

async function readReview(directory: string): Promise<{
  value: Readonly<Record<string, unknown>>;
  digest: string;
}> {
  const file = join(directory, "review.json");
  try {
    if (!(await lstat(file)).isFile()) throw new Error("invalid-review-file");
    const bytes = await readFile(file);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid-review-record");
    return {
      value: Object.fromEntries(Object.entries(value)),
      digest: digest(bytes),
    };
  } catch (error) {
    throw new Error("unreviewed-verifier-activation", { cause: error });
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
