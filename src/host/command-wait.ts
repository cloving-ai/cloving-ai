import { setTimeout as delay } from "node:timers/promises";
import { commandWaitValue, isCommandWaitRequest } from "../command-wait.ts";
import type { CommandWaitState } from "../authority/command-waits.ts";
import type {
  CommandWaitRequest,
  CommandWaitProgress,
} from "../step-bridge.ts";

interface WaitName {
  readonly runId: string;
  readonly name: string;
}

interface WaitCall extends WaitName {
  readonly commandId: string;
}

interface WaitReceipt {
  readonly kind: string;
  readonly reason?: string;
}

export interface CommandWaitPorts {
  readonly open: (
    request: WaitCall & { readonly input: string },
  ) => Promise<WaitReceipt>;
  readonly check: (request: WaitCall) => Promise<WaitReceipt>;
  readonly read: (request: WaitName) => Promise<CommandWaitState | undefined>;
}

interface WaitHost {
  readonly commandWait?: CommandWaitPorts;
  readonly runStatus: (runId: string) => Promise<string | undefined>;
  readonly subject: () => Promise<
    { readonly runId: string; readonly commandId: string } | undefined
  >;
  readonly stopped: AbortSignal;
  readonly pollMilliseconds: number;
  readonly retryMilliseconds: number;
}

function progress(wait: CommandWaitState | undefined): CommandWaitProgress {
  if (wait === undefined)
    return { kind: "refused", reason: "unknown-command-wait" };
  if (wait.state === "waiting") return waiting(wait);
  if (wait.state === "timed-out")
    return { kind: "timed-out", reason: "command-wait-timeout" };
  if (wait.state !== "completed")
    return { kind: "failed", reason: wait.reason ?? "command-wait-failed" };
  const value: unknown = JSON.parse(wait.result ?? "null");
  return commandWaitValue(value)
    ? { kind: "ready", value }
    : { kind: "failed", reason: "command-wait-invalid-output" };
}

function refused(receipt: WaitReceipt): CommandWaitProgress | undefined {
  if (["accepted", "duplicate"].includes(receipt.kind)) return undefined;
  return {
    kind: receipt.kind === "failed" ? "failed" : "refused",
    reason: receipt.reason ?? receipt.kind,
  };
}

async function requested(
  context: {
    readonly host: WaitHost;
    readonly call: WaitName;
    readonly retryReasons?: readonly string[];
  },
  send: () => Promise<WaitReceipt>,
): Promise<WaitReceipt> {
  const { host, call, retryReasons = ["service-busy"] } = context;
  for (;;) {
    if (host.stopped.aborted) await new Promise<never>(() => undefined);
    const receipt = await send();
    if (
      receipt.kind !== "rejected" ||
      !retryReasons.includes(receipt.reason ?? "")
    )
      return receipt;
    if (
      receipt.reason === "command-wait-run-not-running" &&
      !["queued", "running", "waiting_gate", "paused"].includes(
        (await host.runStatus(call.runId)) ?? "",
      )
    )
      return receipt;
    await delay(host.retryMilliseconds, undefined, {
      signal: host.stopped,
    }).catch(() => undefined);
  }
}

async function settled(
  context: { readonly host: WaitHost; readonly port: CommandWaitPorts },
  request: WaitName,
): Promise<CommandWaitProgress> {
  const { host, port } = context;
  for (;;) {
    if (host.stopped.aborted) await new Promise<never>(() => undefined);
    const wait = await port.read(request);
    if (wait?.state !== "waiting" || wait.checkOperation === null)
      return progress(wait);
    await delay(host.pollMilliseconds, undefined, {
      signal: host.stopped,
    }).catch(() => undefined);
  }
}

export function commandWaitBridge(host: WaitHost) {
  return {
    openCommandWait: async (
      request: CommandWaitRequest,
    ): Promise<CommandWaitProgress> => {
      if (!isCommandWaitRequest(request))
        return { kind: "refused", reason: "invalid-command-wait-request" };
      const subject = await host.subject();
      const port = host.commandWait;
      if (subject === undefined || port === undefined)
        return { kind: "unavailable", reason: "cloving-host-unavailable" };
      const call = {
        ...subject,
        name: request.name,
        input: JSON.stringify(request.input),
      };
      const receipt = await requested(
        {
          host,
          call,
          retryReasons: ["service-busy", "command-wait-run-not-running"],
        },
        () => port.open(call),
      );
      return (
        refused(receipt) ??
        progress(await port.read({ ...subject, name: request.name }))
      );
    },
    checkCommandWait: async (request: {
      readonly name: string;
    }): Promise<CommandWaitProgress> => {
      const subject = await host.subject();
      const port = host.commandWait;
      if (subject === undefined || port === undefined)
        return { kind: "unavailable", reason: "cloving-host-unavailable" };
      const call = { ...subject, name: request.name };
      const wait = await port.read(call);
      if (wait?.state !== "waiting") return progress(wait);
      if (wait.checkOperation !== null)
        return await settled({ host, port }, call);
      if (
        wait.nextCheckAt !== null &&
        Date.now() < Math.min(wait.nextCheckAt, wait.deadline)
      )
        return progress(wait);
      const receipt = await requested({ host, call }, () => port.check(call));
      return checkReply(receipt, wait) ?? (await settled({ host, port }, call));
    },
  };
}

function checkReply(
  receipt: WaitReceipt,
  wait: CommandWaitState,
): CommandWaitProgress | undefined {
  if (receipt.reason === "command-wait-timeout")
    return { kind: "timed-out", reason: receipt.reason };
  if (receipt.reason === "command-wait-run-not-running")
    return waiting(wait, Date.now() + 1000);
  if (
    [
      "command-wait-check-in-flight",
      "command-wait-check-not-due",
      "command-wait-ended",
    ].includes(receipt.reason ?? "")
  )
    return undefined;
  return refused(receipt);
}

function waiting(
  wait: CommandWaitState,
  nextCheckAt = wait.nextCheckAt ?? wait.deadline,
): CommandWaitProgress {
  return {
    kind: "pending",
    deadline: wait.deadline,
    nextCheckAt,
  };
}
