import { component, element, type Shown } from "./watch-element.ts";
import { stepAge } from "./watch-floor-view.ts";
import type {
  Copying,
  DecisionReply,
  WatchDecision,
  WatchRun,
  WatchTurn,
} from "./watch-render.ts";
import { Command, Work } from "./watch-turn.ts";

export interface DecisionChoice {
  readonly decision: WatchDecision;
  readonly reply: DecisionReply;
}

export interface DecisionControls {
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly answers: Readonly<Record<string, string>>;
  readonly onAnswer: (answer: {
    readonly decisionId: string;
    readonly text: string;
  }) => void;
  readonly onReply: (choice: DecisionChoice) => void;
}

export function decisionHeading(decision: WatchDecision, now: string): string {
  const age = stepAge(decision.openedAt, now);
  const waited = age === "" ? "" : ` · waiting ${age}`;
  return `Your decision · ${decision.type}${waited}`;
}

export function replyLabel(reply: DecisionReply): string {
  const labels: Readonly<Record<DecisionReply, string>> = {
    approve: "Approve",
    deny: "Deny",
    answer: "Answer",
  };
  return labels[reply];
}

export function buttonReplies(
  decision: WatchDecision,
): readonly DecisionReply[] {
  return decision.replies.filter((reply) => reply !== "answer");
}

export function ReplyButtons(props: {
  readonly decision: WatchDecision;
  readonly deciding: DecisionControls;
  readonly prefix: string;
}): Shown {
  const { decision, deciding, prefix } = props;
  const busy = deciding.busy.includes(decision.decisionId);
  return buttonReplies(decision).map((reply) =>
    element("button", {
      type: "button",
      class: `${prefix}${reply}`,
      ...(busy ? { disabled: true } : {}),
      onClick: () => {
        deciding.onReply({ decision, reply });
      },
      children: replyLabel(reply),
    }),
  );
}

export function AnswerForm(props: {
  readonly decision: WatchDecision;
  readonly deciding: DecisionControls;
}): Shown {
  const { decision, deciding } = props;
  const { decisionId } = decision;
  if (decision.private === true || !decision.replies.includes("answer"))
    return null;
  return element("form", {
    class: "decision-answer",
    onSubmit: (event: Event) => {
      event.preventDefault();
      deciding.onReply({ decision, reply: "answer" });
    },
    children: [
      element("label", {
        children: [
          "Your answer",
          element("textarea", {
            id: `answer-${decisionId}`,
            name: "answer",
            rows: 4,
            value: deciding.answers[decisionId] ?? "",
            onInput: (event: { currentTarget: { value: string } }) => {
              deciding.onAnswer({
                decisionId,
                text: event.currentTarget.value,
              });
            },
          }),
        ],
      }),
      element("button", {
        type: "submit",
        ...(deciding.busy.includes(decisionId) ? { disabled: true } : {}),
        children: "Send the answer",
      }),
    ],
  });
}

export function DecisionLine(props: {
  readonly runId: string;
  readonly deciding: DecisionControls | undefined;
}): Shown {
  const message = props.deciding?.messages[props.runId];
  if (message === undefined) return null;
  return element("p", {
    class: "decision-reply",
    role: "status",
    children: message,
  });
}

export function Decision(props: {
  readonly decision: WatchDecision;
  readonly turn: WatchTurn | undefined;
  readonly copying: Copying;
  readonly now: string;
  readonly deciding?: DecisionControls | undefined;
}): Shown {
  const { decision, turn, copying, deciding } = props;
  const buttons =
    deciding === undefined || buttonReplies(decision).length === 0
      ? null
      : component(ReplyButtons, { decision, deciding, prefix: "decision-" });
  return element("section", {
    class: "decision",
    id: `decision-${decision.decisionId}`,
    children: [
      element("h3", { children: decisionHeading(decision, props.now) }),
      element("pre", { class: "request", children: decision.prompt }),
      decision.private === true
        ? element("p", {
            class: "meta",
            children: "The full text is on your paired phones.",
          })
        : null,
      buttons === null
        ? null
        : element("div", { class: "decision-replies", children: buttons }),
      deciding === undefined
        ? null
        : component(AnswerForm, { decision, deciding }),
      decision.replies.map((reply) =>
        component(Command, {
          label: replyLabel(reply),
          command: decision[reply],
          copying,
        }),
      ),
      turn === undefined ? null : component(Work, { turn }),
    ],
  });
}

export function RunDecisions(props: {
  readonly run: WatchRun;
  readonly copying: Copying;
  readonly now: string;
  readonly deciding: DecisionControls | undefined;
}): Shown {
  const { run, copying, now, deciding } = props;
  const turn = run.turns.at(-1);
  return [
    component(DecisionLine, { runId: run.runId, deciding }),
    run.decisions.map((decision) =>
      component(Decision, {
        key: decision.decisionId,
        decision,
        turn,
        copying,
        now,
        deciding,
      }),
    ),
  ];
}

export const decisionFunctions = [
  decisionHeading,
  replyLabel,
  buttonReplies,
  ReplyButtons,
  AnswerForm,
  DecisionLine,
  Decision,
  RunDecisions,
];
