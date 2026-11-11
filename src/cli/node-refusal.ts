import { parseArgs } from "node:util";
import { nodeVersionFix } from "../doctor-report.ts";
import { parseInvocation } from "./arguments.ts";
import { startSelection } from "./start-arguments.ts";
import { supportedNode, supportedNodes } from "./toolchain.ts";

export function nodeRefusal(
  argumentsList: readonly string[],
  nodeVersion: string,
): string | undefined {
  if (supportedNode(nodeVersion) || exempt(argumentsList)) return undefined;
  return `unsupported-node: Node ${nodeVersion}. Cloving needs Node ${supportedNodes}. ${nodeVersionFix}\n`;
}

function exempt(argumentsList: readonly string[]): boolean {
  const [command = "", ...options] = argumentsList;
  if (command === "start") return startSelection(options).kind === "usage";
  if (command === "red-green") return options.includes("--help");
  if (parsedByTool(argumentsList)) return parsedHelp(options);
  const { kind } = parseInvocation(argumentsList);
  return ["help", "version", "doctor"].includes(kind) || kind.endsWith("-help");
}

function parsedByTool(argumentsList: readonly string[]): boolean {
  const [command, subcommand = ""] = argumentsList;
  if (command === "templates") return true;
  return command === "workflows" && ["list", "test"].includes(subcommand);
}

function parsedHelp(options: readonly string[]): boolean {
  const { values } = parseArgs({
    args: [...options],
    options: { help: { type: "boolean", short: "h" } },
    strict: false,
    allowPositionals: true,
  });
  return values["help"] === true;
}
