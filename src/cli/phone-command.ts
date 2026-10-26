import { record, type Fields, type Reply } from "../protocol.ts";
import type { PhoneInvocation } from "./phone-arguments.ts";
import { phoneRequest } from "./phone-client.ts";
import { oneLine } from "./render.ts";

type Invocation = Extract<PhoneInvocation, { readonly kind: "phone" }>;

export interface PhoneContext {
  readonly runtimeDirectory: string | undefined;
  readonly terminal: {
    readonly out: (text: string) => void;
    readonly error: (text: string) => void;
  };
}

interface Exchange {
  readonly invocation: Invocation;
  readonly context: PhoneContext;
  readonly runtimeDirectory: string;
}

function counted(count: number): string {
  return count === 1 ? "1 phone" : `${String(count)} phones`;
}

function listed(state: Fields): readonly Fields[] {
  const devices = state["devices"];
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((device: unknown) => {
    const fields = record(device);
    return fields === undefined ? [] : [fields];
  });
}

function stateText(state: Fields): string {
  const registration =
    state["registered"] === true
      ? `Registered as ${oneLine(state["daemonId"])} with ${oneLine(state["origin"])}.`
      : "Not registered.";
  return `${registration} ${counted(listed(state).length)}.\n`;
}

function deviceLine(device: Fields): string {
  const removedAt = device["removedAt"];
  const condition =
    typeof removedAt === "string" ? `removed ${removedAt}` : device["state"];
  return `${oneLine(device["deviceId"])}  ${oneLine(device["name"])} (${oneLine(device["platform"])})  ${oneLine(condition)}  paired ${oneLine(device["pairedAt"])}\n`;
}

function listText(state: Fields): string {
  const devices = listed(state);
  return devices.length === 0
    ? "No phones.\n"
    : devices.map(deviceLine).join("");
}

function failed(context: PhoneContext, reply: Reply): number {
  if (reply.kind === "result") return 0;
  context.terminal.error(
    `${oneLine(reply.error.code)}: ${oneLine(reply.error.detail)}\n`,
  );
  return 1;
}

function warned(context: PhoneContext, result: Fields): void {
  const warning = result["warning"];
  if (typeof warning === "string")
    context.terminal.error(`warning: ${oneLine(warning)}\n`);
}

const operations: Readonly<Record<Invocation["command"], string>> = {
  status: "phone-state",
  list: "phone-state",
  remove: "phone-remove",
  reset: "phone-reset",
};

function jsonShown(command: Invocation["command"], result: Fields): Fields {
  if (command === "list") return { devices: listed(result) };
  if (command === "status") return { relay: "on", ...result };
  return result;
}

function shown(exchange: Exchange, result: Fields): string {
  const { invocation } = exchange;
  if (invocation.json)
    return `${JSON.stringify(jsonShown(invocation.command, result))}\n`;
  if (invocation.command === "status") return stateText(result);
  if (invocation.command === "list") return listText(result);
  if (invocation.command === "remove")
    return `Removed the phone ${String(invocation.deviceId)}.\n`;
  return `Removed the registration and ${counted(Number(result["removed"]))}.\n`;
}

function relayOff(exchange: Exchange): number {
  const { invocation, context } = exchange;
  if (invocation.command !== "status") {
    context.terminal.error(
      "phone-relay-off: The phone relay is off or not started.\n",
    );
    return 1;
  }
  context.terminal.out(
    invocation.json
      ? `${JSON.stringify({ relay: "off" })}\n`
      : "The phone relay is off or not started.\n",
  );
  return 0;
}

async function exchanged(exchange: Exchange): Promise<number> {
  const { invocation, context, runtimeDirectory } = exchange;
  const reply = await phoneRequest(runtimeDirectory, {
    operation: operations[invocation.command],
    parameters:
      invocation.deviceId === null ? {} : { deviceId: invocation.deviceId },
  });
  if (reply === undefined) return relayOff(exchange);
  if (reply.kind === "error") return failed(context, reply);
  warned(context, reply.result);
  context.terminal.out(shown(exchange, reply.result));
  return 0;
}

export async function phoneCommand(
  invocation: Invocation,
  context: PhoneContext,
): Promise<number> {
  const { runtimeDirectory } = context;
  if (runtimeDirectory === undefined) {
    context.terminal.error(
      "runtime-directory-unknown: Set CLOVING_RUNTIME_DIR to the runtime directory of the service.\n",
    );
    return 1;
  }
  return exchanged({ invocation, context, runtimeDirectory });
}
