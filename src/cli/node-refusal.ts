import { doctorFixes } from "../doctor-report.ts";
import { parseInvocation } from "./arguments.ts";
import { supportedNode, supportedNodes } from "./toolchain.ts";

const toolHelpOptions = new Map<string, readonly string[]>([
  ["start", ["--help"]],
  ["workflows", ["--help", "-h"]],
  ["templates", ["--help", "-h"]],
  ["red-green", ["--help"]],
]);

export function nodeRefusal(
  argumentsList: readonly string[],
  nodeVersion: string,
): string | undefined {
  if (supportedNode(nodeVersion) || exempt(argumentsList)) return undefined;
  return `unsupported-node: Node ${nodeVersion}. Cloving needs Node ${supportedNodes}. ${doctorFixes["node-version"]}\n`;
}

function exempt(argumentsList: readonly string[]): boolean {
  const [command = "", ...options] = argumentsList;
  const helpOptions = toolHelpOptions.get(command) ?? [];
  if (options.some((option) => helpOptions.includes(option))) return true;
  const { kind } = parseInvocation(argumentsList);
  return ["help", "version", "doctor"].includes(kind) || kind.endsWith("-help");
}
