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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const controls: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
};

function bytesOf(part: RegExpExecArray): readonly number[] {
  const [found, octal, escape] = part;
  if (octal !== undefined) return [Number.parseInt(octal, 8)];
  const text = escape === undefined ? found : (controls[escape] ?? escape);
  return [...encoder.encode(text)];
}

function gitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  const parts = path.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|[^\\]+/gu);
  return decoder.decode(
    Uint8Array.from([...parts].flatMap((part) => bytesOf(part))),
  );
}

function headerPath(line: string): string {
  const pair = line.slice("diff --git ".length);
  return gitPath(pair.slice(0, (pair.length - 1) / 2)).slice(2);
}

export function changedWords(diff: string): ChangedWords {
  const changed = new Map<string, Set<string>>();
  let words = new Set<string>();
  let hunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      words = new Set<string>();
      hunk = false;
      changed.set(headerPath(line), words);
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

function insideRepository(folder: string, token: string): string | undefined {
  const parts: string[] = [];
  for (const part of `${folder}/${token}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      parts.push(part);
      continue;
    }
    if (parts.length === 0) return undefined;
    parts.pop();
  }
  return parts.join("/");
}

export function mentionedCode(
  doc: { readonly path: string; readonly text: string },
  changed: ChangedWords,
): readonly string[] {
  const folder = doc.path.split("/").slice(0, -1).join("/");
  const paths = tokens(doc.text).flatMap((token) =>
    [token, insideRepository(folder, token)].filter(
      (path): path is string => path !== undefined && changed.has(path),
    ),
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
