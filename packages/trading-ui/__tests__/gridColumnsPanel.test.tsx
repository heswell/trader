import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ColumnModel, ColumnSetModel } from "@vuu-ui/vuu-table-extras";
import { GridColumnsPanel } from "../src/components/InstrumentGrid/GridColumnsPanel";

afterEach(cleanup);

const columns = ["ric", "bid", "exchange", "sector", "pe"].map((name) => ({
  name,
}));

const renderPanel = () => {
  const columnModel = new ColumnModel(columns, columns.slice(0, 2));
  const columnSetModel = new ColumnSetModel(columnModel, {
    activeColumnSet: "Prices",
    columnSets: [
      { name: "Prices", columns: ["ric", "bid"], savedColumns: ["ric", "bid"] },
      {
        name: "Valuation",
        columns: ["ric", "pe"],
        savedColumns: ["ric", "pe"],
      },
    ],
  });
  const quick: Record<string, string[]> = {
    Prices: ["exchange"],
    Valuation: ["pe"],
  };
  const onChange = mock((columns: string[]) => {
    quick[columnSetModel.activeColumnSet?.name ?? ""] = columns;
  });
  render(
    <GridColumnsPanel
      columnModel={columnModel}
      columnSetModel={columnSetModel}
      defaultQuickFilterColumns={["exchange", "sector"]}
      getQuickFilterColumns={() =>
        quick[columnSetModel.activeColumnSet?.name ?? ""] ?? []
      }
      initialTab="quickFilters"
      onChangeQuickFilterColumns={onChange}
      quickFilterItems={columns.map(({ name }) => ({ name }))}
    />,
  );
  return { columnSetModel, onChange };
};

const inView = () =>
  (
    document.querySelector(
      ".tradingGridColumnsPanel-quickFilters",
    ) as HTMLElement
  ).textContent;

describe("GridColumnsPanel", () => {
  test("Columns and Quick filters tabs", () => {
    renderPanel();
    expect(screen.getByRole("tab", { name: "Columns" })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Quick filters" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(/The quick filters of Prices/)).toBeTruthy();
    expect(inView()).toContain("1 field in view");
  });

  test("adds a field (not a column) and resets to default", () => {
    const { onChange } = renderPanel();
    const sector = [
      ...document.querySelectorAll<HTMLElement>(
        ".tradingGridColumnsPanel-quickFilters [role=option]",
      ),
    ].find((o) => o.dataset.name === "sector") as HTMLElement;
    fireEvent.click(sector.querySelector("button") as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith(["exchange", "sector"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenLastCalledWith(["exchange", "sector"]);
  });

  test("follows the column set in view", () => {
    const { columnSetModel } = renderPanel();
    act(() => columnSetModel.setActiveColumnSet("Valuation"));
    expect(screen.getByText(/The quick filters of Valuation/)).toBeTruthy();
    expect(inView()).toContain("1 field in view");
    const pe = document.querySelector(
      '.tradingGridColumnsPanel-quickFilters [data-name="pe"]',
    );
    expect(pe?.getAttribute("role")).toBe("option");
  });
});
