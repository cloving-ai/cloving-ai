# Triage issue

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy triage-issue`. This operator step happens outside the
application repository. Inspect `cloving templates show triage-issue --json`,
choose the `post` option, apply its edit, update `selection` in
`triage-issue/scenarios.ts`, then run `cloving workflows test triage-issue`.

The workflow gives each new issue from another person a first verdict: a
duplicate, a bug, a feature, or more information needed. It never closes an
issue. For a duplicate, a person closes the issue.

## Schedule and runs

The default schedule runs every 1800 seconds (30 minutes) with `{}` input. Such a
run is a pass:

1. The pass runs the operator command `triage-candidates`.
2. The pass hands off one `triage-issue` run with the input `{ "issue": <number> }`
   for each candidate. One pass hands off at most four runs, so that triage does
   not take every lane.
3. The pass waits for each run that it handed off, up to one day for each run.

The scheduler skips a slot while the pass runs. Thus the next pass cannot hand off
a second run for an issue whose run waits for its approval. When a run waits for
more than one day, the pass ends `blocked` with `run-wait-timeout`. Then a later
pass can hand off a second run for the same issue.

A pass hands off to the workflow ID `triage-issue`. When you copy the template
with `--id <workflow-id>`, set `workflow.handoffs` in the declaration and
`workflowId` in `triage-issue/pass.ts` to the new ID.

To triage one issue at once, start a run with the issue number:

```sh
echo '{"issue": 639}' > issue.json
cloving run triage-issue --input issue.json
```

## The operator command `triage-candidates`

Set `CLOVING_COMMANDS` to a JSON argv array for the read-only command
`triage-candidates`:

```json
{
  "triage-candidates": ["<absolute-triage-candidates-wrapper>"]
}
```

Replace the placeholder with the absolute path of your wrapper. Bare executable
names are refused by command configuration.

The command prints one JSON array, with one item for each candidate:

```json
[{ "number": 639 }, { "number": 641 }]
```

A candidate is an open issue, not a pull request, with these properties:

- The issue does not have the label `cloving: triaged`.
- An account that is not in the operator list opened the issue.
- The issue and its comments have no new post for 10 minutes. The open of the
  issue counts as a post.

A failed command, invalid JSON, an invalid number or a number that occurs two
times blocks the pass before a handoff.

The template includes the reference script `triage-issue/triage-candidates.mts`.
Give the GitHub logins of the operators as its arguments:

```json
{
  "triage-candidates": [
    "<absolute-node>",
    "<absolute-folder>/triage-issue/triage-candidates.mts",
    "<operator-login>"
  ]
}
```

The script reads the open issues and their comments with `gh api` in the
repository of its working directory. It prints the oldest four candidates, in the
order of their numbers. Without an operator login, or when `gh` fails or prints an
unexpected answer, the script prints nothing to standard output and ends with code
1. A command gets no GitHub token from the service. Thus your wrapper must give
`gh` a token, for example `GH_TOKEN` from your secret store.

## The triage turn

Each issue run prepares a work tree on the default branch, and then runs one turn.
The turn reads the issue with `gh issue view`, searches the open and closed issues
with `gh issue list`, and searches the code of the work tree. A turn gets no
GitHub token from the service, so give the harness read access to the issues, as
for the turns of `rescue-pr`.

The last message of the turn is the reply, then one verdict line. The reply gives
the reason and the evidence as `path:line` or the issue link. For
`needs-information`, the reply gives the exact questions. The verdict line is
exactly one of these forms:

- `Triage: duplicate #<number>`
- `Triage: bug <size>`
- `Triage: feature <size>`
- `Triage: needs-information`

The size is `small` (less than about 200 changed lines), `medium` or `large`. A
last line with another form, a duplicate of the issue itself or an empty reply
blocks the run before an approval or a post.

## The `post` point

- **A person approves** (the default): one approval decision shows the verdict
  and the reply. Nothing is posted before the approval. An approval posts the
  reply. A denial or an expiry posts no comment and adds only `cloving: triaged`,
  so that a later pass does not pick the issue again.
- **Post at once**: the run posts the reply without a decision.

The GitHub method `comment-issue` posts the reply and the verdict line as one
comment. It uses the same privacy check as an issue body, so every post requires
`privateTexts` with at least one nonblank item. After the post, the run adds
`cloving: triaged` and the label of the verdict: `cloving: duplicate`,
`cloving: bug`, `cloving: feature` or `cloving: needs-information`.

When the privacy check refuses the reply, the run adds only `cloving: triaged` and
ends `blocked` with `private-path-in-change`. Thus a later pass does not run a
new turn for the same issue. When the post fails for another reason, the run adds
no label and ends `blocked` with that reason.

To triage an issue again, remove `cloving: triaged` from it. The workflow never
adds `cloving: ready`. A person decides when an issue becomes work.
