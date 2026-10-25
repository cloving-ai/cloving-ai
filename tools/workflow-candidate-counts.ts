import ts from "typescript";
import {
  protectedCall,
  handoffCall,
  commandCall,
  propertyName,
  type CandidateSymbols,
} from "./workflow-candidate-syntax.ts";
import { referenceSymbol } from "./workflow-source-effects.ts";

interface Totals {
  readonly knownCallCount: number;
  readonly knownUnitTotal: number;
}

const zero: Totals = { knownCallCount: 0, knownUnitTotal: 0 };

function add(first: Totals, second: Totals): Totals {
  return {
    knownCallCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      first.knownCallCount + second.knownCallCount,
    ),
    knownUnitTotal: Math.min(
      Number.MAX_SAFE_INTEGER,
      first.knownUnitTotal + second.knownUnitTotal,
    ),
  };
}

function maximum(first: Totals, second: Totals): Totals {
  return {
    knownCallCount: Math.max(first.knownCallCount, second.knownCallCount),
    knownUnitTotal: Math.max(first.knownUnitTotal, second.knownUnitTotal),
  };
}

function multiply(total: Totals, repetitions: number): Totals {
  return {
    knownCallCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      total.knownCallCount * repetitions,
    ),
    knownUnitTotal: Math.min(
      Number.MAX_SAFE_INTEGER,
      total.knownUnitTotal * repetitions,
    ),
  };
}

function units(node: ts.CallExpression, symbols: CandidateSymbols): number {
  if (handoffCall(node, symbols) || commandCall(node, symbols)) return 1;
  const argument = node.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return 0;
  const property = argument.properties.find(
    (entry) => entry.name && propertyName(entry.name) === "units",
  );
  if (!property || !ts.isPropertyAssignment(property)) return 0;
  const value = constantNumber(property.initializer);
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function loopIncrement(
  node: ts.Expression,
  variable: string,
): number | undefined {
  if (
    (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
    ts.isIdentifier(node.operand) &&
    node.operand.text === variable
  )
    return unaryIncrement(node.operator);
  return assignmentIncrement(node, variable);
}

function unaryIncrement(operator: ts.SyntaxKind): number | undefined {
  if (operator === ts.SyntaxKind.PlusPlusToken) return 1;
  if (operator === ts.SyntaxKind.MinusMinusToken) return -1;
  return undefined;
}

function assignmentIncrement(
  node: ts.Expression,
  variable: string,
): number | undefined {
  if (
    !ts.isBinaryExpression(node) ||
    !ts.isIdentifier(node.left) ||
    node.left.text !== variable
  )
    return undefined;
  const amount = constantNumber(node.right);
  if (amount === undefined) return undefined;
  if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return amount;
  if (node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
    return -amount;
  return undefined;
}

function constantNumber(node: ts.Expression): number | undefined {
  if (ts.isParenthesizedExpression(node))
    return constantNumber(node.expression);
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (!ts.isPrefixUnaryExpression(node)) return undefined;
  const value = constantNumber(node.operand);
  if (value === undefined) return undefined;
  if (node.operator === ts.SyntaxKind.PlusToken) return value;
  if (node.operator === ts.SyntaxKind.MinusToken) return -value;
  return undefined;
}

function rangeIterations(input: {
  readonly start: number;
  readonly end: number;
  readonly increment: number;
  readonly operator: ts.SyntaxKind;
}): number | undefined {
  const { start, end, increment, operator } = input;
  if (
    ![
      ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
    ].includes(operator)
  )
    return undefined;
  let iterations = 0;
  let value = start;
  while (iterations < 101 && loopContinues(value, { end, operator })) {
    iterations += 1;
    value += increment;
  }
  return iterations;
}

function loopContinues(
  value: number,
  condition: { readonly end: number; readonly operator: ts.SyntaxKind },
): boolean {
  const { end, operator } = condition;
  if (operator === ts.SyntaxKind.LessThanToken) return value < end;
  if (operator === ts.SyntaxKind.LessThanEqualsToken) return value <= end;
  if (operator === ts.SyntaxKind.GreaterThanToken) return value > end;
  return value >= end;
}

interface LoopContext {
  readonly checker: ts.TypeChecker;
  readonly counter: ts.Symbol | undefined;
}

function referencesCounter(node: ts.Node, context: LoopContext): boolean {
  if (!context.counter) return false;
  if (
    ts.isIdentifier(node) &&
    referenceSymbol(node, { parent: node.parent, checker: context.checker }) ===
      context.counter
  )
    return true;
  return (
    ts.forEachChild(node, (child) =>
      referencesCounter(child, context) ? true : undefined,
    ) ?? false
  );
}

function assignmentTarget(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return node.left;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    unaryIncrement(node.operator) !== undefined
  )
    return node.operand;
  return undefined;
}

function writesCounter(node: ts.Node, context: LoopContext): boolean {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
    return referencesCounter(node.name, context);
  if (ts.isForOfStatement(node) || ts.isForInStatement(node))
    return referencesCounter(node.initializer, context);
  const target = assignmentTarget(node);
  return target !== undefined && referencesCounter(target, context);
}

function uncertainLoopBody(node: ts.Node, context: LoopContext): boolean {
  if (
    ts.isBreakStatement(node) ||
    ts.isContinueStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    writesCounter(node, context)
  )
    return true;
  return (
    ts.forEachChild(node, (child) =>
      uncertainLoopBody(child, context) ? true : undefined,
    ) ?? false
  );
}

function loopIterations(
  node: ts.ForStatement,
  symbols: CandidateSymbols,
): number | undefined {
  const { initializer, condition, incrementor } = node;
  const declaration = loopStart(initializer);
  if (!declaration) return undefined;
  if (!condition || !ts.isBinaryExpression(condition)) return undefined;
  if (
    !ts.isIdentifier(condition.left) ||
    condition.left.text !== declaration.variable.text
  )
    return undefined;
  if (!incrementor) return undefined;
  const end = constantNumber(condition.right);
  if (end === undefined) return undefined;
  const increment = loopIncrement(incrementor, declaration.variable.text);
  if (increment === undefined) return undefined;
  if (
    uncertainLoopBody(node.statement, {
      checker: symbols.checker,
      counter: symbols.checker.getSymbolAtLocation(declaration.variable),
    })
  )
    return undefined;
  return rangeIterations({
    start: declaration.start,
    end,
    increment,
    operator: condition.operatorToken.kind,
  });
}

function loopStart(
  initializer: ts.ForInitializer | undefined,
): { readonly variable: ts.Identifier; readonly start: number } | undefined {
  if (
    !initializer ||
    !ts.isVariableDeclarationList(initializer) ||
    initializer.declarations.length !== 1
  )
    return undefined;
  const declaration = initializer.declarations[0];
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer
  )
    return undefined;
  const start = constantNumber(declaration.initializer);
  if (start === undefined) return undefined;
  return {
    variable: declaration.name,
    start,
  };
}

export function candidateEffectTotals(
  source: ts.SourceFile,
  symbols: CandidateSymbols,
): Totals {
  function count(node: ts.Node | undefined): Totals {
    if (!node) return zero;
    if (ts.isIfStatement(node))
      return add(
        count(node.expression),
        maximum(count(node.thenStatement), count(node.elseStatement)),
      );
    if (ts.isConditionalExpression(node))
      return add(
        count(node.condition),
        maximum(count(node.whenTrue), count(node.whenFalse)),
      );
    if (ts.isForStatement(node)) {
      const iterations = loopIterations(node, symbols) ?? 1;
      const body = count(node.statement);
      const headers = add(
        count(node.initializer),
        add(count(node.condition), count(node.incrementor)),
      );
      return add(headers, multiply(body, iterations));
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isArrayLiteralExpression(node.expression)
    )
      return add(
        count(node.expression),
        multiply(
          add(count(node.initializer), count(node.statement)),
          arrayIterations(node, symbols),
        ),
      );
    if (ts.isSwitchStatement(node))
      return add(count(node.expression), switchTotals(node.caseBlock, count));
    let total = protectedCall(node, symbols)
      ? {
          knownCallCount: 1,
          knownUnitTotal: units(node, symbols),
        }
      : zero;
    ts.forEachChild(node, (child) => {
      total = add(total, count(child));
    });
    return total;
  }
  return count(source);
}

function arrayIterations(
  node: ts.ForOfStatement,
  symbols: CandidateSymbols,
): number {
  if (!ts.isArrayLiteralExpression(node.expression)) return 1;
  return uncertainLoopBody(node.statement, {
    checker: symbols.checker,
    counter: undefined,
  })
    ? 1
    : node.expression.elements.length;
}

function switchTotals(
  block: ts.CaseBlock,
  count: (node: ts.Node) => Totals,
): Totals {
  let suffix = zero;
  let largest = zero;
  let conditions = zero;
  for (const clause of [...block.clauses].reverse()) {
    if (ts.isCaseClause(clause))
      conditions = add(conditions, count(clause.expression));
    const ends = clause.statements.some(
      (node) =>
        ts.isBreakStatement(node) ||
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node),
    );
    const statements = clause.statements.reduce(
      (total, statement) => add(total, count(statement)),
      zero,
    );
    suffix = add(statements, ends ? zero : suffix);
    largest = maximum(largest, suffix);
  }
  return add(conditions, largest);
}
