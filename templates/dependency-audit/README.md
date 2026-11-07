# Dependency audit

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy dependency-audit`. Copy `dependency-ticket` into the
same folder with `cloving templates copy dependency-ticket`, because the audit
hands off to it. This operator step happens outside the application repository.
Then run `cloving workflows test dependency-audit` and
`cloving workflows test dependency-ticket`.

The default schedule runs every 86400 seconds (each day) with `{}` input. The
scheduler skips a slot while the audit runs.

The audit does not change a dependency. The tickets that it writes make the
changes. It uses only critical and high advisories. It ignores moderate and low
advisories.

## The operator command `audit-candidates`

The copy has the reference script `dependency-audit/audit-candidates.mts`. Set
`CLOVING_COMMANDS` to a JSON argv array for the command `audit-candidates`:

```json
{
  "audit-candidates": [
    "<absolute-node-executable>",
    "<absolute-workflow-folder>/dependency-audit/audit-candidates.mts",
    "<absolute-github-cli-folder>"
  ]
}
```

Replace the placeholders with absolute paths. Bare executable names are refused
by command configuration. The script runs `git`, `npm` and `gh` from `PATH` in
the folder of the service, which is the repository. `npm ci` can take some
minutes, so set `CLOVING_COMMAND_SECONDS` to a sufficient time, for example 900.

The service gives an operator command no GitHub token variable and an empty
`GH_CONFIG_DIR`, as it does for a turn. Thus the last array item is the GitHub CLI
configuration folder of a login that can read the issues of the repository. The
script sets `GH_CONFIG_DIR` to this folder only for its `git` and `gh` calls.
Thus `git fetch` can also use `gh` as its credential helper. The `npm` calls
keep the empty folder. Without exactly one absolute folder, the script runs no
command, prints nothing to standard output and ends with code 1.

To make a folder for this command alone, run
`GH_CONFIG_DIR=<absolute-github-cli-folder> gh auth login` one time. A token
that can read the contents and the issues of the repository is sufficient. On a
computer with a system keyring, `gh` keeps the token in the keyring, and the
folder names only the account.

The script does these steps:

1. It removes the folders and the work trees of earlier audits whose process
   ended. The command time limit or a stop ends an audit with `SIGKILL`, so
   that audit cannot remove its own files. A folder that it cannot remove, for
   example the folder of another user in a shared `/tmp`, stays. The script
   writes its name and the error on standard error and goes on with the audit.
2. It reads the current default branch of the remote `origin` with
   `git ls-remote --symref origin HEAD`, not from the local
   `refs/remotes/origin/HEAD`, and fetches that branch.
3. It adds a clean detached work tree of that branch in a new temporary folder
   `cloving-audit-<process ID>-<random text>`.
4. It runs `npm ci --ignore-scripts --no-audit --no-fund`, then
   `npm audit --json` (report version 2) and `npm ls --all --json` in that tree.
5. It reads all pages of the open issues with the label `cloving: security`
   through `gh api`.
6. It removes the work tree and the temporary folder, also after a failure.

In step 1, the folder name gives the process ID of the audit. The script removes
each folder `cloving-audit-<process ID>-<random text>` of the system temporary
folder, and each work tree `cloving-audit-<process ID>-<random text>/tree` of the
repository, when no process has that ID. The folder of an audit that still runs
stays. A remote that names no default branch stops the audit with the message
`The remote origin names no default branch.`

The script prints one JSON array with at most 10 packages:

```json
[
  {
    "name": "minimist",
    "severity": "critical",
    "direct": false,
    "range": "<=0.2.3",
    "versions": ["0.2.1"],
    "effects": ["mkdirp"],
    "fixAvailable": {
      "name": "mkdirp",
      "version": "0.5.6",
      "isSemVerMajor": false
    },
    "advisories": [
      {
        "id": "GHSA-xvch-5gv4-984h",
        "severity": "critical",
        "title": "Prototype Pollution in minimist",
        "url": "https://github.com/advisories/GHSA-xvch-5gv4-984h",
        "vulnerableRange": "<0.2.4",
        "patchedRange": ">=0.2.4"
      }
    ],
    "paths": ["mkdirp@0.5.1 > minimist@0.2.1"],
    "pathCount": 1
  }
]
```

| Field          | Value                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| `name`         | The package that has the advisory.                                                            |
| `severity`     | `critical` when one of its advisories is critical, else `high`.                               |
| `direct`       | `true` when `package.json` names the package.                                                 |
| `range`        | The vulnerable versions of the package, from `npm audit`.                                     |
| `versions`     | The installed versions in that range.                                                         |
| `effects`      | The packages that depend on the package, from `npm audit`.                                    |
| `fixAvailable` | The fix of `npm audit`: `true`, `false`, or the package and version of the fix.               |
| `advisories`   | Each critical or high advisory: ID, severity, title, URL, vulnerable range and patched range. |
| `paths`        | At most 20 install paths of a vulnerable version from `npm ls --all`, the shortest first.     |
| `pathCount`    | The number of all install paths of a vulnerable version.                                      |

The advisory ID is the GitHub advisory ID from the URL, or the npm advisory
number when the URL has no GitHub advisory ID. The patched range is each version
outside the vulnerable range. It is `null` when no version is outside the range,
or when the range has a form that the script does not know.

The script leaves out each advisory whose ID is in the title or the body of an
open issue with the label `cloving: security`. A pull request does not count. A
package that has no other critical or high advisory is left out. The critical
packages come first, then the packages in the order of their names. When a step
fails, the script prints no package, writes the cause to standard error and ends
with the code 1.

## The audit turn

A day with no new critical or high advisory ends `completed` with no turn and
no ticket.

Else the `prepare` method gives a work tree of the newest default branch, and
one turn plans the tickets. The turn gets the candidates as untrusted data. It
puts the packages into at most 5 groups: one package, or the packages that one
upgrade fixes. For each group, it names the exact change: a new pinned version
(`pin`), or an entry in `overrides` of `package.json` (`override`). It reads
the release notes of each version from the installed version to the new
version, and lists each breaking change. For each breaking change it gives each
place of the code that uses the changed part as `path:line`, and the code
change, or the reason that the project does not use it. The turn returns JSON
of at most 12000 characters in its final summary. After the turn, also after a
failure, the `discard` method removes the work tree.

The turn reads files and web pages. Before you enable the schedule, add a turn
profile for this workflow with `maxBudgetUsd` and the tools for this work, for
example `Read`, `Glob`, `Grep` and `WebFetch`. Change the method of the turn and
its declaration entry from `run-turn` to `run-turn:<profile>` to use the
profile.

The workflow checks the plan. Each package of a group must be a candidate, and
in one group only. A version must have the form `1.2.3`. A code place must be a
relative `path:line`. A source must be an `http` or `https` URL that is not an
issue or a pull request. An invalid plan blocks the run with
`invalid-audit-plan`, and a summary above 12000 characters blocks it with
`audit-plan-too-large`. A failed command or an invalid candidate list blocks the
run before the turn.

## The tickets

The workflow puts the critical groups first and keeps at most 5 groups. For each
group it writes a ticket in the form of the repository: `Problem`,
`Desired outcome`, `Concrete scenario`, `Scope`, `Non-goals`,
`Acceptance criteria`, `First tests` and `Sources`. The ticket has:

- the table of each advisory of its packages, with the ID, the severity, the
  title, the vulnerable range and the patched range;
- each install path of the packages;
- the exact change, and each breaking change with its code places and its code
  change or the reason that the project does not use it;
- the rule that the new version gets the same exact pin and the same
  justification as the current version, and that the installed packed artifact
  is inspected with scripts disabled;
- the acceptance criteria: `npm audit --json` on the branch lists none of the
  advisories of the table, the lock file has no version in a vulnerable range,
  each breaking change has its code change or its reason, and the developer gate
  passes.

`create-issue` makes one issue for each run, because its duplicate marker uses
the target of the run. Thus the audit hands off one `dependency-ticket` run for
each ticket with the input `{"text": "<ticket>"}`. That run creates the issue
and adds the label `cloving: security`. The ticket names each advisory ID of its
table, so a later audit leaves these advisories out while the issue is open. A
ticket above 48000 bytes blocks the run before the first handoff with
`audit-ticket-too-large`. A package that is not in a ticket stays a candidate,
and a later audit gives it to a turn again.

The static effect count is 9: the command, `prepare`, the turn, `discard` and
5 handoffs.
