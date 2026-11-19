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
import {
  type ColumnSetScopeProps,
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

const renderFooter = (
  props: { filtered?: boolean; scope?: ColumnSetScopeProps } = {},
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
  render(
    <InstrumentGridFooter
      columnModel={columnModel}
      columnSetModel={columnSetModel}
      dataSource={dataSource as unknown as DataSource}
      filtered={props.filtered ?? false}
      scope={props.scope}
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

  test("+ names a new column set in a prompt, refusing duplicates", () => {
    const { columnSetModel } = renderFooter();
    fireEvent.click(screen.getByRole("button", { name: "New column set" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    const create = screen.getByRole("button", {
      name: "Create",
    }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "prices" } });
    expect(
      screen.getByText("A column set with this name already exists"),
    ).toBeTruthy();
    expect(create.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Spreads" } });
    fireEvent.click(create);
    expect(columnSetModel.columnSets.map(({ name }) => name)).toEqual([
      "Prices",
      "Valuation",
      "Spreads",
    ]);
    expect(columnSetModel.activeColumnSet?.name).toBe("Spreads");
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  const scope = (): ColumnSetScopeProps => ({
    label: "Banks",
    onCreate: mock(),
    onDelete: mock(),
    onDuplicate: mock(),
    onShare: mock(),
    sets: { scoped: ["Valuation"], shared: ["Prices"] },
  });

  test("sets only in the scope come after a divider, pinned", () => {
    renderFooter({ scope: scope() });
    const valuation = screen.getByRole("tab", { name: "Valuation" });
    expect(valuation.getAttribute("title")).toBe(
      "Valuation: only in Banks (Alt+2)",
    );
    expect(
      valuation.classList.contains("tradingInstrumentGridFooter-tabScoped"),
    ).toBe(true);
    expect(
      document.querySelector(".tradingInstrumentGridFooter-tabDivider"),
    ).toBeTruthy();
  });

  test("a set's tab menu (Shift+F10) shares, duplicates, renames and deletes", async () => {
    const s = scope();
    const { columnSetModel } = renderFooter({ scope: s });
    const openMenu = (name: string) =>
      fireEvent.keyDown(screen.getByRole("tab", { name }), {
        key: "F10",
        shiftKey: true,
      });
    openMenu("Valuation");
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Share with all watchlists",
      }),
    );
    expect(s.onShare).toHaveBeenCalledWith("Valuation", false);
    openMenu("Prices");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Only in Banks" }),
    );
    expect(s.onShare).toHaveBeenCalledWith("Prices", true);
    openMenu("Prices");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(s.onDuplicate).toHaveBeenCalledWith("Prices");

    openMenu("Prices");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "Quotes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(columnSetModel.columnSets.map(({ name }) => name)).toEqual([
      "Quotes",
      "Valuation",
    ]);

    openMenu("Valuation");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(s.onDelete).toHaveBeenCalledWith("Valuation");
  });

  test("a new set can be kept to the scope", () => {
    const s = scope();
    renderFooter({ scope: s });
    fireEvent.click(screen.getByRole("button", { name: "New column set" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Spreads" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Only Banks" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(s.onCreate).toHaveBeenCalledWith("Spreads", true);
  });
});
