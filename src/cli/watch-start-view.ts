import { component, element, type Shown } from "./watch-element.ts";
import type { Copying, WatchModel } from "./watch-render.ts";
import { Command } from "./watch-turn.ts";

interface StartPrompt {
  readonly workflowId: string;
  readonly sentence: string;
  readonly prompt: string;
}

export function startPrompts(): readonly StartPrompt[] {
  return [
    {
      workflowId: "develop-issue",
      sentence: "Work on a GitHub issue through a pull request.",
      prompt: `Start a Cloving run for a GitHub issue in this repository.
Run: cloving run develop-issue --ticket ISSUE_NUMBER
Use the issue number that I give on the last line.
Report the run ID. Then run cloving status RUN_ID until the run completes or stops, and tell me the result and the pull request.
Do not push, merge or change labels yourself.
Issue number:`,
    },
    {
      workflowId: "develop-ticket",
      sentence: "Work on a ticket with your review of the diff.",
      prompt: `Start a Cloving run for a ticket in this repository.
Run: cloving run develop-ticket --ticket TICKET_ID
Use the ticket ID that I give on the last line.
When the run waits for a decision, run cloving questions, show me the diff and the decision, and give me the approve and deny commands.
Run only the command that I choose. Do not decide for me.
Ticket ID:`,
    },
    {
      workflowId: "develop-prd",
      sentence: "Turn an idea into a GitHub issue.",
      prompt: `Start a Cloving run that turns an idea into a GitHub issue.
Run: cloving run develop-prd --prompt "IDEA"
Use the idea that I give on the last line as IDEA.
When the run completes, show me the new issue.
Add the label cloving: ready only when I tell you to.
Idea:`,
    },
    {
      workflowId: "develop-prompt",
      sentence: "Do a small task with your review of the diff.",
      prompt: `Start a Cloving run for a small task in this repository.
Run: cloving run develop-prompt --prompt "TASK"
Use the task that I give on the last line as TASK.
When the run waits for a decision, run cloving questions, show me the diff, and give me the approve and deny commands.
Run only the command that I choose. Do not decide for me.
Task:`,
    },
  ];
}

export function StartCard(props: {
  readonly item: StartPrompt;
  readonly copying: Copying;
}): Shown {
  const { item, copying } = props;
  return element("article", {
    class: "start-card",
    children: [
      element("h3", { children: item.workflowId }),
      element("p", { children: item.sentence }),
      component(Command, {
        label: "Agent prompt",
        command: item.prompt,
        copyLabel: "Copy the prompt",
        copying,
      }),
    ],
  });
}

export function StartRun(props: {
  readonly workflows: WatchModel["workflows"];
  readonly copying: Copying;
}): Shown {
  const registered = startPrompts().filter((item) =>
    props.workflows.some((workflow) => workflow.workflowId === item.workflowId),
  );
  const cards = registered.map((item) =>
    component(StartCard, {
      key: item.workflowId,
      item,
      copying: props.copying,
    }),
  );
  return element("details", {
    class: "start-run",
    open: true,
    children: [
      element("summary", { children: "Start a run" }),
      element("div", { class: "start-cards", children: cards }),
    ],
  });
}
