# Answer review

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy answer-review`. This operator step happens outside
the application repository. Inspect `cloving templates show answer-review --json`,
choose the `resolve` option, apply its edit, update `selection` in
`answer-review/scenarios.ts`, then run `cloving workflows test answer-review`.

The workflow answers the open review threads of one pull request of Cloving that
no run owns. The input is `{"pullRequest": N}`. The `patrol` template hands off
to `answer-review` with this input. A person can also start a run with this input.

## Steps

1. The GitHub method `prepare` with `{"pullRequest": N}` puts the work tree on the
   branch of the pull request. It refuses a pull request that is not open, a
   branch that is not a `cloving/` branch, and a pull request that an active run
   owns.
2. The GitHub method `review-threads` reads the open review threads through the
   GraphQL field `reviewThreads`. It returns the threads that are not resolved and
   whose last comment is not by the GitHub account of the operator. Each thread
   has its path, its line, its outdated flag, a bot flag and its comments with the
   author and the time. The method also returns the top-level comments of people
   since the last commit. When no thread is open, the run ends with no turn.
3. The GitHub method `record-answered` keeps the newest comment of the read for
   the pull request. The patrol does not hand off the same comments again.
4. One turn gets the pull request, the command for its diff, and at most ten open
   threads with the labels `T1` to `T10`. For each thread the turn fixes the code
   with a failing test first, or it explains why no change is needed. The turn
   runs the developer gate and commits. It ends with one line for each thread:

   ```text
   Thread T1: fixed <short SHA>
   Thread T1: no change <reason>
   Thread T1: question <text>
   ```

5. When the turn made a new commit, the GitHub method `open-pr` pushes the branch
   to the same pull request.
6. The GitHub method `reply-thread` posts one reply to each thread with a line:
   `Fixed in <short SHA>.` or `No change is needed: <reason>`. A thread with
   `question` opens a decision with the question. The reply has the answer of the
   person. A denial, an expiry or an empty answer leaves the thread without a
   reply. The replies of `fixed` and `no change` come before the questions.
7. The `resolve` point decides if the GitHub method `resolve-thread` resolves a
   thread.
8. After a push, the GitHub method `wait-review` asks for a new Greptile review in
   the same way as in `develop`, so that a fixed finding gets a fresh score. The
   score goes in the report of the run. A review that does not come does not
   block the run.

## Rules

- Each reply goes through the same privacy check as an issue body. A reply with
  a local path, a private text, an email address, a mention or a link to an
  issue of another repository is refused, and the run ends `blocked` with the
  privacy reason.
- A `fixed` line must name a commit that the turn made. A report with no thread
  line, or with a `fixed` line for an unknown commit, blocks the run before a push
  or a reply.
- The workflow reads only the comments of bots, of the operator and of people with
  the association `OWNER`, `MEMBER` or `COLLABORATOR`. A comment of another
  person does not reach the turn and does not start a run.
- The workflow does not merge. The merge stays with `develop`, `rescue-pr` or a
  person.

## The `resolve` point

- **Resolve bot threads after a fix** (the default): the workflow resolves a
  thread of a bot after its fix is pushed. It never resolves a thread of a
  person: that person resolves it.
- **Never resolve**: the workflow replies to each thread and leaves every thread
  open.
