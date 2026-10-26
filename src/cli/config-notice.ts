import net from "node:net";
import { join } from "node:path";
import { socketAddress } from "../broker/socket-address.ts";
import type { SettingEntry } from "../configuration-display.ts";
import { runtimeDirectory } from "./runtime-directory.ts";

function serviceDirectory(repository: string): string | undefined {
  try {
    return runtimeDirectory(process.env, repository);
  } catch {
    return undefined;
  }
}

function running(repository: string): Promise<boolean> {
  const directory = serviceDirectory(repository);
  if (directory === undefined) return Promise.resolve(false);
  const address = socketAddress(join(directory, "control.sock"));
  if (address.kind !== "address") return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect(address.path);
    const finish = (result: { readonly connected: boolean }): void => {
      socket.destroy();
      resolve(result.connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => {
      finish({ connected: true });
    });
    const unavailable = (): void => {
      finish({ connected: false });
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

export async function configNotice(
  repository: string,
  input: {
    readonly scope: "project" | "private";
    readonly entry: SettingEntry | undefined;
  },
): Promise<string | null> {
  if (!(await running(repository))) return null;
  const source = input.entry?.source;
  const hidden =
    source === "environment" ||
    (input.scope === "project" && source === "private");
  return hidden
    ? `The ${source} source hides this file value. A restart keeps the value of that source.`
    : "Restart the service to use the new value.";
}
