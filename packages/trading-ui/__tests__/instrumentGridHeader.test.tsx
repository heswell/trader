import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_VIEW_SETTINGS, parseViewSettings } from "../src";
import {
  ALL_INSTRUMENTS,
  filterClauseCount,
  InstrumentGridHeader,
  type InstrumentGridHeaderProps,
} from "../src/components/InstrumentGrid/InstrumentGridHeader";

afterEach(cleanup);

describe("view settings", () => {
  test("parses saved settings, defaulting missing or bad fields", () => {
    expect(parseViewSettings('{"filterBar":false,"footer":false}')).toEqual({
      filterBar: false,
      footer: false,
    });
    expect(parseViewSettings('{"footer":"no"}')).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(parseViewSettings("not json")).toBeUndefined();
    expect(parseViewSettings(null)).toBeUndefined();
  });
});

describe("filterClauseCount", () => {
  test("counts the parts of an and, else one", () => {
    expect(filterClauseCount(undefined)).toBe(0);
    expect(filterClauseCount({ op: "=" })).toBe(1);
    expect(filterClauseCount({ op: "or", filters: [{}, {}] })).toBe(1);
    expect(filterClauseCount({ op: "and", filters: [{}, {}, {}] })).toBe(3);
  });
});

const renderHeader = (props: Partial<InstrumentGridHeaderProps> = {}) => {
  const handlers = {
    onAddToWatchlist: mock(),
    onDeleteWatchlist: mock(),
    onNewWatchlist: mock(),
    onRemoveFromWatchlist: mock(),
    onScopeChange: mock(),
    onShowFilterBarChange: mock(),
    onShowFooterChange: mock(),
  };
  render(
    <InstrumentGridHeader
      filterCount={0}
      scope={ALL_INSTRUMENTS}
      showFilterBar
      showFooter
      watchlists={[{ id: "w1", name: "Banks", rics: ["BARC.L", "HSBA.L"] }]}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
};

describe("InstrumentGridHeader", () => {
  test("the scope picker switches to a watchlist and acts on it", async () => {
    const h = renderHeader({ scope: "w1", selectedRic: "BP.L" });
    fireEvent.click(screen.getByRole("button", { name: "Instruments: Banks" }));
    expect(await screen.findByText("2")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add BP.L to Banks" }),
    );
    expect(h.onAddToWatchlist).toHaveBeenCalledWith("w1", "BP.L");

    fireEvent.click(screen.getByRole("button", { name: "Instruments: Banks" }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /All instruments/ }),
    );
    expect(h.onScopeChange).toHaveBeenCalledWith(ALL_INSTRUMENTS);
  });

  test("the gear toggles the filter bar and footer", async () => {
    const h = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Panel settings" }));
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: /Show filter bar/ }),
    );
    expect(h.onShowFilterBarChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Panel settings" }));
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: /Show footer/ }),
    );
    expect(h.onShowFooterChange).toHaveBeenCalledWith(false);
  });

  test("a badge shows applied filters while the bar is hidden", () => {
    const h = renderHeader({ filterCount: 2, showFilterBar: false });
    fireEvent.click(
      screen.getByRole("button", {
        name: "2 filters applied, show the filter bar",
      }),
    );
    expect(h.onShowFilterBarChange).toHaveBeenCalledWith(true);
  });

  test("no badge while the bar shows", () => {
    renderHeader({ filterCount: 2 });
    expect(
      screen.queryByRole("button", { name: /filters applied/ }),
    ).toBeNull();
  });
});
