import type { Fields } from "../protocol.ts";
import type { PhoneInvocation } from "./phone-arguments.ts";
import { phoneRequest } from "./phone-client.ts";

export interface PhoneContext {
  readonly runtimeDirectory: string | undefined;
  readonly terminal: {
    readonly out: (text: string) => void;
    readonly error: (text: string) => void;
  };
}

function counted(count: number): string {
  return count === 1 ? "1 phone" : `${String(count)} phones`;
}

function stateText(state: Fields): string {
  const devices = Array.isArray(state["devices"]) ? state["devices"] : [];
  const registration =
    state["registered"] === true
      ? `Registered as ${String(state["daemonId"])} with ${String(state["origin"])}.`
      : "Not registered.";
  return `${registration} ${counted(devices.length)}.\n`;
}

export async function phoneCommand(
  invocation: Extract<PhoneInvocation, { readonly kind: "phone" }>,
  context: PhoneContext,
): Promise<number> {
  const { runtimeDirectory, terminal } = context;
  if (runtimeDirectory === undefined) {
    terminal.error(
      "runtime-directory-unknown: Set CLOVING_RUNTIME_DIR to the runtime directory of the service.\n",
    );
    return 1;
  }
  const reply = await phoneRequest(runtimeDirectory, {
    operation: "phone-state",
    parameters: {},
  });
  if (reply === undefined) {
    terminal.out(
      invocation.json
        ? `${JSON.stringify({ relay: "off" })}\n`
        : "The phone relay is off or not started.\n",
    );
    return 0;
  }
  if (reply.kind === "error") {
    terminal.error(`${reply.error.code}: ${reply.error.detail}\n`);
    return 1;
  }
  terminal.out(
    invocation.json
      ? `${JSON.stringify({ relay: "on", ...reply.result })}\n`
      : stateText(reply.result),
  );
  return 0;
}
