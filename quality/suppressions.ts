import ts from "typescript";

export interface SuppressionFinding {
  readonly file: string;
  readonly line: number;
  readonly marker: string;
}

export function inspectSuppressions(
  source: ts.SourceFile,
): SuppressionFinding[] {
  const ranges = new Map<number, ts.CommentRange>();
  function visit(node: ts.Node): void {
    for (const range of [
      ...(ts.getLeadingCommentRanges(source.text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source.text, node.end) ?? []),
    ])
      ranges.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  }
  visit(source);
  const findings: SuppressionFinding[] = [];
  for (const range of ranges.values()) {
    const markers = source.text
      .slice(range.pos, range.end)
      .matchAll(
        /\b(?:eslint(?:[-\s]|$)|oxlint[-\s]|(?:istanbul|c8|v8)\s+ignore|jscpd\s*:\s*ignore|node:coverage\s)|@ts-(?:ignore|nocheck|expect-error)/gi,
      );
    for (const marker of markers)
      findings.push({
        file: source.fileName,
        line:
          source.getLineAndCharacterOfPosition(range.pos + marker.index).line +
          1,
        marker: marker[0],
      });
  }
  return findings.sort((first, second) => first.line - second.line);
}
