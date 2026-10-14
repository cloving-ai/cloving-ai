export type WatchElement =
  | {
      readonly tag: string;
      readonly props: Readonly<Record<string, unknown>>;
    }
  | { readonly content: () => Shown };

export type Shown =
  WatchElement | string | number | null | undefined | readonly Shown[];

export function element(
  tag: string,
  props: Readonly<Record<string, unknown>>,
): WatchElement {
  return { tag, props };
}

export function component<Props>(
  type: (props: Props) => Shown,
  props: Props & { readonly key?: string },
): WatchElement {
  return { content: () => type(props) };
}
