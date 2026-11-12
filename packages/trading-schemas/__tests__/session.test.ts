import { describe, expect, test } from "bun:test";
import {
  FLAT_PROFILE,
  type SessionSchedule,
  sessionClosedSince,
  UNSCHEDULED,
} from "../src";

// 100 ms "day": open at 20, close at 80
const s: SessionSchedule = {
  scheduled: true,
  dayMs: 100,
  openAt: 20,
  closeAt: 80,
  profile: FLAT_PROFILE,
};

describe("sessionClosedSince", () => {
  test("a close between since and now", () => {
    expect(sessionClosedSince(s, 30, 79)).toBe(false);
    expect(sessionClosedSince(s, 30, 80)).toBe(true);
    expect(sessionClosedSince(s, 30, 150)).toBe(true);
    // entered before the open: the day's close is still ahead
    expect(sessionClosedSince(s, 110, 170)).toBe(false);
    // entered after the close (closing auction): the next close counts
    expect(sessionClosedSince(s, 85, 120)).toBe(false);
    expect(sessionClosedSince(s, 85, 180)).toBe(true);
    // a whole day or more
    expect(sessionClosedSince(s, 30, 400)).toBe(true);
  });

  test("never when unscheduled or now <= since", () => {
    expect(sessionClosedSince(UNSCHEDULED, 0, 1e12)).toBe(false);
    expect(sessionClosedSince(s, 50, 50)).toBe(false);
  });
});
