import ts from "typescript";
import { serializableType } from "./serializable.ts";
import { referencedSymbol } from "./referenced-symbol.ts";

export interface WorkflowPolicy {
  readonly roles: Readonly<Record<string, string>>;
  readonly stepExports: Readonly<Record<string, readonly string[]>>;
}

function functionBody(node: ts.Node): ts.Block | undefined {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isMethodDeclaration(node)
  )
    return;
  return node.body && ts.isBlock(node.body) ? node.body : undefined;
}

function directive(node: ts.Node): string | undefined {
  const body = functionBody(node);
  if (!body) return;
  for (const statement of body.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    )
      return;
    if (["use workflow", "use step"].includes(statement.expression.text))
      return statement.expression.text;
  }
  return undefined;
}

function topLevelDurable(
  node: ts.Node,
  parent: ts.Node | undefined,
): node is ts.FunctionDeclaration {
  if (!ts.isFunctionDeclaration(node) || !node.name) return false;
  if (!parent || !ts.isSourceFile(parent)) return false;
  const flags = ts.getCombinedModifierFlags(node);
  return (
    !!(flags & ts.ModifierFlags.Async) && !!(flags & ts.ModifierFlags.Export)
  );
}

function durableDefinition(
  node: ts.Node,
  parent: ts.Node | undefined,
  policy: WorkflowPolicy,
  checker: ts.TypeChecker,
): string | undefined {
  const marker = directive(node);
  if (!marker) return;
  if (!topLevelDurable(node, parent)) return "invalid-durable-definition";
  const role = marker === "use workflow" ? "workflow" : "step";
  if (policy.roles[node.getSourceFile().fileName] !== role)
    return "unmapped-workflow";
  if (
    node.parameters.some(
      (parameter) =>
        !serializableType(checker.getTypeAtLocation(parameter), checker),
    )
  )
    return "nonserializable-step-parameter";
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return "missing-durable-signature";
  const result = checker.getAwaitedType(
    checker.getReturnTypeOfSignature(signature),
  );
  if (!result || !serializableType(result, checker))
    return "nonserializable-step-result";
  return undefined;
}

function stepTarget(
  node: ts.Node | undefined,
  policy: WorkflowPolicy,
): { file: string; name: string; admitted: boolean } | undefined {
  if (!node || !ts.isFunctionDeclaration(node) || !node.name) return;
  const file = node.getSourceFile().fileName;
  const name = node.name.text;
  const admitted = policy.stepExports[file]?.includes(name) ?? false;
  if (!admitted && directive(node) !== "use step") return;
  return { file, name, admitted };
}

function stepCall(
  node: ts.CallExpression,
  file: string,
  checker: ts.TypeChecker,
  policy: WorkflowPolicy,
): string | undefined {
  const target = stepTarget(
    checker.getResolvedSignature(node)?.declaration,
    policy,
  );
  if (!target || policy.roles[file] === "test") return;
  if (policy.roles[file] === "step") return "nested-durable-step";
  if (policy.roles[file] !== "workflow" || !target.admitted)
    return "unadmitted-step-call";
  if (
    node.arguments.some(
      (argument) =>
        !serializableType(checker.getTypeAtLocation(argument), checker),
    )
  )
    return "nonserializable-step-argument";
  return undefined;
}

function directCallReference(
  node: ts.Node,
  ancestors: readonly ts.Node[],
): boolean {
  const parent = ancestors.at(-1);
  if (!parent) return false;
  if (ts.isCallExpression(parent)) return parent.expression === node;
  if (!ts.isPropertyAccessExpression(parent) || parent.name !== node)
    return false;
  const grandparent = ancestors.at(-2);
  return (
    !!grandparent &&
    ts.isCallExpression(grandparent) &&
    grandparent.expression === parent
  );
}

function stepReference(
  node: ts.Node,
  ancestors: readonly ts.Node[],
  checker: ts.TypeChecker,
  policy: WorkflowPolicy,
): boolean {
  if (!ts.isIdentifier(node)) return false;
  const parent = ancestors.at(-1);
  if (
    !parent ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isFunctionDeclaration(parent)
  )
    return false;
  const symbol = referencedSymbol(node, parent, checker);
  const declarations = symbol?.declarations ?? [];
  return declarations.some((declaration) => stepTarget(declaration, policy));
}

export function inspectWorkflowBoundaries(
  program: ts.Program,
  policy: WorkflowPolicy,
): readonly string[] {
  const checker = program.getTypeChecker();
  const findings: string[] = [];
  for (const file of program.getRootFileNames()) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-workflow-source: ${file}`);
    const visit = (node: ts.Node, ancestors: readonly ts.Node[]): void => {
      const issues = [
        durableDefinition(node, ancestors.at(-1), policy, checker),
        stepReference(node, ancestors, checker, policy) &&
        !directCallReference(node, ancestors)
          ? "step-value-escape"
          : undefined,
      ];
      if (ts.isCallExpression(node))
        issues.push(stepCall(node, file, checker, policy));
      for (const issue of issues) {
        if (issue)
          findings.push(
            `${issue}: ${file}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`,
          );
      }
      ts.forEachChild(node, (child) => {
        visit(child, [...ancestors, node]);
      });
    };
    visit(source, []);
  }
  return findings;
}
