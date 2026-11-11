import { component, element, type Shown } from "./watch-element.ts";
import type { WatchToken } from "./watch-render.ts";
import { RenameAction, type RenameControls } from "./watch-rename-view.ts";
import {
  RunCommandAction,
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

export function TokenMenu(props: {
  readonly token: Pick<WatchToken, "runId" | "title" | "ticket" | "manualName">;
  readonly paused: boolean;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
}): Shown {
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
        children: [
          component(RunCommandAction, {
            runId: token.runId,
            place: "token",
            paused: props.paused,
            controlling,
          }),
          component(RenameAction, {
            run: {
              runId: token.runId,
              title: token.title,
              label: token.ticket,
              ...(token.manualName === true ? { manualName: true } : {}),
            },
            renaming,
          }),
        ],
      }),
    ],
  });
}

export const tokenMenuFunctions = [menuOpened, menuLeft, TokenMenu];
