# Goal to tickets

Copy this template with `cloving templates copy goal-to-tickets`. Answer its two
questions using `cloving templates show goal-to-tickets --json`, apply the
indicated imports and declaration edits, and run
`cloving workflows test goal-to-tickets`. The copied workflow accepts the input
`{"goal": "<text>"}`. The declaration accepts at most 32768 bytes of input JSON.

## The plan

A research turn reads the code and writes `cloving-goal-plan.md` in the work
tree root. The plan has 1 to 12 drafts in the ticket format of the Cloving
README. Each draft starts with the line `# Draft N: <title>`, and N counts from
1. The `## Dependencies` section of a draft has one line `Needs draft N` for each
draft of the plan that must close first. A line `Needs #<number>` names an
existing issue that must close first.

The workflow refuses the plan with `invalid-plan` when one of these conditions
is true:

- The file has no draft or more than 12 drafts.
- The numbers of the drafts do not count from 1 in order.
- Text that is not blank comes before the first draft.
- A `draft N` in a `## Dependencies` section names no draft of the plan.

Each `draft N` in a `## Dependencies` section is a blocker. When the blockers
make a cycle, the plan goes back to the research turn one time. The prompt of
that turn names the cycle, for example `draft 1 -> draft 2 -> draft 1`. A second
cycle ends the run `blocked` with `plan-cycle`, and the run posts nothing.

## The review

The default review turn corrects the drafts against the code. The workflow then
reads the plan again and checks it again. A cycle after the review also ends the
run with `plan-cycle`.

To read the plan yourself, select `review.person`. One approval decision shows
the title and the dependencies of each draft in the post order, and then the
full plan. A denial or an expired decision ends the run with
`plan-not-approved`, and the run posts nothing. A blocked run before the post
keeps the work tree, so you can read `cloving-goal-plan.md`.

## The post

After the review, the workflow removes the work tree. Then it posts the tickets
in dependency order with the GitHub method `create-issue`, so each blocker gets
its number first. In the `## Dependencies` section, each `draft N` becomes
`#<number>` of the posted blocker. Thus `Needs draft N` becomes
`Needs #<number>`, and the queue of Cloving reads it as a hard dependency.

Each post sends the ticket text with the privacy check of `create-issue`, so a
post requires `privateTexts` with at least one nonblank item. Each post has its
own target, `<cycle>:draft-<N>`, so each issue gets its own hidden marker, and a
replay finds the issue and does not post it again. A refused post ends the run
`blocked`. The tickets posted before it stay, and they name only posted
tickets.

## What happens next

- `next.queue` (the default) adds `cloving: ready` to each posted ticket. The
  queue of Cloving starts a ticket only when each issue in its
  `Needs #<number>` lines is closed, so the tickets start in dependency order.
  The report names the tickets that wait for a blocker.
- `next.develop` hands the first ticket with no blocker to the repository
  workflow `develop`. Set `targetWorkflow` in `goal-to-tickets/develop.ts` and
  `workflow.handoffs` in the declaration to the same workflow ID. If the handoff
  fails, the ticket gets `cloving: ready`.
- `next.nothing` leaves the posted tickets for a person. Remove `label` from
  `methods.github` in the declaration.

The run ends `handoff_requested`. The promotion is `issues-<number>-...` with
the posted numbers in the post order, and the report lists each ticket.

## The effect limit

The declaration has `effectLimit` 32. A plan of 12 tickets uses at most 32
effects: 1 prepare, 2 research turns with 2 reads of the plan, 1 review turn with
1 read, 1 discard, 12 posts and 12 labels. Update `selection` in
`goal-to-tickets/scenarios.ts` to match your choices. The copied tests use it to
check the decision, the review turn, the labels and the handoff, so a copy with
other imports fails `cloving workflows test`.
