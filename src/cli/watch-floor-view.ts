import type { Fields } from "../protocol.ts";
import {
  QueueCard,
  type LineQueue,
  type QueueControls,
} from "./watch-queue-card-view.ts";
import { component, element, type Shown } from "./watch-element.ts";
import type { WatchLoop } from "./watch-loops.ts";
import type { LoopControls } from "./watch-loops-view.ts";
import { LineNext, type LineLoop } from "./watch-line-next-view.ts";
import { watchHash } from "./watch-navigation.ts";
import { steerable } from "./watch-steer-view.ts";
import type { RenameControls } from "./watch-rename-view.ts";
import { TokenMenu } from "./watch-token-menu-view.ts";
import {
  RunCommandReplies,
  type RunCommandControls,
} from "./watch-run-command-view.ts";
import {
  countText,
  labelWord,
  wordText,
  type WatchWords,
} from "./watch-theme-view.ts";
import {
  type WatchLamp,
  type WatchModel,
  type WatchReady,
  type WatchRepository,
  type WatchStation,
  type WatchToken,
  type WatchWorkflow,
} from "./watch-render.ts";

export function lampLabel(lamp: WatchLamp | null): string {
  const labels: Readonly<Record<WatchLamp, string>> = {
    stopped: "Stopped",
    "needs-you": "Needs you",
    waiting: "Waiting",
    running: "Running",
  };
  return lamp === null ? "No run" : labels[lamp];
}

export function stepAge(startedAt: string | null, now: string): string {
  const minutes = Math.floor(
    (Date.parse(now) - Date.parse(startedAt ?? "")) / 60000,
  );
  if (Number.isNaN(minutes)) return "";
  const shown = Math.max(0, minutes);
  if (shown < 60) return `${String(shown)}m`;
  return `${String(Math.floor(shown / 60))}h ${String(shown % 60)}m`;
}

export function Token(props: {
  readonly token: WatchToken;
  readonly now: string;
}): Shown {
  const { token, now } = props;
  return element("a", {
    class: `token ${token.lamp}`,
    href: watchHash({ workflowId: null, runId: token.runId }),
    title: token.title ?? token.runId,
    children: [
      element("span", { class: "token-worker", children: token.worker }),
      token.ticket === null
        ? null
        : element("span", { class: "token-ticket", children: token.ticket }),
      token.pullRequestNumber === null
        ? null
        : element("span", {
            class: "token-pull",
            children: `PR #${String(token.pullRequestNumber)}`,
          }),
      element("span", {
        class: "token-time",
        children: stepAge(token.startedAt, now),
      }),
    ],
  });
}

export function Station(props: {
  readonly station: WatchStation;
  readonly now: string;
  readonly words?: WatchWords | undefined;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
}): Shown {
  const { station, now } = props;
  const lamp = station.lamp ?? "empty";
  return element("li", {
    class: `station ${lamp}`,
    children: [
      element("span", {
        class: `lamp ${lamp}`,
        title: lampLabel(station.lamp),
      }),
      element("span", {
        class: "station-name",
        children: labelWord(props.words, station.name),
      }),
      station.tokens.length === 0
        ? null
        : element("ul", {
            class: "tokens",
            children: station.tokens.map((token) =>
              element("li", {
                key: token.runId,
                children: [
                  component(Token, { token, now }),
                  component(TokenMenu, {
                    token,
                    paused: token.lamp === "stopped",
                    controlling: props.controlling,
                    renaming: props.renaming,
                  }),
                ],
              }),
            ),
          }),
    ],
  });
}

export function ReadyCount(props: {
  readonly ready: WatchReady;
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { ready, now, words } = props;
  if ("failure" in ready)
    return element("span", {
      class: "line-ready",
      title: ready.failure,
      children: "Ready list failed",
    });
  return [
    element("span", {
      class: "line-ready",
      children:
        words?.["ready.count"] === undefined
          ? `${String(ready.count)} ready`
          : countText(words, {
              key: "ready.count",
              count: ready.count,
              noun: "ready",
            }),
    }),
    ready.oldestAt === null
      ? null
      : element("span", {
          class: "line-wait",
          children: `oldest ${stepAge(ready.oldestAt, now)}`,
        }),
  ];
}

export function LineEnd(
  props: LineLoop &
    LineQueue & {
      readonly workflow: WatchWorkflow;
      readonly now: string;
      readonly words?: WatchWords | undefined;
    },
): Shown {
  const { workflow, now } = props;
  const { ready } = workflow;
  return element("div", {
    class: "line-end",
    children: [
      ready === undefined
        ? null
        : component(ReadyCount, { ready, now, words: props.words }),
      props.queue === undefined
        ? null
        : component(QueueCard, {
            queue: props.queue,
            controls: props.queuing,
            words: props.words,
          }),
      component(LineNext, props),
    ],
  });
}

export function Legend(): Shown {
  const lamps: readonly WatchLamp[] = [
    "running",
    "waiting",
    "needs-you",
    "stopped",
  ];
  return element("ul", {
    class: "legend",
    "aria-label": "Lamp colors",
    children: lamps.map((lamp) =>
      element("li", {
        key: lamp,
        children: [
          element("span", { class: `lamp ${lamp}`, "aria-hidden": "true" }),
          lampLabel(lamp),
        ],
      }),
    ),
  });
}

export function Line(
  props: LineLoop &
    LineQueue & {
      readonly workflow: WatchWorkflow;
      readonly now: string;
      readonly words?: WatchWords | undefined;
      readonly controlling?: RunCommandControls | undefined;
      readonly renaming?: RenameControls | undefined;
    },
): Shown {
  const { workflow, now, words, controlling } = props;
  return element("li", {
    class: "line",
    children: [
      element("div", {
        class: "line-name",
        children: [
          element("a", {
            href: watchHash({
              workflowId: workflow.workflowId,
              runId: null,
              ...(workflow.repository === undefined
                ? {}
                : { repository: workflow.repository }),
            }),
            children: workflow.workflowId,
          }),
          element("span", {
            class: "line-active",
            children: `${String(workflow.activeCount)} active`,
          }),
        ],
      }),
      element("div", {
        class: "line-track",
        children: element("ol", {
          class: "stations",
          children: workflow.stations.map((station) =>
            component(Station, {
              key: station.name,
              station,
              now,
              words,
              controlling,
              renaming: props.renaming,
            }),
          ),
        }),
      }),
      component(LineEnd, props),
    ],
  });
}

export function FloorHead(props: {
  readonly words?: WatchWords | undefined;
}): Shown {
  return element("div", {
    class: "floor-head",
    children: [
      element("h2", {
        id: "floor-title",
        children: wordText(props.words, {
          key: "workflows.title",
          text: "Floor",
        }),
      }),
      component(Legend, {}),
    ],
  });
}

export function Floor(props: {
  readonly model: WatchModel;
  readonly now: string;
  readonly words?: WatchWords | undefined;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
  readonly looping?: LoopControls | undefined;
  readonly queuing?: QueueControls | undefined;
}): Shown {
  const { model, now, words, controlling } = props;
  const queues =
    model.queues ?? (model.queue === undefined ? [] : [model.queue]);
  return element("section", {
    class: "floor",
    "aria-labelledby": "floor-title",
    children: [
      component(FloorHead, { words }),
      component(RunCommandReplies, {
        runs: model.runs.filter((run) => !steerable(run.state)),
        controlling,
      }),
      model.repositories === undefined
        ? component(Lines, {
            workflows: model.workflows,
            now,
            words,
            controlling,
            renaming: props.renaming,
            loops: model.loops,
            queues,
            looping: props.looping,
            queuing: props.queuing,
          })
        : element("ol", {
            class: "repositories",
            children: model.repositories.map((repository) =>
              component(RepositoryLines, {
                key: repository.name,
                repository,
                queues: queues.filter(
                  (queue) => queue["repository"] === repository.name,
                ),
                workflows: model.workflows.filter(
                  (workflow) => workflow.repository === repository.name,
                ),
                now,
                words,
              }),
            ),
          }),
    ],
  });
}

export function Lines(props: {
  readonly workflows: readonly WatchWorkflow[];
  readonly now: string;
  readonly words?: WatchWords | undefined;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
  readonly loops?: readonly WatchLoop[] | undefined;
  readonly queues?: readonly Fields[] | undefined;
  readonly looping?: LoopControls | undefined;
  readonly queuing?: QueueControls | undefined;
}): Shown {
  const { workflows, now, words, controlling } = props;
  if (workflows.length === 0)
    return element("p", {
      class: "meta",
      children: "No workflows registered.",
    });
  return element("ol", {
    class: "lines",
    children: workflows.map((workflow) =>
      component(Line, {
        key: workflow.workflowId,
        queue: props.queues?.find(
          (queue) => queue["workflowId"] === workflow.workflowId,
        ),
        workflow,
        now,
        words,
        controlling,
        renaming: props.renaming,
        loop: props.loops?.find(
          (loop) => loop.workflowId === workflow.workflowId,
        ),
        looping: props.looping,
        queuing: props.queuing,
      }),
    ),
  });
}

export function RepositoryLines(props: {
  readonly repository: WatchRepository;
  readonly queues?: readonly Fields[] | undefined;
  readonly workflows: readonly WatchWorkflow[];
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { repository, workflows, now, words } = props;
  return element("li", {
    class: "repository",
    children: [
      element("h3", { class: "repository-name", children: repository.name }),
      repository.service === "up"
        ? null
        : element("span", {
            class: "repository-down",
            children: "The service does not answer.",
          }),
      component(Lines, { workflows, now, words, queues: props.queues }),
    ],
  });
}
