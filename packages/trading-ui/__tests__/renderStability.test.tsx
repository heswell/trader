/**
 * Render-stability guards for the Phase 5 performance fixes (see
 * docs/performance.md). They run in CI (happy-dom) in place of the opt-in
 * Chrome frame-budget check: per-tick depth / price updates must not
 * re-render the ladder toolbar or link-group selectors.
 *
 * React stores the latest props of a host element on the DOM node
 * (`__reactProps$…`); the object only changes when the element is
 * re-rendered, so an unchanged reference means the subtree bailed out.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { tickScheduleOf } from "@heswell/trading-schemas";
import { cleanup, render, screen } from "@testing-library/react";
import { LinkGroupSelector, PriceLadderView } from "../src";

afterEach(cleanup);

const reactProps = (el: Element | null) => {
  if (!el) throw new Error("element not found");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!key) throw new Error("no React props on element");
  return (el as unknown as Record<string, unknown>)[key];
};

const schedule = tickScheduleOf({ tickSize: 0.5 });
const book = (shift: number) => ({
  bids: [
    { price: 100, size: 500 + shift },
    { price: 99.5, size: 1_200 + shift },
  ],
  asks: [
    { price: 101, size: 400 + shift },
    { price: 101.5, size: 900 + shift },
  ],
});

describe("render stability", () => {
  test("PriceLadderView: depth updates do not re-render the toolbar", () => {
    const start = <span data-testid="start" />;
    const ladder = (shift: number) => (
      <PriceLadderView
        ric="TEST.L"
        tickSchedule={schedule}
        {...book(shift)}
        last={100}
        rowCount={11}
        toolbarStart={start}
      />
    );
    const { container, rerender } = render(ladder(0));
    const toolbar = container.querySelector(".tradingPriceLadder-toolbar");
    const before = reactProps(toolbar);
    for (let i = 1; i <= 5; i++) rerender(ladder(i * 10));
    // the ladder itself did update
    expect(screen.getByRole("grid").textContent).toContain("1,250");
    expect(reactProps(toolbar)).toBe(before);
  });

  test("LinkGroupSelector: a parent re-render with equal props is skipped", () => {
    const onChange = mock();
    const header = (tick: number) => (
      <div data-tick={tick}>
        <LinkGroupSelector value="unlinked" onChange={onChange} />
      </div>
    );
    const { container, rerender } = render(header(0));
    const selector = container.querySelector(".tradingLinkGroupSelector");
    const before = reactProps(selector);
    for (let i = 1; i <= 5; i++) rerender(header(i));
    expect(container.querySelector("[data-tick='5']")).toBeTruthy();
    expect(reactProps(selector)).toBe(before);
  });
});
