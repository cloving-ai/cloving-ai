import type { DoctorObservation } from "../doctor-report.ts";
import {
  turnVariablesSetting,
  withheldVariables,
  type TurnVariables,
} from "../turn-environment.ts";

function configuredVariables(
  environment: Readonly<NodeJS.ProcessEnv>,
): TurnVariables | undefined {
  try {
    return turnVariablesSetting(environment["CLOVING_TURN_ENVIRONMENT"]);
  } catch {
    return undefined;
  }
}

export function turnEnvironmentObservation(
  environment: Readonly<NodeJS.ProcessEnv>,
): DoctorObservation {
  const variables = configuredVariables(environment);
  if (variables === undefined)
    return {
      result: "fail",
      detail: "invalid-setting: CLOVING_TURN_ENVIRONMENT",
    };
  if (variables === "inherit")
    return {
      result: "warn",
      detail:
        "turns.environment is inherit: a turn gets all variables of the service environment except the GitHub tokens",
    };
  const withheld = withheldVariables(environment, {
    worker: environment["CLOVING_WORKER"] ?? "claude",
    variables,
  });
  const count = `${String(withheld.length)} ${withheld.length === 1 ? "variable" : "variables"}`;
  return {
    result: "ok",
    detail:
      withheld.length === 0
        ? "A turn gets all variables of the service environment except the GitHub tokens"
        : `A turn does not get ${count} of the service environment: ${withheld.join(", ")}`,
  };
}
