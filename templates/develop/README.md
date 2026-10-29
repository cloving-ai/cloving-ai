# Develop template decisions

`template.json` describes the five decisions used by the develop template.
The default workflow in `develop.ts` accepts the declared ticket input, selects
from the queue, opens a pull request, waits for Greptile at 5/5, and calls
`mergeWhenGreen` with `check: "beforeMerge"`. Its declaration and helper files
pass folder admission, including compilation with the Workflow SDK in a packed
installation. Copy this directory's contents into a workflow folder.

The host supplies `{ cycleId, repository, input: { ticket: { id, text } } }`.
`develop/report.ts` extracts the resolved text and preserves the worker's ticket
status. `develop/round.ts` composes development, review and merge. A failed
review or repairable merge result gives its full output and remaining work to
the next worker turn. Review, local-check, conflict and CI fixes share a limit
of three fix rounds. Pending CI and an unconfigured check stop the run.

`develop.test.ts` and `develop/flow-tests.ts` test the default composition through the public fake
step bridge. The alternative configurations use `develop/option-tests.ts`, with the selected
point IDs in `develop/scenarios.ts`. For an edited copy, replace the default
`flowTests` and `refusalTests` imports in `develop.test.ts` with
`optionTests as flowTests`, then run every `flowTests` scenario. Keep the shared
turn and partial-helper tests. Package tests apply each source edit, validate
its requirements, and test seven complete configurations through the folder
loader and the installed package, covering every option.

`develop/turn.ts` implements the development turn for either a resolved
`ticket` or a task `prompt`. It calls the public protected effect helper and
returns the broker result unchanged. Its `feedback` takes the previous
result's `reason`, full `output`, and `remaining` items. Rounds 1 through 4
allow the initial turn and three fix turns; the workflow must stop after that.
`develop.test.ts` exercises this helper with `cloving/workflows/testing`.
The package tests also load small compositions of this helper through folder
admission for both input forms and test both forms in complete workflows.

`develop/partial.ts` implements the person's partial-work question.
`develop/partial-choice.ts` connects its answer to a development report and the
next round, or returns a blocked outcome without opening a review or merging. `reviewPartial`
opens a question with an identity scoped to the run and round. It returns
nonempty feedback from an explicit answer, or stops. It opens no question
after the initial turn and three fix turns. The separate `develop/queue-partial.ts`
helper, `queuePartial`, forwards the issue,
merged pull request and remaining items to the protected `partial-issue`
operation, preserving its result. The GitHub worker owns partial-run history
and requeues the first two runs, then blocks the ticket from the third.
Folder-admission tests cover both helpers in the checkout and packed install.
The default workflow calls `queuePartial` after merging partial work, closes
complete issues, and reports a failed issue update in its outcome.
The person-only composition needs no GitHub capability. `develop/local.ts`
implements its round: develop, ask about partial work, review the immutable
commit, and leave the branch for the person to merge. It refuses missing or
malformed commit IDs and reports of uncommitted work. `develop/accept.ts`
contains the editable pull-request acceptance call. `promptInput` in
`develop/report.ts` adapts task text without looking up a ticket.
Only resolved ticket input supplies an issue identity for lifecycle updates.
Task text keeps its full contents, including any issue-looking lines, without
selecting an issue to label, close or return to the queue.

The first option of each point is the default: ticket input, queue selection,
Greptile at 5/5, merge after checks, and return partial work to the queue.
Selecting `person` at selection, acceptance and partial work, with `local` at
merge, describes the existing reviewed local-branch process.

Each option has an `id`, `label`, `summary`, `change`, `requires` and `needs`.
`change` describes the step call or declaration edit for the setup agent.
It is guidance for editing source, rather than an executable patch.

`requires` maps another point ID to its allowed option IDs. All named points
must satisfy their requirement; any listed option for one point satisfies that
point. For example, `"merge": ["person", "green"]` requires either pull-request
merge option. An empty object imposes no additional requirement. Select exactly
one known option at each point and validate the complete selection after edits.

`needs` lists `cloving doctor` codes required by that option. The configured
workflow also needs the common runtime and harness checks reported by doctor.

Changing metadata does not change runtime behavior. The setup agent must apply
the source and declaration edits, run the workflow's scenario tests, and load
the edited configuration through folder admission before using it.
