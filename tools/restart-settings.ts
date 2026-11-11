import { settingVariables } from "../src/project-settings.ts";
import {
  restartedEnvironment,
  type RestartMark,
  type ValidateRestart,
} from "../src/restart-request.ts";
import { projectConfiguration } from "./project-configuration.ts";
import {
  queueInterval,
  queueLimits,
  queueSpendLimit,
  readyTicketCommand,
} from "./self-host-queue.ts";

function changedQueueKey(mark: RestartMark, detail: string): string {
  const variables = mark.variables ?? {};
  if (
    detail.includes("invalid-queue-working-lanes") &&
    Object.hasOwn(variables, "CLOVING_QUEUE_WORKING_LANES")
  )
    return "queue.workingLanes";
  return (
    Object.entries(settingVariables).find(
      ([key, variable]) =>
        (key.startsWith("queue.") ||
          key === "spend.scope" ||
          key === "tickets.readyCommand") &&
        Object.hasOwn(variables, variable),
    )?.[0] ?? "queue"
  );
}

export function restartSettings(start: {
  readonly repository: string;
  readonly fileVariables: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): ValidateRestart {
  const names = new Set(start.fileVariables);
  const environment = Object.fromEntries(
    Object.entries(start.environment).filter(([name]) => !names.has(name)),
  );
  return async (mark) => {
    try {
      const next = restartedEnvironment(environment, {
        settings: mark.settings ?? "environment",
        variables: JSON.stringify(mark.variables ?? {}),
      });
      const configuration = await projectConfiguration(start.repository, next);
      queueLimits(configuration.environment);
      queueInterval(configuration.environment);
      queueSpendLimit(configuration.environment);
      readyTicketCommand(configuration.environment);
      return undefined;
    } catch (error) {
      const detail = String(Reflect.get(Object(error), "message"));
      return {
        key: changedQueueKey(mark, detail),
        detail,
      };
    }
  };
}
