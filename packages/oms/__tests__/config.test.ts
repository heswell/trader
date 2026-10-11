import { describe, expect, test } from "bun:test";
import { DEFAULT_OMS_CONFIG, loadOmsConfig } from "../src/config";

const source = (values: Record<string, string | number>) => ({
  has: (key: string) => key in values,
  getString: (key: string) => String(values[key]),
  getNumber: (key: string) => Number(values[key]),
});

describe("loadOmsConfig", () => {
  test("defaults", () => {
    expect(loadOmsConfig(undefined, {})).toEqual({ ...DEFAULT_OMS_CONFIG });
  });

  test("application.conf then env (env wins) then overrides", () => {
    const config = loadOmsConfig(
      source({
        "oms.flowRate": 4,
        "oms.restrictedRics": "VOD.L",
        "oms.seed": 1,
      }),
      { OMS_FLOW_RATE: "0.5", OMS_PERMISSION_MODE: "strict" },
      { seed: 99 },
    );
    expect(config).toMatchObject({
      flowRate: 0.5,
      restrictedRics: "VOD.L",
      permissionMode: "strict",
      seed: 99,
    });
  });

  test("validates", () => {
    expect(() => loadOmsConfig(undefined, { OMS_FLOW_RATE: "x" })).toThrow();
    expect(() => loadOmsConfig(undefined, { OMS_COLLAR_PCT: "2" })).toThrow();
    expect(() =>
      loadOmsConfig(undefined, { OMS_PERMISSION_MODE: "open" }),
    ).toThrow();
    expect(() => loadOmsConfig(undefined, { OMS_FLOW_STEP_MS: "0" })).toThrow();
  });
});
