export function hardDependencies(ticket: string): readonly string[] {
  const lines = ticket.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Dependencies\s*$/.test(line));
  if (start === -1) return [];
  const following = lines.slice(start + 1);
  const end = following.findIndex((line) => /^#{1,2} /.test(line));
  const section = (end === -1 ? following : following.slice(0, end)).join("\n");
  const sentences = section
    .replace(/\b(?:e\.g|i\.e)\./g, "example")
    .matchAll(
      /(?:^|[.!?]\s+|\n)\s*(?:[-*+]\s+|\d+\.\s+)?Needs\b([\s\S]*?)(?=[.!?](?:\s|$)|$)/g,
    );
  return [
    ...new Set(
      [...sentences].flatMap((sentence) =>
        [...String(sentence[1]).matchAll(/#([1-9]\d*)\b/g)].map((match) =>
          String(match[1]),
        ),
      ),
    ),
  ];
}
