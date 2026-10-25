import ts from "typescript";
import { escapedTestApi } from "./test-api-reference.ts";

function callOrigin(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): { file: string; name: string } | undefined {
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (!declaration) return;
  const name = "name" in declaration ? declaration.name : undefined;
  return {
    file: declaration.getSourceFile().fileName,
    name:
      name && ts.isIdentifier(name)
        ? name.text
        : (checker.getSymbolAtLocation(node.expression)?.getName() ?? ""),
  };
}

function selectedTest(
  node: ts.CallExpression,
  selection: {
    readonly checker: ts.TypeChecker;
    readonly name: string;
    readonly runnerFile: string | undefined;
  },
): boolean {
  const { checker, name } = selection;
  if (name === "run") return !explicitRunner(node, selection.runnerFile);
  if (["only", "skip", "todo"].includes(name)) return true;
  return node.arguments.some((argument) => {
    const type = checker.getTypeAtLocation(argument);
    return ["only", "skip", "todo"].some(
      (field) => type.getProperty(field) !== undefined,
    );
  });
}

function explicitRunner(
  node: ts.CallExpression,
  runnerFile: string | undefined,
): boolean {
  if (node.getSourceFile().fileName !== runnerFile) return false;
  const argument = node.arguments[0];
  if (
    !argument ||
    node.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(argument)
  )
    return false;
  const fields = argument.properties
    .map((property) => {
      if (
        (!ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property)) ||
        !ts.isIdentifier(property.name)
      )
        return "";
      return property.name.text;
    })
    .sort();
  const executionFields = fields.filter((field) => field !== "signal");
  if (
    JSON.stringify(executionFields) !==
      JSON.stringify(["concurrency", "files", "isolation"]) ||
    fields.filter((field) => field === "signal").length > 1
  )
    return false;
  const isolation = argument.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "isolation",
  );
  return (
    !!isolation &&
    ts.isStringLiteral(isolation.initializer) &&
    isolation.initializer.text === "process"
  );
}

function assertionAwaited(ancestors: readonly ts.Node[]): boolean {
  for (const parent of [...ancestors].reverse()) {
    if (ts.isParenthesizedExpression(parent)) continue;
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent))
      return true;
    return ts.isArrowFunction(parent) && !ts.isBlock(parent.body);
  }
  return false;
}

function conditional(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCatchClause(node)
  )
    return true;
  return (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  );
}

interface VisitContext {
  readonly ancestors: readonly ts.Node[];
  readonly checker: ts.TypeChecker;
  readonly runnerFile: string | undefined;
}

function callFindings(
  node: ts.CallExpression,
  context: VisitContext,
): readonly string[] {
  const { ancestors, checker } = context;
  const origin = callOrigin(node, checker);
  if (!origin) return [];
  const test = origin.file.endsWith("/@types/node/test.d.ts");
  const assertion = origin.file.endsWith("/@types/node/assert.d.ts");
  if (!test && !assertion) return [];
  const findings: string[] = [];
  if (ancestors.some(conditional)) findings.push("conditional-test-evidence");
  if (
    test &&
    selectedTest(node, {
      checker,
      name: origin.name,
      runnerFile: context.runnerFile,
    })
  )
    findings.push("test-selection");
  if (
    assertion &&
    ["rejects", "doesNotReject"].includes(origin.name) &&
    !assertionAwaited(ancestors)
  )
    findings.push("unawaited-assertion");
  return findings;
}

function conditionalExit(node: ts.Node, context: VisitContext): boolean {
  const { ancestors, checker } = context;
  if (!ts.isReturnStatement(node) || !ancestors.some(conditional)) return false;
  return ancestors.some(
    (ancestor) =>
      ts.isCallExpression(ancestor) &&
      callOrigin(ancestor, checker)?.file.endsWith("/@types/node/test.d.ts"),
  );
}

export function inspectTestIntegrity(
  program: ts.Program,
  options: { readonly runnerFile?: string } = {},
): readonly string[] {
  const checker = program.getTypeChecker();
  const findings: string[] = [];
  for (const file of program.getRootFileNames()) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-test-integrity-source: ${file}`);
    const visit = (node: ts.Node, ancestors: readonly ts.Node[]): void => {
      const location = `${file}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
      const context = { ancestors, checker, runnerFile: options.runnerFile };
      if (escapedTestApi(node, context))
        findings.push(`test-api-escape: ${location}`);
      if (conditionalExit(node, context))
        findings.push(`conditional-test-exit: ${location}`);
      if (ts.isCallExpression(node)) {
        findings.push(
          ...callFindings(node, context).map((rule) => `${rule}: ${location}`),
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
