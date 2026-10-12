import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  LAST_ACCOUNT_STORAGE_KEY,
  TradingDataProvider,
  useSelectedAccount,
} from "../src";
import {
  OrderActionsCell,
  OrderBlotterContext,
} from "../src/components/OrderBlotter/OrderBlotterContext";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 5,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "account-selector");

afterEach(() => {
  cleanup();
  localStorage.removeItem(LAST_ACCOUNT_STORAGE_KEY);
});
afterAll(() => testData.dispose());

type Selected = ReturnType<typeof useSelectedAccount>;

const Probe = ({ onState }: { onState: (s: Selected) => void }) => {
  onState(useSelectedAccount());
  return null;
};

const renderProbe = () => {
  let latest: Selected = [undefined, () => undefined, []];
  render(
    <TradingDataProvider mode="local" localServer={localServer}>
      <Probe
        onState={(s) => {
          latest = s;
        }}
      />
    </TradingDataProvider>,
  );
  return () => latest;
};

describe("useSelectedAccount", () => {
  test("defaults to the ticket's last account, then follows the choice", async () => {
    const state = renderProbe();
    await waitFor(() => expect(state()[2].length).toBeGreaterThan(1));
    const [first, second] = state()[2];
    expect(state()[0]).toBe(first.account);
    cleanup();

    localStorage.setItem(LAST_ACCOUNT_STORAGE_KEY, second.account);
    const again = renderProbe();
    await waitFor(() => expect(again()[0]).toBe(second.account));
    act(() => again()[1](first.account));
    expect(again()[0]).toBe(first.account);
    // an account the user cannot see is ignored
    act(() => again()[1]("NOT-MINE"));
    expect(again()[0]).toBe(second.account);
  });
});

describe("OrderActionsCell", () => {
  const props = {
    column: { name: "orderId" },
    dataRow: { orderId: "O-1", status: "NEW" },
  } as unknown as TableCellRendererProps;

  test("shows amend / cancel with row actions", () => {
    const { getByLabelText } = render(
      <OrderBlotterContext.Provider
        value={{ amend: () => undefined, cancel: () => undefined }}
      >
        <OrderActionsCell {...props} />
      </OrderBlotterContext.Provider>,
    );
    expect(getByLabelText("Cancel order O-1")).toBeTruthy();
  });

  test("read-only (no actions) shows the order id only", () => {
    const { container, queryByLabelText } = render(
      <OrderActionsCell {...props} />,
    );
    expect(queryByLabelText("Cancel order O-1")).toBeNull();
    expect(container.textContent).toBe("O-1");
  });
});
