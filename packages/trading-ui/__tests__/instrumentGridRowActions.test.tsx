import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import {
  actionsColumnDescriptor,
  type RowActionHandlers,
  RowActionsCell,
  RowActionsProvider,
  rowActionOfKey,
} from "../src/components/InstrumentGrid/rowActions";

afterEach(cleanup);

describe("rowActionOfKey", () => {
  test("B / S / D in either case, nothing else", () => {
    expect(rowActionOfKey("b")).toBe("buy");
    expect(rowActionOfKey("S")).toBe("sell");
    expect(rowActionOfKey("d")).toBe("depth");
    expect(rowActionOfKey("x")).toBeUndefined();
    expect(rowActionOfKey("Enter")).toBeUndefined();
  });
});

describe("actions column", () => {
  test("is client-side, pinned right and narrow", () => {
    expect(actionsColumnDescriptor.source).toBe("client");
    expect(actionsColumnDescriptor.pin).toBe("right");
    expect(actionsColumnDescriptor.width).toBeLessThanOrEqual(8);
  });
});

const renderCell = (
  handlers: RowActionHandlers,
  dataRow: Record<string, unknown> = {
    ric: "BP.L",
    description: "BP plc",
  },
) => {
  const onRowClick = mock();
  render(
    <RowActionsProvider value={handlers}>
      {/* selected, so the buttons show */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: test of propagation */}
      {/* biome-ignore lint/a11y/useSemanticElements: a vuu Table row is a div */}
      <div
        aria-selected="true"
        className="vuuTableRow"
        onClick={onRowClick}
        role="row"
        tabIndex={-1}
      >
        <RowActionsCell
          {...({
            column: { name: "actions" },
            dataRow,
          } as unknown as TableCellRendererProps)}
        />
      </div>
    </RowActionsProvider>,
  );
  return onRowClick;
};

describe("RowActionsCell", () => {
  test("a button per handler, called with the row's instrument", () => {
    const buy = mock();
    const depth = mock();
    const onRowClick = renderCell({ buy, depth });
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Buy BP.L", "Depth BP.L"]);

    fireEvent.click(screen.getByRole("button", { name: "Buy BP.L" }));
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy.mock.calls[0][0]).toMatchObject({
      ric: "BP.L",
      description: "BP plc",
    });
    // not a row click (selection)
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("buttons show their keys", () => {
    renderCell({ sell: mock() });
    expect(screen.getByRole("button", { name: "Sell BP.L" }).title).toBe(
      "Sell (S)",
    );
  });

  test("no buttons on group rows or without handlers", () => {
    renderCell({ buy: mock() }, { ric: "BP.L", isLeaf: false });
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    renderCell({});
    expect(screen.queryByRole("button")).toBeNull();
  });
});
