export const reviewRules = [
  "Real changes only: a problem must be marked outside its 7-day band or stay on one side of the median for 3 days or more. A value inside the band gets no proposal. Unavailable or short history is not zero or evidence of a problem.",
  "One constraint: name the one step that limits throughput most, with its share of wait time or lost runs. Address that step first; use it better before adding capacity.",
  "Paired metrics: read merged tickets with reverted or reopened work and main CI failures; busy lanes with flaky failures and fix rounds; faster CI with escaped faults. Never improve a value at the cost of its quality pair.",
  "Evidence: each problem needs 2 or more occurrences in the window or a trend over 7 days, with links to runs, pull requests or CI jobs derived from the facts. Put a single event on the watch list. Remove claims without evidence; never invent values, links or trends.",
  "At most 3 proposals. Each text contains the problem and evidence, a hypothesis, one change and its expected effect, a metric and a check date 3 to 7 days later, cost, how to reverse it and the result that shows failure. Prefer small reversible changes.",
  "One change for each loop at a time: no proposal for a loop with an open improvement. If an open improvement's loop is unknown, propose no changes until it is identified.",
  "Keep what works: list what went well and must not break.",
  "Utilization: never propose keeping lanes, CI runners or the host busy above about 80% of the time.",
  "The system, not a person: describe the system condition that allowed the problem; do not blame individuals.",
  "Improvements in progress: for every open improvement compare its metric before and after the change, and at its check date give the verdict keep, reverse or continue with evidence. Unknown measurements mean continue, never a fabricated success.",
];
