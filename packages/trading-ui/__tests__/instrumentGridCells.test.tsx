import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import { ChangeCell, PhaseCell, PriceMoveCell, QuantityCell } from "../src";

afterEach(cleanup);

const props = (
  name: string,
  row: Record<string, unknown>,
  componentProps?: Record<string, string | number | boolean>,
) =>
  ({
    column: {
      name,
      type: { name: "number", renderer: { name: "x", componentProps } },
    },
    columnMap: {},
    dataRow: {
      key: "AAA.L",
      isLeaf: true,
      hasColumn: (n: string) => n in row,
      ...row,
    },
  }) as unknown as TableCellRendererProps;

describe("instrument grid cells", () => {
  test("price uses the row's decimals", () => {
    const { container } = render(
      <PriceMoveCell {...props("last", { last: 12.3, priceDecimals: 3 })} />,
    );
    expect(container.textContent).toBe("12.300");
  });

  test("change shows sign and arrow as well as colour", () => {
    const up = render(<ChangeCell {...props("change", { change: 0.5 })} />);
    expect(up.container.textContent).toContain("+0.5");
    expect(up.container.textContent).toContain("\u25B2");
    cleanup();
    const down = render(<ChangeCell {...props("change", { change: -0.5 })} />);
    expect(down.container.textContent).toContain("-0.5");
    expect(down.container.textContent).toContain("\u25BC");
  });

  test("phase is rendered as text", () => {
    const { container } = render(
      <PhaseCell {...props("phase", { phase: "HALTED" })} />,
    );
    expect(container.textContent?.toLowerCase()).toContain("halt");
  });

  test("quantity is compact on request", () => {
    const { container } = render(
      <QuantityCell
        {...props("volume", { volume: 1_200_000 }, { compact: true })}
      />,
    );
    expect(container.textContent).toBe("1.2M");
  });
});
