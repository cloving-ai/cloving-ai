# Develop template decisions

`template.json` describes the five decisions used by the develop template.
The executable workflow is pending the review and merge step implementations.
This directory cannot yet be admitted as a workflow folder.

`develop/turn.ts` implements the development turn for either a resolved
`ticket` or a task `prompt`. It calls the public protected effect helper and
returns the broker result unchanged. Its `feedback` takes the previous
result's `reason`, full `output`, and `remaining` items. Rounds 1 through 4
allow the initial turn and three fix turns; the workflow must stop after that.
`develop.test.ts` exercises this helper with `cloving/workflows/testing`.
The package tests load a small composition of the helper through folder
admission for both input forms. That composition is a test fixture, not the
complete develop workflow.

`develop/partial.ts` implements the person's partial-work choice. `reviewPartial`
opens a question with an identity scoped to the run and round. It returns
nonempty feedback from an explicit answer, or stops. It opens no question
after the initial turn and three fix turns. The separate `develop/queue-partial.ts`
helper, `queuePartial`, forwards the issue,
merged pull request and remaining items to the protected `partial-issue`
operation, preserving its result. The GitHub worker owns partial-run history
and requeues the first two runs, then blocks the ticket from the third.
Folder-admission tests cover both helpers in the checkout and packed install;
the complete workflow must still compose them with review and merge.
The person-only composition needs no GitHub capability.

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
