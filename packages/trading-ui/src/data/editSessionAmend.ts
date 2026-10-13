import type {
  DataSource,
  DataSourceConstructorProps,
} from "@vuu-ui/vuu-data-types";
import { Range } from "@vuu-ui/vuu-utils";
import { TradingRpcError } from "./tradingRpc";

export interface OrderEdits {
  quantity?: number;
  price?: number;
}

const STALE_UPDATE = "stale update";

/**
 * The save was refused because orders changed after the session began
 * (vuu-server snapshots each row at session start and compares it at save;
 * the per-row detail is in the session table's vuuMsg as stale:<key>:<cols>).
 */
export class StaleOrderEditError extends TradingRpcError {
  constructor(readonly orderIds: readonly string[]) {
    super(
      "amendOrder",
      `${STALE_UPDATE}: ${orderIds.join(", ")} changed since you started editing`,
    );
  }
}

const isRpcError = (
  result: unknown,
): result is { type: "ERROR_RESULT"; errorMessage: string } =>
  typeof result === "object" &&
  result !== null &&
  (result as { type?: unknown }).type === "ERROR_RESULT";

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * An open server edit session on `parentOrders` (beginEditSession). The
 * server copies the user's visible orders when it begins, so a save fails
 * with StaleOrderEditError if any of them changed meanwhile. A failed save
 * leaves the session open (vuu-server rolls the source back); retry it or
 * discard() it.
 */
export interface OrderEditSession {
  /** editCell quantity / price; rejects with TradingRpcError if refused. */
  amend(orderId: string, edits: OrderEdits): Promise<void>;
  /** deleteRow: the OMS cancels the order when the session is saved. */
  cancel(orderId: string): Promise<void>;
  /** endEditSession(save): the OMS sends amendOrder / cancelOrder. */
  save(): Promise<void>;
  /** endEditSession without saving; safe to call more than once. */
  discard(): Promise<void>;
}

type DataSourceClass = new (props: DataSourceConstructorProps) => DataSource;

/**
 * Upstream issue 70: @vuu-ui/vuu-data-remote's beginEditSession builds the
 * session VuuDataSource from the base class without the source's
 * connectionId, so under a portal (or any connection-bound subclass) its
 * viewport goes to the default "portal" server, which has no such table.
 * Rebuild it with the source's own (connection-bound) class. The rebuilt
 * instance is not linked to its source, so its endEditSession would send a
 * resume for the removed viewport; end it with the RPC instead.
 */
const rebindRemoteSession = (source: DataSource, session: DataSource) => {
  const remote = (source as { isRemote?: boolean }).isRemote === true;
  const Source = source.constructor as DataSourceClass;
  if (!remote || session.constructor === Source) return undefined;
  const { table, viewport } = session as DataSource & {
    table: DataSourceConstructorProps["table"];
  };
  return new Source({ ...session.config, table, viewport });
};

const endRemoteSession = async (session: DataSource, save: boolean) => {
  const result = await session.rpcRequest?.({
    type: "RPC_REQUEST",
    rpcName: "endEditSession",
    params: save ? { save: true, force: false } : {},
  });
  if (isRpcError(result)) throw new Error(result.errorMessage);
  session.unsubscribe();
};

/**
 * Begin a server edit session on the live `parentOrders` data source. Only
 * `quantity` and `price` are editable; addRow is refused (use createOrder).
 */
export const openOrderEditSession = async (
  dataSource: DataSource,
): Promise<OrderEditSession> => {
  if (!dataSource.beginEditSession) {
    throw new TradingRpcError(
      "amendOrder",
      "INVALID_REQUEST: data source does not support edit sessions",
    );
  }
  let session: DataSource;
  let rebound = false;
  try {
    const begun = await dataSource.beginEditSession();
    if (!begun) throw Error("beginEditSession returned no session");
    const rebuilt = rebindRemoteSession(dataSource, begun);
    rebound = rebuilt !== undefined;
    session = rebuilt ?? begun;
  } catch (err) {
    throw new TradingRpcError("amendOrder", errorMessage(err));
  }
  const end = (save: boolean) =>
    rebound ? endRemoteSession(session, save) : session.endEditSession?.(save);
  await session.subscribe({ range: Range(0, 1) }, () => undefined);
  const touched = new Set<string>();
  let open = true;

  const rpc = async (call: Promise<unknown> | undefined) => {
    const result = await call;
    if (isRpcError(result)) {
      throw new TradingRpcError("amendOrder", result.errorMessage);
    }
  };
  const close = () => {
    open = false;
    session.unsubscribe();
  };

  return {
    async amend(orderId, { quantity, price }) {
      touched.add(orderId);
      if (quantity !== undefined) {
        await rpc(session.editCell?.(orderId, "quantity", quantity));
      }
      if (price !== undefined) {
        await rpc(session.editCell?.(orderId, "price", price));
      }
    },
    async cancel(orderId) {
      touched.add(orderId);
      await rpc(session.deleteRow?.(orderId));
    },
    async save() {
      try {
        await end(true);
      } catch (err) {
        const message = errorMessage(err);
        if (message === STALE_UPDATE) {
          throw new StaleOrderEditError([...touched]);
        }
        throw err instanceof TradingRpcError
          ? err
          : new TradingRpcError("amendOrder", message);
      }
      close();
    },
    async discard() {
      if (!open) return;
      try {
        await end(false);
      } finally {
        close();
      }
    },
  };
};

/**
 * Amend / cancel orders in one edit session: begin, editCell / deleteRow,
 * save. The OMS turns changed rows into amendOrder and deleted rows into
 * cancelOrder. Rejects with TradingRpcError (StaleOrderEditError if an order
 * changed underneath); the session is discarded on any failure.
 */
export const editOrdersInSession = async (
  dataSource: DataSource,
  edits: { amend?: Record<string, OrderEdits>; cancel?: readonly string[] },
) => {
  const session = await openOrderEditSession(dataSource);
  try {
    for (const [orderId, orderEdits] of Object.entries(edits.amend ?? {})) {
      await session.amend(orderId, orderEdits);
    }
    for (const orderId of edits.cancel ?? []) {
      await session.cancel(orderId);
    }
    await session.save();
  } catch (err) {
    await session.discard().catch(() => undefined);
    throw err;
  }
};
