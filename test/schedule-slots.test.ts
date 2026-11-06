import assert from "node:assert/strict";
import { test } from "node:test";
import { localStamp, nextCalendarSlot } from "../src/daemon/schedule-slots.ts";

const daily = { at: "07:00", timeZone: "America/Los_Angeles" };

await test("CLV-314 a daily slot runs at the local time that day and then the next day", () => {
  const now = Date.parse("2026-11-10T06:00:00-08:00");
  const first = nextCalendarSlot(daily, now);
  assert.equal(first, Date.parse("2026-11-10T07:00:00-08:00"));
  assert.equal(
    nextCalendarSlot(daily, first),
    Date.parse("2026-11-11T07:00:00-08:00"),
  );
});

await test("CLV-314 a weekday slot skips other days and runs on the next named day", () => {
  const mondays = { ...daily, weekdays: ["monday" as const] };
  const tuesday = Date.parse("2026-11-10T06:00:00-08:00");
  const monday = Date.parse("2026-11-16T07:00:00-08:00");
  assert.equal(nextCalendarSlot(mondays, tuesday), monday);
  assert.equal(
    nextCalendarSlot(mondays, monday),
    Date.parse("2026-11-23T07:00:00-08:00"),
  );
  assert.equal(
    nextCalendarSlot(
      { ...daily, weekdays: ["wednesday", "friday"] as const },
      Date.parse("2026-11-11T07:00:00-08:00"),
    ),
    Date.parse("2026-11-13T07:00:00-08:00"),
  );
});

await test("CLV-314 a local time in the skipped hour runs at the first minute after the gap", () => {
  const night = { at: "02:30", timeZone: "America/Los_Angeles" };
  const slot = nextCalendarSlot(night, Date.parse("2027-03-13T03:00:00-08:00"));
  assert.equal(slot, Date.parse("2027-03-14T03:00:00-07:00"));
  assert.equal(
    nextCalendarSlot(night, slot),
    Date.parse("2027-03-15T02:30:00-07:00"),
  );
});

await test("CLV-314 a local time in the repeated hour runs once at its first occurrence", () => {
  const repeated = { at: "01:30", timeZone: "America/Los_Angeles" };
  const slot = nextCalendarSlot(
    repeated,
    Date.parse("2026-10-31T03:00:00-07:00"),
  );
  assert.equal(slot, Date.parse("2026-11-01T01:30:00-07:00"));
  assert.equal(
    nextCalendarSlot(repeated, slot),
    Date.parse("2026-11-02T01:30:00-08:00"),
  );
  assert.equal(
    nextCalendarSlot(repeated, Date.parse("2026-11-01T01:45:00-08:00")),
    Date.parse("2026-11-02T01:30:00-08:00"),
  );
  const night = { at: "02:30", timeZone: "America/Los_Angeles" };
  const once = nextCalendarSlot(night, Date.parse("2026-10-31T03:00:00-07:00"));
  assert.equal(once, Date.parse("2026-11-01T02:30:00-08:00"));
  assert.equal(
    nextCalendarSlot(night, once),
    Date.parse("2026-11-02T02:30:00-08:00"),
  );
});

await test("CLV-314 a local stamp shows the wall time and the offset of the zone", () => {
  const instant = Date.parse("2026-11-16T15:00:00Z");
  assert.equal(
    localStamp("America/Los_Angeles", instant),
    "2026-11-16T07:00:00-08:00",
  );
  assert.equal(localStamp("UTC", instant), "2026-11-16T15:00:00+00:00");
  assert.equal(
    localStamp("Asia/Kolkata", instant),
    "2026-11-16T20:30:00+05:30",
  );
});
