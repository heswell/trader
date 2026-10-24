import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { VuuServerDescriptor } from "@vuu-ui/core";
import { traderConnections } from "../src/nav/TraderNav";
import { findTradingServer } from "../src/nav/TradingNavFeed";
import {
  formatCompactSigned,
  pnlDirection,
  renderTradingNavBadge,
} from "../src/nav/tradingNavBadges";

describe("nav badges", () => {
  test("formatCompactSigned", () => {
    expect(formatCompactSigned(0)).toBe("0");
    expect(formatCompactSigned(0.4)).toBe("0");
    expect(formatCompactSigned(-0.4)).toBe("0");
    expect(formatCompactSigned(42.6)).toBe("+43");
    expect(formatCompactSigned(-980)).toBe("\u2212980");
    expect(formatCompactSigned(12_345)).toBe("+12.3k");
    expect(formatCompactSigned(-1_000)).toBe("\u22121k");
    expect(formatCompactSigned(250_400)).toBe("+250k");
    expect(formatCompactSigned(-3_456_789)).toBe("\u22123.5M");
    expect(formatCompactSigned(2.1e9)).toBe("+2.1B");
  });

  test("pnlDirection", () => {
    expect(pnlDirection(10)).toBe("up");
    expect(pnlDirection(-10)).toBe("down");
    expect(pnlDirection(0.2)).toBe("flat");
  });

  test("orders.working is a number (PortalNav renders a count / rail pip)", () => {
    expect(renderTradingNavBadge("orders.working", {})).toBeUndefined();
    expect(
      renderTradingNavBadge("orders.working", { "orders.working": 0 }),
    ).toBe(0);
    expect(
      renderTradingNavBadge("orders.working", { "orders.working": 7 }),
    ).toBe(7);
  });

  test("positions.dayPnl is a signed, coloured compact value", () => {
    expect(renderTradingNavBadge("positions.dayPnl", {})).toBeUndefined();
    const { container } = render(
      <>
        {renderTradingNavBadge("positions.dayPnl", {
          "positions.dayPnl": -12_345,
        })}
        {renderTradingNavBadge("positions.dayPnl", {
          "positions.dayPnl": 980,
        })}
      </>,
    );
    const [down, up] = container.querySelectorAll(".traderNavPnl");
    expect(down.textContent).toBe("\u221212.3k");
    expect(down.classList).toContain("traderNavPnl-down");
    expect(up.textContent).toBe("+980");
    expect(up.classList).toContain("traderNavPnl-up");
  });

  test("unknown or missing badge keys render nothing", () => {
    expect(
      renderTradingNavBadge(undefined, { "orders.working": 1 }),
    ).toBeUndefined();
    expect(
      renderTradingNavBadge("other", { "orders.working": 1 }),
    ).toBeUndefined();
  });
});

describe("trading connection", () => {
  const server = (connectionId: string, url = connectionId) =>
    ({
      connectionId,
      moduleTitles: [],
      restUrl: `https://${url}/api/authn`,
      websocketUrl: `wss://${url}/ws`,
    }) as VuuServerDescriptor;

  test("prefers the trading connection id, else the first non-portal server", () => {
    expect(
      findTradingServer([server("portal"), server("trading")], "portal"),
    ).toEqual({
      connectionId: "trading",
      restUrl: "https://trading/api/authn",
      websocketUrl: "wss://trading/ws",
    });
    expect(
      findTradingServer([server("portal"), server("oms")], "portal")
        ?.connectionId,
    ).toBe("oms");
    expect(findTradingServer([server("portal")], "portal")).toBeUndefined();
  });

  test("footer connection labels", () => {
    expect(traderConnections("portal", "oms")).toEqual([
      {
        connectionId: "portal",
        label: "Portal",
        impact:
          "Trading unaffected; layout and settings changes are kept locally until it reconnects",
      },
      {
        connectionId: "oms",
        label: "Trading",
        impact: "Market data is stale and order entry is blocked",
      },
    ]);
  });
});
