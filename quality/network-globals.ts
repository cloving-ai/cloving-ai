import ts from "typescript";
import { referenceSymbol, type EffectFinding } from "./effects.ts";
import { takenMembers } from "./member-uses.ts";
import { visitValueNodes } from "./value-nodes.ts";

const networkNames = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
]);

export function inspectNetworkGlobals(
  program: ts.Program,
  files: readonly string[],
): EffectFinding[] {
  const checker = program.getTypeChecker();
  const globals = networkDeclarations(program);
  const findings: EffectFinding[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-network-source: ${file}`);
    if (source.isDeclarationFile) continue;
    visitValueNodes(source, (node, parent) => {
      const symbols = [
        ...takenMembers(node, checker),
        ...(ts.isIdentifier(node)
          ? [referenceSymbol(node, { parent, checker })]
          : []),
      ];
      const used = symbols
        .flatMap((symbol) => symbol?.declarations ?? [])
        .some((declaration) => globals.has(declaration));
      if (used)
        findings.push({
          rule: "network-global",
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
    });
  }
  return findings;
}

function networkDeclarations(program: ts.Program): Set<ts.Declaration> {
  const library = program
    .getSourceFiles()
    .find((source) => program.isSourceFileDefaultLibrary(source));
  if (!library) throw new Error("missing-default-library");
  return new Set(
    program
      .getTypeChecker()
      .getSymbolsInScope(library, ts.SymbolFlags.Value)
      .filter((symbol) => networkNames.has(symbol.name))
      .flatMap((symbol) => symbol.declarations ?? []),
  );
}
