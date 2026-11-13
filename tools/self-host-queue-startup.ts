import {
  queueConfigurations,
  queueLimits,
  queueMilliseconds,
  queuePlan,
  queueSpendLimit,
  readyTicketCommand,
} from "./self-host-queue.ts";

export function queueStartup(
  environment: Parameters<typeof queuePlan>[0],
  given: Parameters<typeof queuePlan>[1],
) {
  const configurations = queueConfigurations(environment, given);
  const active = given.declarations.find(
    (declaration) =>
      configurations[declaration.workflowId]?.intervalMilliseconds !==
      undefined,
  );
  const plan = queuePlan(environment, {
    ...given,
    declarations: active === undefined ? given.declarations : [active],
  });
  const limits = queueLimits(environment, plan);
  return {
    queueMilliseconds: queueMilliseconds(plan),
    ...(plan.kind === "off" ? { queueState: "off" as const } : {}),
    ...(plan.kind === "on"
      ? { queueIntervalSource: plan.values.everySeconds.source }
      : {}),
    queueLimits: limits,
    queueLanes: limits.lanes,
    queueConfigurations: configurations,
    queueDailySpendLimitUsd: queueSpendLimit(environment, plan),
    readyCommand: readyTicketCommand(environment, plan),
  };
}
