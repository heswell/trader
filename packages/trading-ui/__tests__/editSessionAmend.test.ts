import { describe, expect, test } from "bun:test";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import {
  editOrdersInSession,
  openOrderEditSession,
  StaleOrderEditError,
  TradingRpcError,
} from "../src";

type Call = [string, ...unknown[]];

/** A parentOrders data source whose edit session behaves like VuuDataSource. */
const fakeDataSource = ({
  editCell = () => ({ type: "SUCCESS_RESULT", data: undefined }),
  save = () => undefined,
}: {
  editCell?: (column: string, value: unknown) => unknown;
  save?: () => void;
} = {}) => {
  const calls: Call[] = [];
  const session = {
    subscribe: async () => calls.push(["subscribe"]),
    unsubscribe: () => calls.push(["unsubscribe"]),
    editCell: async (key: string, column: string, value: unknown) => {
      calls.push(["editCell", key, column, value]);
      return editCell(column, value);
    },
    deleteRow: async (key: string) => {
      calls.push(["deleteRow", key]);
      return { type: "SUCCESS_RESULT", data: undefined };
    },
    endEditSession: async (saveChanges = false) => {
      calls.push(["endEditSession", saveChanges]);
      if (saveChanges) save();
    },
  };
  const dataSource = {
    beginEditSession: async () => {
      calls.push(["beginEditSession"]);
      return session;
    },
  } as unknown as DataSource;
  return { calls, dataSource };
};

describe("parentOrders edit session", () => {
  test("amend and cancel, then save", async () => {
    const { calls, dataSource } = fakeDataSource();
    await editOrdersInSession(dataSource, {
      amend: { "ORD-1": { quantity: 300, price: 101 } },
      cancel: ["ORD-2"],
    });
    expect(calls).toEqual([
      ["beginEditSession"],
      ["subscribe"],
      ["editCell", "ORD-1", "quantity", 300],
      ["editCell", "ORD-1", "price", 101],
      ["deleteRow", "ORD-2"],
      ["endEditSession", true],
      ["unsubscribe"],
    ]);
  });

  test("a refused editCell is a TradingRpcError and the session is discarded", async () => {
    const { calls, dataSource } = fakeDataSource({
      editCell: (column) =>
        column === "price"
          ? { type: "ERROR_RESULT", errorMessage: "INVALID_PRICE: price > 0" }
          : { type: "SUCCESS_RESULT", data: undefined },
    });
    const error = await editOrdersInSession(dataSource, {
      amend: { "ORD-1": { quantity: 300, price: -1 } },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(TradingRpcError);
    expect(error.reason).toBe("INVALID_PRICE");
    expect(calls.slice(-2)).toEqual([
      ["endEditSession", false],
      ["unsubscribe"],
    ]);
  });

  test("a stale save names the edited orders; the open session can be discarded", async () => {
    const { calls, dataSource } = fakeDataSource({
      save: () => {
        // VuuDataSource throws StaleUpdateError("stale update")
        throw Error("stale update");
      },
    });
    const session = await openOrderEditSession(dataSource);
    await session.amend("ORD-1", { quantity: 300 });
    const error = await session.save().catch((err) => err);
    expect(error).toBeInstanceOf(StaleOrderEditError);
    expect(error.orderIds).toEqual(["ORD-1"]);
    expect(error.message).toBe(
      "stale update: ORD-1 changed since you started editing",
    );
    // a failed save leaves the server session open until it is discarded
    expect(calls.at(-1)).toEqual(["endEditSession", true]);
    await session.discard();
    await session.discard();
    expect(calls.slice(-2)).toEqual([
      ["endEditSession", false],
      ["unsubscribe"],
    ]);
  });

  test("other save failures keep the server's reason", async () => {
    const { dataSource } = fakeDataSource({
      save: () => {
        throw Error("PERMISSION_DENIED: dave may not trade");
      },
    });
    const error = await editOrdersInSession(dataSource, {
      cancel: ["ORD-1"],
    }).catch((err) => err);
    expect(error).toBeInstanceOf(TradingRpcError);
    expect(error).not.toBeInstanceOf(StaleOrderEditError);
    expect(error.reason).toBe("PERMISSION_DENIED");
  });

  test("a remote session is rebuilt with the source's connection-bound class (upstream issue 70)", async () => {
    const calls: Call[] = [];
    // stands in for VuuDataSource: beginEditSession returns the base class
    class Base {
      isRemote = true;
      config = { columns: ["id", "quantity"] };
      constructor(readonly props: Record<string, unknown>) {}
      async beginEditSession() {
        return new Base({ table: SESSION_TABLE, viewport: "vp-session" });
      }
      get table() {
        return this.props.table;
      }
      get viewport() {
        return this.props.viewport;
      }
      async subscribe() {
        calls.push(["subscribe", this.constructor.name, this.props]);
      }
      unsubscribe() {
        calls.push(["unsubscribe"]);
      }
      async endEditSession() {
        calls.push(["endEditSession"]);
      }
      async rpcRequest(request: { rpcName: string; params: unknown }) {
        calls.push(["rpcRequest", request.rpcName, request.params]);
        return { type: "SUCCESS_RESULT", data: undefined };
      }
    }
    class Bound extends Base {
      constructor(props: Record<string, unknown>) {
        super({ ...props, connectionId: "trading" });
      }
    }
    const SESSION_TABLE = { module: "OMS", table: "session:S1/parentOrders" };
    const source = new Bound({
      table: { module: "OMS", table: "parentOrders" },
    });
    const session = await openOrderEditSession(source as unknown as DataSource);
    await session.save();
    expect(calls).toEqual([
      [
        "subscribe",
        "Bound",
        {
          columns: ["id", "quantity"],
          table: SESSION_TABLE,
          viewport: "vp-session",
          connectionId: "trading",
        },
      ],
      ["rpcRequest", "endEditSession", { save: true, force: false }],
      ["unsubscribe"],
      ["unsubscribe"],
    ]);
  });
});
