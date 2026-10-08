import { join, resolve } from "node:path";
import ts from "typescript";
import { withFiles } from "./files-fixture.ts";

export async function withProgram<Result>(
  sources: Readonly<Record<string, string>>,
  inspect: (program: ts.Program) => Result,
): Promise<Result> {
  return await withFiles(
    { "package.json": '{"type":"module"}', ...sources },
    (directory) => {
      const program = ts.createProgram(
        Object.keys(sources).map((name) => join(directory, name)),
        {
          strict: true,
          noEmit: true,
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          verbatimModuleSyntax: true,
          typeRoots: [resolve("node_modules/@types")],
          types: ["node"],
          skipLibCheck: true,
        },
      );
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length > 0)
        throw new Error(
          ts.formatDiagnostics(diagnostics, {
            getCurrentDirectory: () => directory,
            getCanonicalFileName: (name) => name,
            getNewLine: () => "\n",
          }),
        );
      return inspect(program);
    },
  );
}
