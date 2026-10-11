import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import {
  InstrumentContextProvider,
  type InstrumentSelection,
  type SelectedInstrument,
  useSelectedInstrument,
} from "../src";

afterEach(cleanup);

let select: (i: SelectedInstrument | undefined, source?: string) => void;
const Consumer = () => {
  const { selectedInstrument, selectionSource, setSelectedInstrument } =
    useSelectedInstrument();
  useEffect(() => {
    select = setSelectedInstrument;
  }, [setSelectedInstrument]);
  return (
    <span data-testid="selected">
      {selectedInstrument?.ric ?? "none"}:{selectionSource ?? ""}
    </span>
  );
};

describe("instrument context", () => {
  test("shares the selection between consumers", () => {
    const changes: InstrumentSelection[] = [];
    render(
      <InstrumentContextProvider
        initialInstrument={{ ric: "AAPL.OQ" }}
        onSelectionChange={(s) => changes.push(s)}
      >
        <Consumer />
      </InstrumentContextProvider>,
    );
    expect(screen.getByTestId("selected").textContent).toBe("AAPL.OQ:");
    act(() => select({ ric: "VOD.L", tickSize: 0.02 }, "grid"));
    expect(screen.getByTestId("selected").textContent).toBe("VOD.L:grid");
    expect(changes).toEqual([
      { instrument: { ric: "VOD.L", tickSize: 0.02 }, source: "grid" },
    ]);
  });

  test("without a provider the selection is empty and setting is a no-op", () => {
    render(<Consumer />);
    act(() => select({ ric: "VOD.L" }));
    expect(screen.getByTestId("selected").textContent).toBe("none:");
  });
});
