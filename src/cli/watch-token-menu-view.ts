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

export interface MenuElement {
  readonly matches: (selector: string) => boolean;
  readonly showPopover: () => void;
  readonly hidePopover: () => void;
  readonly focus: () => void;
}

export interface MenuNode {
  readonly dataset: Record<string, string | undefined>;
  readonly querySelector: (selector: string) => MenuElement | null;
}

export type MenuTarget = object;

interface MenuEvent {
  readonly currentTarget: MenuNode & {
    readonly contains: (node: MenuTarget | null) => boolean;
  };
  readonly relatedTarget?: MenuTarget | null;
  readonly key?: string;
}

export function menuOpened(menu: MenuNode): void {
  clearTimeout(Number(menu.dataset["closing"]));
  const pop = menu.querySelector(".token-pop");
  if (pop !== null && !pop.matches(":popover-open")) pop.showPopover();
}

export function menuClosed(menu: MenuNode): void {
  clearTimeout(Number(menu.dataset["closing"]));
  const pop = menu.querySelector(".token-pop");
  if (pop !== null && pop.matches(":popover-open")) pop.hidePopover();
  menu.querySelector(".token-menu-open")?.focus();
}

export function menuEntered(menu: MenuNode): void {
  menu.dataset["pointer"] = "inside";
  menuOpened(menu);
}

export function menuExited(menu: MenuNode): void {
  delete menu.dataset["pointer"];
  menuLeft(menu);
}

export function menuLeft(menu: MenuNode): void {
  clearTimeout(Number(menu.dataset["closing"]));
  menu.dataset["closing"] = String(
    setTimeout(() => {
      const pop = menu.querySelector(".token-pop");
      if (menu.dataset["pointer"] === "inside") return;
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

export function menuPicked(pop: MenuElement): void {
  if (pop.matches(":popover-open")) pop.hidePopover();
}

export function MenuShell(props: {
  readonly id: string;
  readonly label: string;
  readonly picked?: ((pop: MenuElement) => void) | undefined;
  readonly children: Shown;
}): Shown {
  const { id, label, picked } = props;
  const opened = (event: MenuEvent) => {
    menuOpened(event.currentTarget);
  };
  return element("div", {
    class: "token-menu",
    onPointerEnter: (event: MenuEvent) => {
      menuEntered(event.currentTarget);
    },
    onPointerLeave: (event: MenuEvent) => {
      menuExited(event.currentTarget);
    },
    onFocusIn: opened,
    onKeyDown: (event: MenuEvent) => {
      if (event.key === "Escape") menuClosed(event.currentTarget);
    },
    onFocusOut: (event: MenuEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget ?? null))
        menuLeft(event.currentTarget);
    },
    children: [
      element("button", {
        type: "button",
        class: "token-menu-open",
        title: label,
        "aria-label": label,
        popovertarget: id,
        popovertargetaction: "show",
        children: element("span", { "aria-hidden": "true", children: "⋯" }),
      }),
      element("div", {
        id,
        class: "token-pop",
        popover: "auto",
        ...(picked === undefined
          ? {}
          : {
              onClick: (event: { readonly currentTarget: MenuElement }) => {
                picked(event.currentTarget);
              },
            }),
        children: props.children,
      }),
    ],
  });
}

export function TokenMenu(props: TokenMenuProps): Shown {
  const { token, controlling, renaming } = props;
  if (controlling === undefined && renaming === undefined) return null;
  return component(MenuShell, {
    id: `token-menu-${token.runId}`,
    label: "Run controls",
    children: component(TokenCommands, props),
  });
}

export const tokenMenuFunctions = [
  menuOpened,
  menuClosed,
  menuEntered,
  menuExited,
  menuLeft,
  TokenDrop,
  TokenCommands,
  menuPicked,
  MenuShell,
  TokenMenu,
];
