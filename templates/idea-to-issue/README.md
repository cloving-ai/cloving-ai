# Idea to issue

Copy this template with `cloving templates copy idea-to-issue`. Answer its three
questions using `cloving templates show idea-to-issue --json`, apply the indicated
imports and declaration edits, and run `cloving workflows test idea-to-issue`.
The copied workflow accepts an `idea` string.

The default workflow researches the idea, runs a turn to correct its draft, posts
after the existing privacy check, and hands the issue to the repository workflow
named `develop`. Copy the develop template or set `targetWorkflow` in
`idea-to-issue/next.ts` and `workflow.handoffs` in the declaration to your declared
development workflow. Its input must accept a `ticket` string.

To read the draft yourself, select `review.person`. To approve publication, select
`post.person`. Each choice captures the draft through `github capture-draft`
before opening its approval gate. The gates show the captured text. The issue post
checks every captured digest against the text it posts. A changed draft, denial,
or expired gate stops the run and leaves the work tree and draft available.

To queue the issue, select `next.queue`; this adds `cloving: ready`. To leave it
alone, select `next.nothing`. Both declarations have `handoffs: []`, and neither
needs a develop workflow. A failed handoff returns the issue to the queue.

Every post requires `privateTexts` containing at least one nonblank item. Human
approval does not bypass the privacy check. Run `cloving doctor` for the `needs`
codes in the selected options. Update `selection` in `idea-to-issue/scenarios.ts`
to match the choices so the copied tests verify their expected behavior.
