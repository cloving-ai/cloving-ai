interface SvgAttribute {
  readonly name: string;
  readonly value: string;
}

interface SvgElement {
  readonly name: string;
  readonly attributes: readonly SvgAttribute[];
}

interface SvgTag {
  readonly element: SvgElement;
  readonly empty: boolean;
}

interface Scanner {
  readonly text: string;
  position: number;
}

interface Tree {
  readonly found: SvgElement[];
  readonly open: string[];
}

export const svgElements: readonly string[] = [
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "marker",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
];

const fixedAttributes: Readonly<Record<string, string>> = {
  xmlns: "http://www.w3.org/2000/svg",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
};
const prefixedAttributes = ["xlink:href", "xml:space", "xml:lang"];
const valueFunctions = [
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "translate",
  "scale",
  "rotate",
  "matrix",
  "skewx",
  "skewy",
  "var",
  "calc",
];
const entities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const textChecks: readonly (readonly [string, RegExp])[] = [
  ["svg-markup", /<!--|<!\[CDATA\[|&#|&(?!(?:amp|lt|gt|quot|apos);)|\\/],
  ["svg-doctype", /<!(?!--|\[CDATA\[)/],
  ["svg-script", /javascript\s*:/i],
  ["svg-external-reference", /@import|<\?xml-stylesheet/i],
];
const declaration = /^<\?xml\s[^>]*\?>/;
const closing = /<\/([^\s>]+)\s*>/;
const opening = /<([^\s/>!?][^\s/>]*)/;
const space = /\s+/;
const tagEnd = /(\/?)>/;
const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/;
const blank = /^[\t\n\r ]*$/;
const plainName = /^[A-Za-z][A-Za-z0-9-]*$/;
const reference = /^#[A-Za-z_][\w.-]*$/;
const innerUrl =
  /url[\t\n\f\r ]*\([\t\n\f\r ]*(['"]?)#[A-Za-z_][\w.-]*\1[\t\n\f\r ]*\)/gi;
const words = /([A-Za-z][\w-]*)(\s*)(\()?/g;

function sticky(pattern: RegExp, scanner: Scanner): RegExpExecArray | null {
  const expression = new RegExp(pattern.source, "y");
  expression.lastIndex = scanner.position;
  const match = expression.exec(scanner.text);
  if (match !== null) scanner.position = expression.lastIndex;
  return match;
}

function tagAt(scanner: Scanner, name: string): SvgTag | undefined {
  const attributes: SvgAttribute[] = [];
  for (;;) {
    const spaced = sticky(space, scanner) !== null;
    const end = sticky(tagEnd, scanner);
    if (end !== null)
      return { element: { name, attributes }, empty: end[1] === "/" };
    const match = spaced ? sticky(attributePattern, scanner) : null;
    if (match === null) return undefined;
    const attribute = {
      name: match[1] ?? "",
      value: match[2] ?? match[3] ?? "",
    };
    if (attributes.some((other) => other.name === attribute.name))
      return undefined;
    attributes.push(attribute);
  }
}

function openingAt(scanner: Scanner): SvgTag | undefined {
  const name = sticky(opening, scanner)?.[1];
  return name === undefined ? undefined : tagAt(scanner, name);
}

function nodeAt(scanner: Scanner, tree: Tree): boolean {
  const closed = sticky(closing, scanner)?.[1];
  if (closed !== undefined) return tree.open.pop() === closed;
  if (tree.open.length === 0 && tree.found.length > 0) return false;
  const tag = openingAt(scanner);
  if (tag === undefined) return false;
  tree.found.push(tag.element);
  if (!tag.empty) tree.open.push(tag.element.name);
  return true;
}

function outside(tree: Tree, text: string): boolean {
  return tree.open.length === 0 && !blank.test(text);
}

function elements(text: string): readonly SvgElement[] | undefined {
  const tree: Tree = { found: [], open: [] };
  const scanner = { text, position: declaration.exec(text)?.[0].length ?? 0 };
  for (
    let next = text.indexOf("<", scanner.position);
    next !== -1;
    next = text.indexOf("<", scanner.position)
  ) {
    if (outside(tree, text.slice(scanner.position, next))) return undefined;
    scanner.position = next;
    if (!nodeAt(scanner, tree)) return undefined;
  }
  const rest = text.slice(scanner.position);
  return tree.open.length > 0 || outside(tree, rest) ? undefined : tree.found;
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

function elementCodes(element: SvgElement): readonly string[] {
  const local = localName(element.name);
  if (local === "script") return ["svg-script"];
  if (local === "foreignobject") return ["svg-foreign-object"];
  return svgElements.includes(element.name) ? [] : ["svg-element"];
}

function decoded(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_text, name: string) => entities[name] ?? "",
  );
}

function valueCodes(attribute: SvgAttribute): readonly string[] {
  const value = decoded(attribute.value);
  const name = attribute.name.toLowerCase();
  if (name === "href" || name === "xlink:href")
    return reference.test(value) ? [] : ["svg-external-reference"];
  const rest = value.replace(innerUrl, "");
  if (/url\s*\(/i.test(rest)) return ["svg-external-reference"];
  const calls = Array.from(rest.matchAll(words)).filter(
    (match) => match[3] !== undefined,
  );
  return calls.every((match) =>
    valueFunctions.includes((match[1] ?? "").toLowerCase()),
  )
    ? []
    : ["svg-attribute"];
}

function attributeCodes(attribute: SvgAttribute): readonly string[] {
  const { name, value } = attribute;
  if (localName(name).startsWith("on")) return ["svg-event-attribute"];
  if (Object.hasOwn(fixedAttributes, name))
    return fixedAttributes[name] === value ? [] : ["svg-attribute"];
  if (!plainName.test(name) && !prefixedAttributes.includes(name))
    return ["svg-attribute"];
  return valueCodes(attribute);
}

function structureCodes(found: readonly SvgElement[]): readonly string[] {
  return found.flatMap((element) => [
    ...elementCodes(element),
    ...element.attributes.flatMap(attributeCodes),
  ]);
}

export function svgCodes(text: string): readonly string[] {
  const found = elements(text);
  if (found !== undefined && found[0]?.name !== "svg")
    return ["invalid-asset-type"];
  const codes = [
    ...textChecks.flatMap(([code, pattern]) =>
      pattern.test(text) ? [code] : [],
    ),
    ...(found === undefined ? ["svg-markup"] : structureCodes(found)),
  ];
  return [...new Set(codes)].sort();
}
