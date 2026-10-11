import { afterEach, describe, expect, test } from "bun:test";
import { Side } from "@heswell/trading-schemas";
import { cleanup, render, screen } from "@testing-library/react";
import { SideLabel } from "../src";

afterEach(cleanup);

describe("SideLabel", () => {
  test("renders the side with a data attribute and modifier class", () => {
    render(<SideLabel side={Side.Buy} variant="pill" />);
    const label = screen.getByText("Buy");
    expect(label.dataset.side).toBe("BUY");
    expect(label.className).toBe(
      "tradingSideLabel tradingSideLabel-buy tradingSideLabel-pill",
    );
  });

  test("injects its stylesheet once", () => {
    render(
      <>
        <SideLabel side={Side.Buy} />
        <SideLabel side={Side.Sell} />
      </>,
    );
    const styles = document.head.querySelectorAll(
      'style[data-salt-style="trading-side-label"]',
    );
    expect(styles.length).toBe(1);
    expect(styles[0].textContent).toContain(".tradingSideLabel-sell");
  });
});
