import { component, element, type Shown } from "./watch-element.ts";
import type { WatchToken } from "./watch-render.ts";
import { RenameAction, type RenameControls } from "./watch-rename-view.ts";
import {
  DropButton,
  DropQuestion,
  PauseButton,
  RunCommandMessage,
  type RunCommandControls,
} from "./watch-run-command-view.ts";

export interface MenuPopover {
  readonly matches: (selector: string) => boolean;
  readonly showPopover: () => void;
  readonly hidePopover: () => void;
}

export interface MenuNode {
  readonly dataset: Record<string, string | undefined>;
  readonly querySelector: (selector: string) => MenuPopover | null;
}

interface MenuEvent {
  readonly currentTarget: MenuNode & {
    readonly contains: (node: unknown) => boolean;
  };
  readonly relatedTarget?: unknown;
}

export function menuOpened(menu: MenuNode): void {
  clearTimeout(Number(menu.dataset["closing"]));
  const pop = menu.querySelector(".token-pop");
  if (pop !== null && !pop.matches(":popover-open")) pop.showPopover();
}

export function menuLeft(menu: MenuNode): void {
  clearTimeout(Number(menu.dataset["closing"]));
  menu.dataset["closing"] = String(
    setTimeout(() => {
      const pop = menu.querySelector(".token-pop");
      if (menu.querySelector(":focus-visible") !== null) return;
      if (pop !== null && pop.matches(":popover-open")) pop.hidePopover();
    }, 200),
  );
}

interface TokenMenuProps {
  readonly token: Pick<WatchToken, "runId" | "title" | "ticket" | "manualName">;
  readonly paused: boolean;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
}

export function TokenDrop(props: {
  readonly runId: string;
  readonly controlling: RunCommandControls;
}): Shown {
  const { runId, controlling } = props;
  const asking = controlling.asking;
  return [
    element("hr", { class: "token-separator" }),
    element("div", {
      class: "token-danger",
      children:
        asking?.runId === runId && asking.place === "token"
          ? component(DropQuestion, { runId, controlling })
          : component(DropButton, {
              runId,
              place: "token",
              paused: false,
              controlling,
            }),
    }),
  ];
}

export function TokenCommands(props: TokenMenuProps): Shown {
  const { token, controlling } = props;
  const runId = token.runId;
  return element("div", {
    class: "run-command",
    "data-run": runId,
    "data-place": "token",
    children: [
      controlling === undefined
        ? null
        : component(PauseButton, {
            runId,
            place: "token",
            paused: props.paused,
            controlling,
          }),
      component(RenameAction, {
        run: {
          runId,
          title: token.title,
          label: token.ticket,
          ...(token.manualName === true ? { manualName: true } : {}),
        },
        renaming: props.renaming,
      }),
      controlling === undefined
        ? null
        : component(TokenDrop, { runId, controlling }),
      component(RunCommandMessage, {
        text: controlling?.messages[runId]?.text,
      }),
    ],
  });
}

export function TokenMenu(props: TokenMenuProps): Shown {
  const { token, controlling, renaming } = props;
  if (controlling === undefined && renaming === undefined) return null;
  const id = `token-menu-${token.runId}`;
  const opened = (event: MenuEvent) => {
    menuOpened(event.currentTarget);
  };
  return element("div", {
    class: "token-menu",
    onPointerEnter: opened,
    onPointerLeave: (event: MenuEvent) => {
      menuLeft(event.currentTarget);
    },
    onFocusIn: opened,
    onFocusOut: (event: MenuEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget))
        menuLeft(event.currentTarget);
    },
    children: [
      element("button", {
        type: "button",
        class: "token-menu-open",
        title: "Run controls",
        "aria-label": "Run controls",
        popovertarget: id,
        popovertargetaction: "show",
        children: element("span", { "aria-hidden": "true", children: "⋯" }),
      }),
      element("div", {
        id,
        class: "token-pop",
        popover: "auto",
        children: component(TokenCommands, props),
      }),
    ],
  });
}

export const tokenMenuFunctions = [
  menuOpened,
  menuLeft,
  TokenDrop,
  TokenCommands,
  TokenMenu,
];
