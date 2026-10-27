# Cursor Agent stream fixtures

The completed fixture follows the event shapes in the [Cursor Agent output reference](https://cursor.com/docs/cli/reference/output-format): initialization, assistant messages, a tool result and a terminal success. It models the count-free format observed in version 2026.01.28; it is a constructed fixture, not a live CLI capture. The final assistant report differs from the aggregate terminal text.

The other three fixtures are negative variations of that sequence: an error event followed by apparent success, an interrupted stream without a terminal result, and an explicit failed result. The fake process exits zero for all three. The documentation describes interrupted failures but does not define an error-event payload or failed-result schema; these variations test defensive handling and do not claim a documented wire guarantee for those fields.

Newer count tests follow Cursor's public [headless usage fields](https://forum.cursor.com/t/cost-information-in-cursor-cli-headless-mode/164583/7) and [cache semantics](https://forum.cursor.com/t/discrepancies-between-cursor-cli-usage-and-billing/164471/7). They cover terminal camel-case counts with uncached input, separate cache reads and writes, and whole-turn totals. Counts from other shapes or assistant messages are not inferred. Cache writes cannot be priced by the current three-rate table.
