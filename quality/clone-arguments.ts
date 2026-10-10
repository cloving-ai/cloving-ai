import { resolve } from "node:path";

export function cloneArguments(
  targets: readonly string[],
  output: { readonly report: string; readonly maximumBytes: number },
): string[] {
  const { report, maximumBytes } = output;
  return [
    resolve(import.meta.dirname, "../node_modules/jscpd/run-jscpd.js"),
    "--min-tokens",
    "150",
    "--min-lines",
    "0",
    "--mode",
    "weak",
    "--no-gitignore",
    "--format",
    "typescript",
    "--formats-exts",
    "typescript:ts,mts,cts,tsx,js,mjs,cjs,jsx",
    "--max-size",
    String(maximumBytes),
    "--absolute",
    "--exit-code",
    "1",
    "--reporters",
    "json",
    "--output",
    report,
    ...targets,
  ];
}
