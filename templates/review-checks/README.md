# Review checks

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy review-checks`. This operator step happens outside
the application repository. Then run `cloving workflows test review-checks`.

The default schedule runs on Mondays at 07:00 with `{}` input. The copy gets the
time zone of the computer in place of the `UTC` of the template. To change the
time, set `CLOVING_SCHEDULES` or change the declaration of the copy.

The workflow does not change the lint or quality settings. The tickets that it
writes make the changes. It reads only the review comments of this repository.

## The operator commands

The copy has two reference scripts. Set `CLOVING_COMMANDS` to a JSON object
with the two commands:

```json
{
  "review-comments": [
    "<absolute-node-executable>",
    "<absolute-workflow-folder>/review-checks/review-comments.mts",
    "<absolute-github-cli-folder>",
    "<absolute-runtime-directory>/review-checks.jsonl"
  ],
  "review-checks-record": [
    "<absolute-node-executable>",
    "<absolute-workflow-folder>/review-checks/review-checks-record.mts",
    "<absolute-runtime-directory>/review-checks.jsonl"
  ]
}
```

Replace the placeholders with absolute paths. Bare executable names are refused
by command configuration. The runtime directory of the service is
`CLOVING_RUNTIME_DIR` when you set it. Else it is the default runtime directory
of the repository, for example `~/.local/state/cloving/<name>-<id>/run`. Give
both commands the same decisions file.

The service gives an operator command no GitHub token variable and an empty
`GH_CONFIG_DIR`. Thus `review-comments` gets the GitHub CLI configuration folder
of a login that can read the pull requests and the issues of the repository. The
script sets `GH_CONFIG_DIR` to this folder only for its `gh` calls. To make a
folder for this command alone, run
`GH_CONFIG_DIR=<absolute-github-cli-folder> gh auth login` one time. Without
exactly two absolute arguments, the script runs no command, prints nothing to
standard output and ends with code 1.

### `review-comments`

The script runs in the folder of the service, which is the repository. It does
these steps:

1. It lists the pull requests that merged in the last 7 days with
   `gh pr list --state merged --search "merged:>=<date>"`, and keeps the pull
   requests that merged at or after the time 7 days ago.
2. It reads all pages of the review comments of each pull request with
   `gh api`. It keeps the top-level comment of each thread, of bots (for
   example Greptile findings) and of people. It keeps at most 200 comments and
   cuts each text at 2000 characters.
3. It runs `node_modules/.bin/eslint --print-config <path>` for at most 10
   commented JavaScript or TypeScript files, and keeps the highest severity of
   each rule. A file that ESLint ignores adds no rule. When the folder has no
   `node_modules/.bin/eslint`, the list is empty.
4. It lists the file names of the folder `quality` without their extension, and
   leaves out declaration and test files. When the folder is absent, the list is
   empty.
5. It reads all pages of the open issues with the label `cloving: check`. A
   pull request does not count. The line `Check: <name>` of an issue gives its
   check name.
6. It reads the decisions file. An absent file gives no decision.

The script prints one JSON object:

```json
{
  "since": "2026-11-02T07:00:00Z",
  "comments": [
    {
      "pullRequest": 641,
      "path": "src/queue.ts",
      "line": 12,
      "author": "greptile-apps[bot]",
      "bot": true,
      "text": "This promise is not awaited inside the loop.",
      "url": "https://github.com/acme/demo/pull/641#discussion_r1"
    }
  ],
  "lintRules": { "no-await-in-loop": "off", "no-console": "error" },
  "qualityChecks": ["clones", "structure"],
  "openTickets": [
    {
      "number": 700,
      "title": "Add the review check await-in-loop",
      "url": "https://github.com/acme/demo/issues/700",
      "check": "await-in-loop"
    }
  ],
  "decisions": [
    {
      "name": "await-in-loop",
      "shape": "A promise that a loop starts and never awaits.",
      "decision": "defer",
      "links": ["https://github.com/acme/demo/pull/641#discussion_r1"]
    }
  ]
}
```

When a step fails, the script prints nothing to standard output, writes the
cause to standard error and ends with code 1. An invalid line of the decisions
file also stops the script. The workflow refuses facts that do not have this
form with `invalid-review-comments`.

### `review-checks-record`

The script reads `{"decisions": [...]}` on standard input. It appends one JSON
line for each decision to the decisions file, with `name`, `kind`, `rule`,
`shape`, `decision`, `links`, the time `decidedAt` and the run ID `runId`. It
prints `{"recorded": N}`. Bad input appends nothing, prints nothing to standard
output and ends with code 1.

## The group turn

A week with fewer than 3 comments, or with comments on fewer than 2 pull
requests, ends `completed` with no turn and no question.

Else the `prepare` method gives a clean work tree of the newest default branch,
and one turn reads the facts as untrusted data.

A turn request has at most 65536 bytes. When the facts are larger, the turn
gets this part of them:

- The newest earlier decisions that fit in one quarter of the free bytes.
- The first open tickets that fit in one quarter of the free bytes.
- The first comments that fit in the remaining bytes.

The workflow checks each suggestion against all facts. When the facts with no
comments, tickets and decisions are larger than the limit, the run blocks with
`check-facts-too-large` before `prepare`.

The turn does these steps:

1. It keeps a comment only when a deterministic check of the source can find
   its problem. It leaves out questions, praise, design choices, missing tests
   and typos in prose.
2. It groups the kept comments by code shape, and keeps a group with at least 3
   comments on at least 2 pull requests.
3. It drops a group that an existing rule already reports, that an open ticket
   already covers, or that an earlier decision rejected.
4. It returns at most 5 suggestions in its final summary, as JSON of at most
   12000 characters.

After the turn, also after a failure, the `discard` method removes the work
tree. The turn counts the hits in the work tree. Before you enable the schedule,
add a turn profile for this workflow with `maxBudgetUsd` and the tools for this
work, for example `Read`, `Glob`, `Grep` and `Bash`. Change the method of the
turn and its declaration entry from `run-turn` to `run-turn:<profile>` to use
the profile.

Each suggestion has these fields:

| Field          | Value                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| `name`         | A name of lowercase letters, digits and hyphens. The decisions use it.                  |
| `shape`        | One sentence about the code shape.                                                      |
| `links`        | The links of the threads in the group.                                                  |
| `kind`         | `enable-rule` (an ESLint rule to turn on), `new-rule` (a new ESLint rule) or `quality-check` (a new quality check). |
| `rule`         | The name of the rule or the check.                                                      |
| `hits`         | The count of hits on the default branch.                                                |
| `countCommand` | The command that counted the hits.                                                      |
| `scope`        | `all` (the check covers all code) or `changed` (only new and changed code).             |

The workflow checks each suggestion again. It keeps a suggestion only when all
these conditions are true:

- At least 3 of its links are comments of the facts, on at least 2 pull
  requests. The workflow removes the other links.
- Its rule is not a lint rule with the severity `warn` or `error`, and not a
  quality check of the facts.
- No open ticket of the facts has its name.
- No earlier decision with its name is `reject`.
- When an earlier decision with its name is `accept` or `defer`, it has a link
  that no such decision had.

A shape, a rule or a command with a mention or an email address blocks the run
with `invalid-check-suggestions`, because the issue must pass the privacy check.
A summary above 12000 characters blocks the run with
`check-suggestions-too-large`. With no suggestion, the run ends `completed` with
no question.

## The question

One question lists each suggestion with its kind, its scope, its shape, its
hits, its command and its threads. Answer one word for each suggestion, in
order: `accept`, `reject` or `defer`, for example `accept reject defer`. Commas
and capital letters are permitted. Another number of words, or another word,
blocks the run with `invalid-check-answer`. A denied or expired question blocks
the run with `check-question-not-answered`. A blocked run records no decision,
so the same suggestions can come back the next week.

## The tickets

`create-issue` makes one issue for each run, because its duplicate marker uses
the target of the run. Thus the pass hands off one run of the same workflow for
each accepted suggestion, at most 5, with the input `{"text": "<ticket>"}`. A
copy made with `--id <id>` hands off to `<id>`. That run
creates the issue with `create-issue` and adds the label `cloving: check`. The
privacy check of `create-issue` applies, so the run requires `privateTexts`.

The ticket has the form of the repository: `Problem`, `Desired outcome`,
`Concrete scenario`, `Scope`, `Non-goals`, `Acceptance criteria` and
`First tests`. It has the shape, each thread link, the kind and the rule, the
scope, the count of hits and the command. The line `Check: <name>` names the
check, so a later pass leaves the suggestion out while the issue is open.

After the handoffs, the pass runs `review-checks-record` with all decisions. A
rejected suggestion never comes back. A deferred suggestion comes back when a
new thread gives more evidence. The report names the accepted, rejected and
deferred suggestions.

The static effect count is 12: `review-comments`, `prepare`, the turn,
`discard`, 5 handoffs, `review-checks-record`, `create-issue` and `label`. The
question costs no effect unit.
