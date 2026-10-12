import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  DataSource,
  DataSourceCallbackMessage,
  DataSourceRow,
  DataSourceSubscribeProps,
} from "@vuu-ui/vuu-data-types";
import { metadataKeys } from "@vuu-ui/vuu-utils";
import {
  type DataSourceRowsUpdate,
  subscribeTradingRows,
  useDataSourceRows,
} from "../src";

afterEach(cleanup);

const COLUMNS = ["ric", "bid"];

const row = (index: number, ric: string, bid: number): DataSourceRow => {
  const r: unknown[] = new Array(metadataKeys.count).fill(0);
  r[metadataKeys.IDX] = index;
  r[metadataKeys.KEY] = ric;
  r[metadataKeys.IS_LEAF] = true;
  r[metadataKeys.DEPTH] = 0;
  return [...r, ric, bid] as unknown as DataSourceRow;
};

/** The parts of a DataSource subscribeTradingRows uses. */
const fakeDataSource = () => {
  let callback: ((m: DataSourceCallbackMessage) => void) | undefined;
  const subscriptions: DataSourceSubscribeProps[] = [];
  let unsubscribed = 0;
  const ds = {
    columns: COLUMNS,
    subscribe: (
      props: DataSourceSubscribeProps,
      cb: (m: DataSourceCallbackMessage) => void,
    ) => {
      subscriptions.push(props);
      callback = cb;
    },
    unsubscribe: () => {
      unsubscribed += 1;
    },
  } as unknown as DataSource;
  return {
    ds,
    subscriptions,
    unsubscribed: () => unsubscribed,
    send: (rows: DataSourceRow[], size?: number) =>
      callback?.({
        type: "viewport-update",
        rows,
        size,
        clientViewportId: "vp",
      } as DataSourceCallbackMessage),
    clear: () =>
      callback?.({
        type: "viewport-clear",
        clientViewportId: "vp",
      } as DataSourceCallbackMessage),
  };
};

describe("subscribeTradingRows", () => {
  test("delivers rows as objects within the range; tracks size and clear", () => {
    const fake = fakeDataSource();
    const updates: DataSourceRowsUpdate[] = [];
    const off = subscribeTradingRows(
      fake.ds,
      { rowCount: 2, filter: 'ric = "A"' },
      (u) => updates.push(u),
    );
    expect(fake.subscriptions[0].filterSpec).toEqual({ filter: 'ric = "A"' });
    fake.send([row(0, "A", 1), row(1, "B", 2), row(2, "C", 3)], 3);
    expect(updates[0].loaded).toBe(true);
    expect(updates[0].size).toBe(3);
    expect(updates[0].rows.map((r) => r.ric)).toEqual(["A", "B"]);
    expect(updates[0].rows[0]).toMatchObject({
      $key: "A",
      $index: 0,
      bid: 1,
    });

    fake.send([row(1, "B", 5)]);
    expect(updates[1].updated.map((r) => r.bid)).toEqual([5]);
    expect(updates[1].messageSize).toBeUndefined();
    expect(updates[1].rows.map((r) => r.bid)).toEqual([1, 5]);

    // shrinking drops rows past the end
    fake.send([], 1);
    expect(updates[2].rows.map((r) => r.ric)).toEqual(["A"]);

    fake.clear();
    expect(updates[3]).toMatchObject({ cleared: true, size: 0 });
    expect(updates[3].rows).toEqual([]);

    off();
    expect(fake.unsubscribed()).toBe(1);
    fake.send([row(0, "A", 1)], 1);
    expect(updates).toHaveLength(4);
  });

  test("leaves the data source's own filter alone when none is given", () => {
    const fake = fakeDataSource();
    subscribeTradingRows(fake.ds, {}, () => undefined);
    expect("filterSpec" in fake.subscriptions[0]).toBe(false);
    expect(fake.subscriptions[0].range).toMatchObject({ from: 0, to: 100 });
  });
});

describe("useDataSourceRows", () => {
  test("renders rows, resubscribes with rows cleared on filter change", () => {
    const fake = fakeDataSource();
    const { result, rerender, unmount } = renderHook(
      ({ filter }: { filter: string }) =>
        useDataSourceRows(fake.ds, { filter, throttle: "none" }),
      { initialProps: { filter: "a" } },
    );
    expect(result.current.loaded).toBe(false);
    act(() => fake.send([row(0, "A", 1)], 1));
    expect(result.current.rows.map((r) => r.ric)).toEqual(["A"]);
    expect(result.current.version).toBe(1);

    rerender({ filter: "b" });
    expect(result.current.rows).toEqual([]);
    expect(fake.unsubscribed()).toBe(1);
    expect(fake.subscriptions).toHaveLength(2);

    unmount();
    expect(fake.unsubscribed()).toBe(2);
  });

  test("frame throttle coalesces bursts into one render", async () => {
    const fake = fakeDataSource();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDataSourceRows(fake.ds);
    });
    const before = renders;
    act(() => {
      for (let i = 0; i < 10; i++) fake.send([row(0, "A", i)], 1);
    });
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(result.current.rows[0].bid).toBe(9);
    expect(renders - before).toBe(1);
  });

  test("not subscribed while disabled", () => {
    const fake = fakeDataSource();
    renderHook(() => useDataSourceRows(fake.ds, { enabled: false }));
    expect(fake.subscriptions).toHaveLength(0);
  });
});
