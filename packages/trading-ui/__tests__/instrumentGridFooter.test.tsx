import { afterEach, describe, expect, mock, test } from "bun:test";
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
import { DEFAULT_LINK_GROUPS } from "../src";
import {
  formatRowCount,
  InstrumentGridFooter,
} from "../src/components/InstrumentGrid/InstrumentGridFooter";
import type { GridChannelLinks } from "../src/components/InstrumentGrid/linkColumn";

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

const renderFooter = (
  props: {
    filtered?: boolean;
    onShowLinked?: (ric: string) => void;
    held?: Record<string, string>;
  } = {},
) => {
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
  const held = props.held ?? { red: "BP.L", blue: "VOD.L" };
  const links = {
    channels: DEFAULT_LINK_GROUPS,
    instrumentOf: (channel: string) =>
      held[channel] ? { ric: held[channel] } : undefined,
  } as unknown as GridChannelLinks;
  render(
    <InstrumentGridFooter
      columnModel={columnModel}
      columnSetModel={columnSetModel}
      dataSource={dataSource as unknown as DataSource}
      filtered={props.filtered ?? false}
      links={links}
      onShowLinked={props.onShowLinked}
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

  test("lists linked instruments in channel order and goes to their rows", () => {
    const onShowLinked = mock();
    renderFooter({ onShowLinked });
    const items = screen.getAllByRole("button", { name: /go to its row/ });
    expect(items.map((item) => item.textContent)).toEqual(["BP.L", "VOD.L"]);
    fireEvent.click(items[1]);
    expect(onShowLinked).toHaveBeenCalledWith("VOD.L");
  });

  test("without onShowLinked the instruments are not buttons", () => {
    renderFooter();
    expect(screen.getByText("BP.L")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /go to its row/ })).toBeNull();
  });

  test("nothing linked, no Linked label", () => {
    renderFooter({ held: {} });
    expect(screen.queryByText("Linked")).toBeNull();
  });
});
