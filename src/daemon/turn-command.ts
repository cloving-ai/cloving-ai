export interface CommandStart {
  readonly output?: string | undefined;
  readonly worker?: string | undefined;
  readonly command: readonly string[];
  readonly prompt: string;
}

export function turnCommand(start: CommandStart): {
  readonly parts: readonly string[];
  readonly standardInput: string | undefined;
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
  if (start.worker === "opencode")
    return {
      parts: [...start.command, start.prompt],
      standardInput: undefined,
    };
  if (
    start.worker === "cursor-agent" &&
    Buffer.byteLength(start.prompt, "utf8") < 64 * 1024
  )
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
