import { piRpcCommand } from "./pi-session.ts";
import { piInputExtensionPath } from "./pi-input-extension.ts";

export interface CommandStart {
  readonly piSession?: { readonly path: string };
  readonly output?: string | undefined;
  readonly worker?: string | undefined;
  readonly command: readonly string[];
  readonly prompt: string;
}

function argumentPrompt(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") < 64 * 1024;
}

export function turnCommand(start: CommandStart): {
  readonly parts: readonly string[];
  readonly standardInput: string | undefined;
  readonly inputExtension?: string;
  readonly rpc?: true;
} {
  if (start.output === "text")
    return {
      parts: start.command.map((part) =>
        part === "{prompt}" ? start.prompt : part,
      ),
      standardInput: start.command.includes("{prompt}")
        ? undefined
        : start.prompt,
    };
  if (start.worker === "pi") return piCommand(start);
  if (
    ["gemini", "cursor-agent"].some((worker) => worker === start.worker) &&
    argumentPrompt(start.prompt)
  )
    return {
      parts: [
        ...start.command,
        ...(start.worker === "gemini" ? ["-p"] : []),
        start.prompt,
      ],
      standardInput: undefined,
    };
  if (start.worker === "opencode")
    return {
      parts: [...start.command, start.prompt],
      standardInput: undefined,
    };
  if (start.worker !== "grok")
    return { parts: start.command, standardInput: start.prompt };
  const command = [...start.command];
  const index = command.findIndex(
    (argument, position) =>
      position > 0 && ["-p", "--single"].includes(argument),
  );
  command.splice(index < 0 ? command.length : index + 1, 0, start.prompt);
  return { parts: command, standardInput: undefined };
}

function piCommand(start: CommandStart) {
  const rpc =
    start.piSession === undefined ? undefined : piRpcCommand(start.command);
  if (rpc !== undefined)
    return { parts: rpc, standardInput: undefined, rpc: true as const };
  if (argumentPrompt(start.prompt) && !start.prompt.startsWith("@"))
    return {
      parts: [...start.command, "--", start.prompt],
      standardInput: undefined,
    };
  if (start.prompt.trim() !== start.prompt)
    return {
      parts: [...start.command, "--extension", piInputExtensionPath],
      standardInput: JSON.stringify(start.prompt),
      inputExtension: piInputExtensionPath,
    };
  return { parts: start.command, standardInput: start.prompt };
}
