import { describe, expect, test } from "bun:test";
import {
  canSeeAccount,
  resolveAccess,
  TradingRole,
} from "../src/permissions/access";
import { SEED_ACCOUNTS } from "../src/reference/accounts";

const access = (name: string, roles: string[] = [], mode?: "auto" | "strict") =>
  resolveAccess({ name, authorizations: roles }, SEED_ACCOUNTS, mode);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("access", () => {
  test("trader with view sees own accounts but cannot trade", () => {
    const a = access("erin", [TradingRole.View]);
    expect(a).toMatchObject({ all: false, canExecute: false, basis: "trader" });
    expect(sorted(a.accounts)).toEqual([
      "ACC-ASIA-01",
      "ACC-ASIA-02",
      "ACC-ASIA-03",
    ]);
    expect(canSeeAccount(a, "ACC-US-01")).toBe(false);
  });

  test("execute implies view of own accounts", () => {
    const a = access("alice", [TradingRole.Execute]);
    expect(a.canExecute).toBe(true);
    expect(sorted(a.accounts)).toEqual(["ACC-US-01"]);
  });

  test("supervisor sees own desks, or all when owning no account", () => {
    const desk = access("bob", [TradingRole.Supervisor]);
    expect(sorted(desk.accounts)).toEqual(["ACC-US-01", "ACC-US-02"]);
    expect(desk.canExecute).toBe(false);
    const all = access("sam", [TradingRole.Supervisor, TradingRole.Execute]);
    expect(all).toMatchObject({ all: true, canExecute: true });
    expect(canSeeAccount(all, "ANY")).toBe(true);
  });

  test("no trading roles: auto mode dev defaults, strict denies", () => {
    expect(access("carol")).toMatchObject({ basis: "dev", canExecute: true });
    expect(sorted(access("carol").accounts)).toEqual(["ACC-EU-01"]);
    expect(access("someone")).toMatchObject({ all: true, canExecute: true });
    const strict = access("someone", [], "strict");
    expect(strict).toMatchObject({
      all: false,
      canExecute: false,
      basis: "none",
    });
    expect(canSeeAccount(strict, "ACC-US-01")).toBe(false);
    // unrelated roles do not count as trading roles
    expect(access("carol", ["vuu-admin"]).basis).toBe("dev");
  });
});
