export interface PageEvent {
  readonly type: string;
}

type Listener = (this: PageNode, event: PageEvent) => unknown;

const voidNames = ["br"];

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class PageNode {
  readonly childNodes: PageNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener>();
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly localName: string | undefined;
  readonly nodeType: number;
  readonly ownerDocument = {
    createElementNS: (_namespace: string, name: string): PageNode =>
      new PageNode(name),
    createTextNode: (data: unknown): PageNode => {
      const text = new PageNode(undefined);
      text.data = data;
      return text;
    },
  };
  parentNode: PageNode | null = null;
  #data = "";

  constructor(localName: string | undefined) {
    this.localName = localName;
    this.nodeType = localName === undefined ? 3 : 1;
  }

  get data(): string {
    return this.#data;
  }

  set data(value: unknown) {
    this.#data = String(value);
  }

  get firstChild(): PageNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): PageNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  remove(): void {
    const siblings = this.parentNode?.childNodes ?? [];
    if (siblings.includes(this)) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  insertBefore(node: PageNode, reference: PageNode | null): PageNode {
    node.remove();
    const position =
      reference === null
        ? this.childNodes.length
        : this.childNodes.indexOf(reference);
    this.childNodes.splice(position, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node: PageNode): PageNode {
    return this.insertBefore(node, null);
  }

  removeChild(child: PageNode): PageNode {
    child.remove();
    return child;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  dispatch(type: string): unknown {
    return this.listeners.get(type)?.call(this, { type });
  }

  all(name: string): PageNode[] {
    return this.childNodes.flatMap((child) => [
      ...(child.localName === name ? [child] : []),
      ...child.all(name),
    ]);
  }

  get text(): string {
    return this.localName === undefined
      ? this.data
      : this.childNodes.map((child) => child.text).join("");
  }

  get inner(): string {
    return this.childNodes.map((child) => child.html).join("");
  }

  get html(): string {
    if (this.localName === undefined) return escaped(this.data);
    const attributes = [...this.attributes].map(([name, value]) =>
      value === "" || (name === "open" && value === "true")
        ? ` ${name}`
        : ` ${name}="${escaped(value)}"`,
    );
    const open = `<${this.localName}${attributes.join("")}>`;
    if (voidNames.includes(this.localName)) return open;
    return `${open}${this.inner}</${this.localName}>`;
  }
}

type Props = Readonly<Record<string, unknown>>;

function attribute(entry: readonly [string, unknown]): string {
  const [name, value] = entry;
  if (["children", "key"].includes(name)) return "";
  if (value === true) return ` ${name}`;
  return typeof value === "string" ? ` ${name}="${escaped(value)}"` : "";
}

function tagged(tag: string, props: Props): string {
  const open = `<${tag}${Object.entries(props).map(attribute).join("")}>`;
  if (voidNames.includes(tag)) return open;
  return `${open}${rendered(props["children"])}</${tag}>`;
}

function listed(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value.map((item: unknown) => item) : undefined;
}

function described(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function isThunk(value: unknown): value is () => unknown {
  return typeof value === "function";
}

export function rendered(shown: unknown): string {
  const items = listed(shown);
  if (items !== undefined) return items.map(rendered).join("");
  if (typeof shown === "string") return escaped(shown);
  if (typeof shown === "number") return String(shown);
  const { tag, props, content } = described(shown);
  if (isThunk(content)) return rendered(content());
  return typeof tag === "string" ? tagged(tag, described(props)) : "";
}

export function found(shown: unknown, name: string): Props[] {
  const items = listed(shown);
  if (items !== undefined) return items.flatMap((item) => found(item, name));
  const { tag, props, content } = described(shown);
  if (isThunk(content)) return found(content(), name);
  if (typeof tag !== "string") return [];
  const own = described(props);
  return [...(tag === name ? [own] : []), ...found(own["children"], name)];
}
