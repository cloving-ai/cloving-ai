export const refusalRecords = [
  { scope: "project" as const, label: "broken.ts", codes: ["compile-failed"] },
  {
    scope: "user" as const,
    label: "workflows/",
    codes: ["workflow-read-failed"],
  },
];

export const refusalText =
  "Refused workflows:\n" +
  "  project broken.ts: compile-failed\n" +
  "  user workflows/: workflow-read-failed\n";
