import type { Authority } from "../broker/actor/authority.ts";

export async function pinnedSpendLimit(
  context: { readonly authority: Authority },
  runId: string,
): Promise<number | undefined> {
  const { queries } = context.authority;
  const run = await queries.run(runId);
  if (run === undefined || run.admissionCommandId === null) return undefined;
  return (await queries.receipt(run.admissionCommandId))?.command.spendLimitUsd;
}
