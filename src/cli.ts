#!/usr/bin/env node
import { parseArgs } from "node:util";
import packageMetadata from "#package" with { type: "json" };

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (values.version) {
  process.stdout.write(`${packageMetadata.version}\n`);
} else {
  process.stdout.write(
    "Usage: cloving [--help] [--version]\n\nDevelopment scaffold. Workflow commands are not implemented yet.\n",
  );
}
