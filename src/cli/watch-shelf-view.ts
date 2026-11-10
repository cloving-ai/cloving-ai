import { priceText } from "./usage-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { watchHash } from "./watch-navigation.ts";
import { elapsed, type WatchModel, type WatchTile } from "./watch-render.ts";
import { countText, type WatchWords } from "./watch-theme-view.ts";

export function Tile(props: {
  readonly tile: WatchTile;
  readonly line: number;
}): Shown {
  const { tile, line } = props;
  return element("li", {
    class: line < 0 ? "tile" : `tile line-color-${String((line % 4) + 1)}`,
    children: [
      element("div", {
        class: "tile-ids",
        children: [
          tile.ticket === null
            ? null
            : element("span", { class: "tile-ticket", children: tile.ticket }),
          tile.pullRequestNumber === null
            ? null
            : element("span", {
                class: "tile-pull",
                children: `PR #${String(tile.pullRequestNumber)}`,
              }),
        ],
      }),
      element("a", {
        class: "tile-title",
        href: watchHash({ workflowId: null, runId: tile.runId }),
        title: tile.title,
        children: tile.title,
      }),
      element("div", {
        class: "tile-facts",
        children: [
          element("span", { children: tile.workflowId }),
          element("span", {
            children: elapsed(tile.startedAt, tile.completedAt),
          }),
          element("span", {
            children: priceText(tile.claudeCostUsd, tile.estimatedCostUsd),
          }),
        ],
      }),
      tile.demo === null ? null : component(Demo, { tile, demo: tile.demo }),
    ],
  });
}

export function Demo(props: {
  readonly tile: WatchTile;
  readonly demo: string;
}): Shown {
  const { tile, demo } = props;
  const player = `demo-${tile.runId}`;
  return [
    element("button", {
      class: "tile-demo",
      type: "button",
      popovertarget: player,
      "aria-label": `Play demo of ${tile.ticket ?? tile.title}`,
      children: [
        element("video", {
          class: "demo-frame",
          src: `${demo}#t=0.1`,
          preload: "metadata",
          "aria-hidden": "true",
        }),
        "Play demo",
      ],
    }),
    element("div", {
      id: player,
      class: "demo-player",
      popover: "auto",
      onToggle: (event: {
        readonly newState: string;
        readonly currentTarget: {
          readonly firstChild: {
            readonly play: () => Promise<void>;
            readonly pause: () => void;
          };
        };
      }) => {
        const video = event.currentTarget.firstChild;
        if (event.newState !== "open") {
          video.pause();
          return;
        }
        video.play().catch(() => undefined);
      },
      children: element("video", {
        src: demo,
        controls: true,
        preload: "none",
      }),
    }),
  ];
}

export function Shelf(props: {
  readonly model: WatchModel;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { model, words } = props;
  const unit =
    words?.["completed.unit"] === undefined ? "run.unit" : "completed.unit";
  const tiles = model.completed ?? [];
  const lines = model.workflows.map((workflow) => workflow.workflowId);
  return element("section", {
    class: "shelf",
    "aria-labelledby": "shelf-title",
    children: [
      element("div", {
        class: "shelf-head",
        children: [
          element("h2", { id: "shelf-title", children: "Completed today" }),
          element("span", {
            class: "shelf-count",
            children: countText(words, {
              key: unit,
              count: tiles.length,
              noun: "run",
            }),
          }),
        ],
      }),
      tiles.length === 0
        ? element("p", { class: "meta", children: "No run completed today." })
        : element("ol", {
            class: "tiles",
            children: tiles.map((tile) =>
              component(Tile, {
                key: tile.runId,
                tile,
                line: lines.indexOf(tile.workflowId),
              }),
            ),
          }),
    ],
  });
}
