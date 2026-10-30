import { sleep } from "workflow";
import {
  isCommandWaitRequest,
  type CommandWaitRequest,
  type CommandWaitOutcome,
} from "../command-wait.ts";
import {
  openCommandWait,
  checkCommandWait,
  commandWaitDate,
} from "./command-wait.ts";

export type {
  CommandWaitRequest,
  CommandWaitOutcome,
} from "../command-wait.ts";

export async function waitForCommand(
  request: CommandWaitRequest,
): Promise<CommandWaitOutcome> {
  if (!isCommandWaitRequest(request))
    return { kind: "refused", reason: "invalid-command-wait-request" };
  let result = await openCommandWait({
    name: request.name,
    input: request.input,
  });
  while (result.kind === "pending") {
    result = await checkCommandWait({ name: request.name });
    if (result.kind === "pending")
      await sleep(
        commandWaitDate(Math.min(result.deadline, result.nextCheckAt)),
      );
  }
  return result;
}
