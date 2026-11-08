export type ChangedWords = ReadonlyMap<string, ReadonlySet<string>>;

const word = /[\w@-]+(?:\.[\w@-]+)*/g;
const docPath = /^(?!.*\.\.)(?!\/)[\w./-]+\.md$/;

function wordsOf(text: string): readonly string[] {
  return (text.match(word) ?? []).flatMap((found) => {
    const parts = found.split(".");
    return parts.flatMap((_, start) =>
      parts
        .slice(start)
        .map((__, length) => parts.slice(start, start + length + 1).join(".")),
    );
  });
}

export function changedWords(diff: string): ChangedWords {
  const changed = new Map<string, Set<string>>();
  let words = new Set<string>();
  let hunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      words = new Set<string>();
      hunk = false;
      if (line.startsWith("diff --git a/"))
        changed.set(line.slice(line.lastIndexOf(" b/") + 3), words);
    }
    if (line.startsWith("@@")) hunk = true;
    if (hunk && /^[+-]/.test(line))
      for (const found of wordsOf(line.slice(1))) words.add(found);
  }
  return changed;
}

function tokens(text: string): readonly string[] {
  return (text.match(/[\w@.+/-]+/g) ?? []).map((token) =>
    token.replace(/^\.\//, "").replace(/\.+$/, ""),
  );
}

function codeNames(text: string): readonly string[] {
  return (text.match(/`[^`\n]+`/g) ?? [])
    .map((span) => span.slice(1, -1))
    .filter(
      (name) =>
        name.length >= 3 &&
        name.length <= 100 &&
        /^[\w@-]+(?:\.[\w@-]+)*$/.test(name) &&
        /[._@-]|[a-z][A-Z]/.test(name),
    );
}

export function mentionedCode(
  doc: { readonly path: string; readonly text: string },
  changed: ChangedWords,
): readonly string[] {
  const folder = doc.path.split("/").slice(0, -1).join("/");
  const paths = tokens(doc.text).flatMap((token) =>
    [token, `${folder}/${token}`].filter((path) => changed.has(path)),
  );
  const names = codeNames(doc.text);
  const named = [...changed]
    .filter(([, words]) => names.some((name) => words.has(name)))
    .map(([path]) => path);
  return [...new Set(paths.concat(named))].sort();
}

function patternOf(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`);
}

export function docPatterns(
  files: readonly string[],
  patterns: readonly string[],
): readonly string[] {
  const expressions = patterns.map((pattern) => patternOf(pattern));
  return files.filter(
    (file) =>
      docPath.test(file) &&
      expressions.some((expression) => expression.test(file)),
  );
}

export function namedDocs(titles: readonly string[]): ReadonlySet<string> {
  return new Set(titles.flatMap((title) => tokens(title)));
}
