import {
  commandWaitKey,
  type CommandWaitState,
  type CommandWaitsState,
} from "../authority/command-waits.ts";
import type { Authority, StoreReceipt } from "../broker/actor/authority.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import { effectInputDigest } from "../broker/effect-restore.ts";
import type { Gateway } from "./gateway.ts";
import { operationDigest } from "../broker/operation-digest.ts";

export async function expireCommandWaits(parts: {
  readonly waits: CommandWaitsState;
  readonly gateway: Gateway;
  readonly now: string;
}): Promise<void> {
  for (const wait of Object.values(parts.waits)) {
    if (wait.state !== "waiting" || Date.parse(parts.now) < wait.deadline)
      continue;
    await parts.gateway.execute({
      principal: "controller",
      command: {
        kind: "expire-command-wait",
        commandId: `expire-wait:${operationDigest(commandWaitKey(wait.runId, wait.name))}`,
        runId: wait.runId,
        waitName: wait.name,
      },
    });
  }
}

interface WaitName {
  readonly runId: string;
  readonly name: string;
}

interface WaitCall extends WaitName {
  readonly commandId: string;
}

export interface CommandWaitPort {
  readonly open: (
    wait: WaitCall & { readonly input: string },
  ) => Promise<StoreReceipt>;
  readonly check: (wait: WaitCall) => Promise<StoreReceipt>;
  readonly read: (wait: WaitName) => Promise<CommandWaitState | undefined>;
}

export function commandWaitPort(parts: {
  readonly authority: Authority;
  readonly gateway: Gateway;
}): CommandWaitPort {
  const { authority, gateway } = parts;
  const read = async (wait: WaitName) =>
    (await authority.state()).commandWaits?.[
      commandWaitKey(wait.runId, wait.name)
    ];
  return {
    read,
    open: async (wait) => {
      const declarations =
        (await authority.queries.manifest(wait.runId))?.commandWaits ?? {};
      const permission = Object.hasOwn(declarations, wait.name)
        ? declarations[wait.name]
        : undefined;
      if (permission === undefined)
        return { kind: "rejected", reason: "command-wait-not-declared" };
      return gateway.execute({
        principal: "worker",
        command: {
          kind: "open-command-wait",
          runId: wait.runId,
          commandId: wait.commandId,
          waitName: wait.name,
          target: permission.command,
          maximumWaitSeconds: permission.maximumWaitSeconds,
          pollEverySeconds: permission.pollEverySeconds,
          payload: documentDigest(wait.input),
        },
        documents: [wait.input],
      });
    },
    check: async (call) => {
      const wait = await read(call);
      if (wait === undefined)
        return { kind: "rejected", reason: "unknown-command-wait" };
      return gateway.execute({
        principal: "worker",
        command: {
          kind: "check-command-wait",
          runId: call.runId,
          commandId: call.commandId,
          waitName: call.name,
          inputDigest: effectInputDigest({
            capability: "command",
            method: `run:${wait.command}`,
            target: wait.command,
            payload: wait.inputDigest,
          }),
        },
      });
    },
  };
}
