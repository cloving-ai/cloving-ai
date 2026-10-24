import { join } from "node:path";
import ts from "typescript";
import { dependencyGraph } from "../../quality/dependency-graph.ts";
import { withFiles } from "./files-fixture.ts";
import { fixtureProgram } from "./compiler-host-fixture.ts";

export async function graphFixture(sources: Readonly<Record<string, string>>) {
  return await withFiles(
    { "package.json": '{"type":"module"}', ...sources },
    (directory) => {
      const files = Object.keys(sources).filter(
        (name) =>
          /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name) &&
          !name.startsWith("node_modules/"),
      );
      const options: ts.CompilerOptions = {
        strict: true,
        allowJs: true,
        checkJs: true,
        verbatimModuleSyntax: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        paths: { "#local": [join(directory, "data.ts")] },
      };
      const program = fixtureProgram(
        files.map((name) => join(directory, name)),
        options,
      );
      if (program.getSyntacticDiagnostics().length > 0)
        throw new Error("Invalid graph fixture syntax");
      return dependencyGraph(program);
    },
  );
}
