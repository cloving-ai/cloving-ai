import { ESLint, type Linter } from "eslint";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { check } from "prettier";
import configuration from "../eslint.config.mjs";
import type { SuppressionApproval } from "./suppression-approval.ts";
import type ts from "typescript";

export async function checkFormatting(files: readonly string[]): Promise<void> {
  const invalid: string[] = [];
  for (const file of files) {
    if (!(await check(await readFile(file, "utf8"), { filepath: file })))
      invalid.push(file);
  }
  if (invalid.length > 0)
    throw new Error(`Formatting failed:\n${invalid.join("\n")}`);
}

export async function checkLint(
  directory: string,
  files: readonly string[],
  approvals: readonly SuppressionApproval[] = [],
  program?: ts.Program,
): Promise<void> {
  const linter = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    overrideConfig: [
      ...configuration,
      {
        languageOptions: {
          parserOptions: {
            tsconfigRootDir: directory,
            ...(program
              ? { programs: [program], projectService: false, project: false }
              : {}),
          },
        },
      },
      ...approvals.map((approval): Linter.Config => ({
        files: [relative(directory, approval.file)],
        rules: {
          "@typescript-eslint/ban-ts-comment": [
            "error",
            {
              "ts-ignore": true,
              "ts-nocheck": true,
              "ts-expect-error": false,
              "ts-check": false,
            },
          ],
        },
      })),
    ],
  });
  const results = await linter.lintFiles([...files]);
  const covered = results.map((result) => resolve(result.filePath)).sort();
  if (
    JSON.stringify(covered) !==
    JSON.stringify([...files].map((file) => resolve(file)).sort())
  )
    throw new Error("Lint inventory does not match discovered sources");
  if (
    results.some((result) => result.errorCount > 0 || result.warningCount > 0)
  ) {
    const formatter = await linter.loadFormatter("stylish");
    throw new Error(`Lint failed:\n${await formatter.format(results)}`);
  }
}
