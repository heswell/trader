import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  notificationLease,
  TradingFeatureRoot,
  useInTradingFeatureRoot,
  useOrderTicketLauncher,
} from "../src";

afterEach(cleanup);

describe("notificationLease", () => {
  test("one holder per window; passes to the oldest waiter on release", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    const c = Symbol("c");
    const releaseA = notificationLease.acquire(a);
    const releaseB = notificationLease.acquire(b);
    const releaseC = notificationLease.acquire(c);
    expect(notificationLease.holder()).toBe(a);
    releaseB();
    releaseA();
    expect(notificationLease.holder()).toBe(c);
    releaseC();
    expect(notificationLease.holder()).toBeUndefined();
  });
});

describe("TradingFeatureRoot", () => {
  const Probe = ({ testId }: { testId: string }) => {
    const inRoot = useInTradingFeatureRoot();
    const { available } = useOrderTicketLauncher();
    return <span data-testid={testId}>{`${inRoot}:${available}`}</span>;
  };

  test("provides the launcher; a nested root renders children only", () => {
    const { getByTestId, container } = render(
      <TradingFeatureRoot connectionBanner={false}>
        <Probe testId="outer" />
        <TradingFeatureRoot>
          <Probe testId="inner" />
        </TradingFeatureRoot>
      </TradingFeatureRoot>,
    );
    expect(getByTestId("outer").textContent).toBe("true:true");
    expect(getByTestId("inner").textContent).toBe("true:true");
    // the nested root added no ConnectionBanner of its own
    expect(container.querySelectorAll(".tradingConnectionBanner")).toHaveLength(
      0,
    );
  });

  test("sibling roots share one notification lease", () => {
    const first = render(
      <TradingFeatureRoot connectionBanner={false}>
        <div />
      </TradingFeatureRoot>,
    );
    const holder = notificationLease.holder();
    expect(holder).toBeDefined();
    const second = render(
      <TradingFeatureRoot connectionBanner={false}>
        <div />
      </TradingFeatureRoot>,
    );
    expect(notificationLease.holder()).toBe(holder);
    first.unmount();
    const next = notificationLease.holder();
    expect(next).toBeDefined();
    expect(next).not.toBe(holder);
    second.unmount();
    expect(notificationLease.holder()).toBeUndefined();
  });
});
