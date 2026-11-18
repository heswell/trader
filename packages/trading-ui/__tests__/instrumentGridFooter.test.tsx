import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { ColumnModel, ColumnSetModel } from "@vuu-ui/vuu-table-extras";
import { EventEmitter } from "@vuu-ui/vuu-utils";
import {
  formatRowCount,
  InstrumentGridFooter,
} from "../src/components/InstrumentGrid/InstrumentGridFooter";

afterEach(cleanup);

class FakeDataSource extends EventEmitter<{ resize: (size: number) => void }> {
  size = 349;
  resize(size: number) {
    this.size = size;
    this.emit("resize", size);
  }
}

const columns = ["ric", "description", "bid", "ask", "pe"].map((name) => ({
  name,
}));

const renderFooter = (props: { filtered?: boolean } = {}) => {
  const dataSource = new FakeDataSource();
  const columnModel = new ColumnModel(columns, columns.slice(0, 3));
  const columnSetModel = new ColumnSetModel(columnModel, {
    activeColumnSet: "Prices",
    columnSets: [
      {
        name: "Prices",
        columns: ["ric", "description", "bid"],
        savedColumns: ["ric", "description", "bid"],
      },
      {
        name: "Valuation",
        columns: ["ric", "pe"],
        savedColumns: ["ric", "pe"],
      },
    ],
  });
  render(
    <InstrumentGridFooter
      columnModel={columnModel}
      columnSetModel={columnSetModel}
      dataSource={dataSource as unknown as DataSource}
      filtered={props.filtered ?? false}
    />,
  );
  return { columnSetModel, dataSource };
};

describe("formatRowCount", () => {
  test("one row, many rows", () => {
    expect(formatRowCount(1)).toBe("1 row");
    expect(formatRowCount(0)).toBe("0 rows");
    expect(formatRowCount(12345)).toBe(`${(12345).toLocaleString()} rows`);
  });
});

describe("InstrumentGridFooter", () => {
  test("the count follows the data source, never 'x of y'", () => {
    const { dataSource } = renderFooter({ filtered: true });
    expect(screen.getByText("349 rows")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filtered" })).toBeTruthy();
    act(() => dataSource.resize(2));
    expect(screen.getByText("2 rows")).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
  });

  test("no filter icon while unfiltered", () => {
    renderFooter();
    expect(screen.queryByRole("img", { name: "Filtered" })).toBeNull();
  });

  test("column-set tabs switch the set in view", () => {
    const { columnSetModel } = renderFooter();
    const prices = screen.getByRole("tab", { name: "Prices" });
    expect(prices.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Valuation" }));
    expect(columnSetModel.activeColumnSet?.name).toBe("Valuation");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Valuation" }), {
      key: "ArrowRight",
    });
    expect(columnSetModel.activeColumnSet?.name).toBe("Prices");
  });
});
