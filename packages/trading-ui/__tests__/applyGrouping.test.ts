import { describe, expect, test } from "bun:test";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { EventEmitter } from "@vuu-ui/vuu-utils";
import { applyGrouping } from "../src/data/applyGrouping";

/** A data source that, like the local test data, never confirms config. */
type FakeEvents = {
  config: (config: unknown, range: unknown, confirmed?: boolean) => void;
};

class FakeDataSource extends EventEmitter<FakeEvents> {
  groupBy: string[] = [];
  aggregations: unknown[] = [];
  range = { from: 0, to: 10 };
  get config() {
    return { groupBy: this.groupBy, aggregations: this.aggregations };
  }
}

const confirmedEmits = (ds: FakeDataSource) => {
  const confirmed: boolean[] = [];
  ds.on("config", (_c: unknown, _r: unknown, c?: boolean) =>
    confirmed.push(c === true),
  );
  return confirmed;
};

describe("applyGrouping", () => {
  test("ungrouping tells the Table the change is confirmed", () => {
    const ds = new FakeDataSource();
    ds.groupBy = ["ric"];
    const confirmed = confirmedEmits(ds);
    applyGrouping(ds as unknown as DataSource, [], []);
    expect(ds.groupBy).toEqual([]);
    expect(ds.aggregations).toEqual([]);
    expect(confirmed).toEqual([true]);
  });

  test("grouping, or staying ungrouped, emits nothing extra", () => {
    const ds = new FakeDataSource();
    const confirmed = confirmedEmits(ds);
    applyGrouping(ds as unknown as DataSource, [], []);
    applyGrouping(
      ds as unknown as DataSource,
      ["ric"],
      [{ column: "quantity", aggType: 1 }],
    );
    expect(ds.groupBy).toEqual(["ric"]);
    expect(confirmed).toEqual([]);
  });
});
