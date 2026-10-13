import { RpcName } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { Table } from "@vuu-ui/vuu-table";
import type { TableRowSelectHandler } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type OrderEdits,
  type OrderEditSession,
  openOrderEditSession,
  StaleOrderEditError,
} from "../../data/editSessionAmend";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { filterString } from "../../utils/filters";
import { useTableSelectedKeys } from "../../data/useTableSelectedKeys";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { useTradingNotifications } from "../../notifications/TradingNotificationsProvider";
import { rpcRejectEvent } from "../../notifications/tradingOrderEvents";
import { isOrderAmendable, isOrderCancellable } from "../../utils/orderStatus";
import {
  InstrumentLookupProvider,
  useInstrumentLookup,
} from "../InstrumentLookup";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { registerTradingCellRenderers } from "../TradingCellRenderers";
import {
  CHILD_ORDER_COLUMNS,
  childOrdersTableConfig,
  ORDER_BLOTTER_COLUMNS,
  ORDER_BLOTTER_TABS,
  type OrderBlotterTab,
  orderBlotterTableConfig,
  orderBlotterTabFilter,
} from "./orderBlotterConfig";
import {
  OrderBlotterContext,
  type OrderRowActions,
  registerOrderActionsRenderer,
} from "./OrderBlotterContext";

import orderBlotterCss from "./OrderBlotter.css";

registerTradingCellRenderers();
registerOrderActionsRenderer();

const classBase = "tradingOrderBlotter";
const SOURCE = "OrderBlotter";

export interface OrderBlotterProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect" | "onError">,
    LinkGroupProps {
  /** Initial filter tab. Default "working". */
  defaultTab?: OrderBlotterTab;
  /** Show the child (street) orders of the selected order. Default true. */
  showChildOrders?: boolean;
  /** Called when an order row is selected (undefined on deselect). */
  onOrderSelect?: (orderId: string | undefined) => void;
  /** Called with RPC failures (also shown in the status line). */
  onError?: (error: TradingRpcError) => void;
  /**
   * Report failed cancel / amend requests to the
   * TradingNotificationsProvider, if there is one. Default true.
   */
  notify?: boolean;
  /**
   * Amend through the server edit session instead of the amendOrder RPC:
   * opening the amend dialog begins the session (snapshotting the order),
   * Amend applies editCell + endEditSession, Close discards it. If the order
   * changed in between the save is refused as stale. Default false.
   */
  useEditSession?: boolean;
  /**
   * Hide amend / cancel controls, e.g. for users without trading-execute
   * (the OMS rejects their requests anyway). Default false.
   */
  readOnly?: boolean;
}

const describe = (err: unknown) =>
  err instanceof StaleOrderEditError
    ? `Order ${err.orderIds.join(", ")} changed since you started editing; check it and amend again`
    : err instanceof TradingRpcError
      ? `${err.reason}: ${err.text}`
      : String(err);

/**
 * The edit session behind the amend dialog: begun when the dialog opens for
 * `orderId`, discarded when it closes. Returns submit(edits). After a stale
 * refusal the session is replaced by a fresh snapshot, so a second Amend
 * re-applies the user's values to the current order.
 */
const useAmendEditSession = (
  dataSource: DataSource,
  orderId: string | undefined,
  enabled: boolean,
) => {
  const pendingRef = useRef<Promise<OrderEditSession> | undefined>(undefined);
  const begin = useCallback(() => {
    const pending = openOrderEditSession(dataSource);
    pending.catch(() => undefined); // reported by submit
    pendingRef.current = pending;
    return pending;
  }, [dataSource]);

  useEffect(() => {
    if (!enabled || !orderId) return;
    begin();
    return () => {
      const pending = pendingRef.current;
      pendingRef.current = undefined;
      pending?.then((session) => session.discard()).catch(() => undefined);
    };
  }, [begin, enabled, orderId]);

  return useCallback(
    async (edits: OrderEdits) => {
      if (!orderId) return;
      const pending = pendingRef.current ?? begin();
      let session: OrderEditSession;
      try {
        session = await pending;
      } catch (err) {
        pendingRef.current = undefined;
        throw err;
      }
      try {
        await session.amend(orderId, edits);
        await session.save();
        pendingRef.current = undefined;
      } catch (err) {
        if (err instanceof StaleOrderEditError) {
          pendingRef.current = undefined;
          await session.discard().catch(() => undefined);
          begin();
        }
        throw err;
      }
    },
    [begin, orderId],
  );
};

const OrderBlotterInner = forwardRef<HTMLDivElement, OrderBlotterProps>(
  function OrderBlotterInner(
    {
      className,
      defaultLinkGroup,
      defaultTab = "working",
      linkGroup: linkGroupProp,
      notify: notifyEnabled = true,
      onError,
      onLinkGroupChange,
      onOrderSelect,
      readOnly = false,
      showLinkGroupSelector = false,
      showChildOrders = true,
      useEditSession = false,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-order-blotter",
      css: orderBlotterCss,
      window: targetWindow,
    });
    const lookup = useInstrumentLookup();
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id ? `${SOURCE}:${htmlAttributes.id}` : SOURCE,
    });
    const { setSelectedInstrument } = useSelectedInstrument({
      linkGroup: channel,
    });
    const notifications = useTradingNotifications();
    const [tab, setTab] = useState<OrderBlotterTab>(defaultTab);
    const [message, setMessage] = useState<{ text: string; error: boolean }>();
    const [amending, setAmending] = useState<string>();
    const [focusedOrderId, setFocusedOrderId] = useState<string>();

    const dataSource = useTradingDataSource("parentOrders", {
      columns: [...ORDER_BLOTTER_COLUMNS, "quantity", "version"],
      filterSpec: { filter: orderBlotterTabFilter(defaultTab) },
    });
    // mirror of the table's rows: resolves ranges and row lookups
    const mirror = useTradingDataSource("parentOrders", {
      columns: ["orderId", "status", "quantity", "price", "cumQty", "ric"],
      filterSpec: { filter: orderBlotterTabFilter(defaultTab) },
    });
    const { rows: records } = useDataSourceRows(mirror, { rowCount: 500 });
    const orderedKeys = useMemo(() => records.map((r) => r.$key), [records]);
    const { selectedKeys, onSelectionChange, clear } =
      useTableSelectedKeys(orderedKeys);
    const byKey = useMemo(
      () => new Map(records.map((r) => [r.$key, r])),
      [records],
    );
    const byKeyRef = useRef(byKey);
    byKeyRef.current = byKey;

    useEffect(() => {
      const filter = orderBlotterTabFilter(tab);
      dataSource.filter = { filter };
      mirror.filter = { filter };
      clear();
    }, [tab, dataSource, mirror, clear]);

    const fail = useCallback(
      (err: unknown, orderId?: string) => {
        setMessage({ text: describe(err), error: true });
        if (err instanceof TradingRpcError) onError?.(err);
        if (notifyEnabled && notifications.provided) {
          const order = orderId ? byKeyRef.current.get(orderId) : undefined;
          notifications.notify(
            rpcRejectEvent(err, {
              orderId,
              ric: order?.ric === undefined ? undefined : String(order.ric),
              source: SOURCE,
            }),
          );
        }
      },
      [onError, notifyEnabled, notifications],
    );

    const cancelIds = useCallback(
      async (orderIds: string[]) => {
        const results = await Promise.allSettled(
          orderIds.map((orderId) =>
            sendTradingRpc(dataSource, RpcName.CancelOrder, { orderId }),
          ),
        );
        const failed = results.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        const firstFailed = results.findIndex((r) => r.status === "rejected");
        if (failed.length) fail(failed[0].reason, orderIds[firstFailed]);
        else
          setMessage({
            text: `Cancel sent for ${orderIds.length} order(s)`,
            error: false,
          });
      },
      [dataSource, fail],
    );

    const actions = useMemo<OrderRowActions>(
      () => ({
        amend: (orderId) => setAmending(orderId),
        cancel: (orderId) => void cancelIds([orderId]),
      }),
      [cancelIds],
    );

    const cancellableSelected = useMemo(
      () =>
        [...selectedKeys].filter((key) => {
          const r = byKey.get(key);
          return r && isOrderCancellable(String(r.status));
        }),
      [selectedKeys, byKey],
    );

    const cancelAll = useCallback(async () => {
      try {
        const { orderIds } = await sendTradingRpc(
          dataSource,
          RpcName.CancelAll,
          {},
        );
        setMessage({
          text: `Cancel all sent for ${orderIds.length} order(s)`,
          error: false,
        });
      } catch (err) {
        fail(err);
      }
    }, [dataSource, fail]);

    const handleSelect = useCallback<TableRowSelectHandler>(
      (row) => {
        if (!row) {
          setFocusedOrderId(undefined);
          onOrderSelect?.(undefined);
          return;
        }
        const ric = String(row.ric);
        const orderId = String(row.orderId);
        setFocusedOrderId(orderId);
        onOrderSelect?.(orderId);
        setSelectedInstrument(lookup.get(ric) ?? { ric }, SOURCE);
      },
      [lookup, onOrderSelect, setSelectedInstrument],
    );

    const amendTarget = amending
      ? records.find((r) => r.orderId === amending)
      : undefined;

    const amendInSession = useAmendEditSession(
      dataSource,
      amending,
      useEditSession,
    );

    const submitAmend = useCallback(
      async (quantity: number | undefined, price: number | undefined) => {
        if (!amending) return;
        try {
          if (useEditSession) {
            await amendInSession({ quantity, price });
          } else {
            await sendTradingRpc(dataSource, RpcName.AmendOrder, {
              orderId: amending,
              quantity,
              price,
            });
          }
          setMessage({ text: `Amend sent for ${amending}`, error: false });
          setAmending(undefined);
        } catch (err) {
          fail(err, amending);
        }
      },
      [amendInSession, amending, dataSource, fail, useEditSession],
    );

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        data-testid="trading-order-blotter"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`} role="tablist">
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          {ORDER_BLOTTER_TABS.map(({ id, label }) => (
            <button
              aria-selected={tab === id}
              className={`${classBase}-tab`}
              key={id}
              onClick={() => setTab(id)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
          <span className={`${classBase}-spacer`} />
          {readOnly ? null : (
            <>
              <button
                disabled={cancellableSelected.length === 0}
                onClick={() => void cancelIds(cancellableSelected)}
                type="button"
              >
                Cancel selected ({cancellableSelected.length})
              </button>
              <button onClick={() => void cancelAll()} type="button">
                Cancel all
              </button>
            </>
          )}
        </div>
        <OrderBlotterContext.Provider value={readOnly ? undefined : actions}>
          <div className={`${classBase}-table`}>
            <Table
              config={orderBlotterTableConfig}
              dataSource={dataSource}
              onSelect={handleSelect}
              onSelectionChange={onSelectionChange}
              selectionModel="extended"
            />
          </div>
        </OrderBlotterContext.Provider>
        {message ? (
          <div
            aria-live="polite"
            className={`${classBase}-message`}
            data-error={message.error}
            role={message.error ? "alert" : "status"}
          >
            {message.text}
          </div>
        ) : null}
        {showChildOrders ? (
          <ChildOrders parentOrderId={focusedOrderId} />
        ) : null}
        {amending ? (
          <AmendDialog
            onCancel={() => setAmending(undefined)}
            onSubmit={submitAmend}
            order={amendTarget}
            orderId={amending}
          />
        ) : null}
      </div>
    );
  },
);

const ChildOrders = ({ parentOrderId }: { parentOrderId?: string }) => {
  const dataSource = useTradingDataSource("childOrders", {
    columns: [...CHILD_ORDER_COLUMNS],
    filterSpec: { filter: 'parentOrderId = "-"' },
  });
  useEffect(() => {
    dataSource.filter = {
      filter: `parentOrderId = ${filterString(parentOrderId ?? "-")}`,
    };
  }, [dataSource, parentOrderId]);
  return (
    <div className={`${classBase}-children`}>
      <div className={`${classBase}-children-title`}>
        {parentOrderId
          ? `Child orders of ${parentOrderId}`
          : "Select an order to see its child orders"}
      </div>
      <Table config={childOrdersTableConfig} dataSource={dataSource} />
    </div>
  );
};

const AmendDialog = ({
  onCancel,
  onSubmit,
  order,
  orderId,
}: {
  onCancel: () => void;
  onSubmit: (quantity?: number, price?: number) => void;
  order?: Record<string, unknown>;
  orderId: string;
}) => {
  const [quantity, setQuantity] = useState(String(order?.quantity ?? ""));
  const [price, setPrice] = useState(String(order?.price ?? ""));
  const priced = Number(order?.price) > 0;
  const canAmend = order ? isOrderAmendable(String(order.status)) : false;
  return (
    <form
      aria-label={`Amend order ${orderId}`}
      className={`${classBase}-dialog`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          quantity === "" ? undefined : Number(quantity),
          priced && price !== "" ? Number(price) : undefined,
        );
      }}
    >
      <strong>Amend {orderId}</strong>
      <label>
        Quantity
        <input
          min={0}
          onChange={(e) => setQuantity(e.target.value)}
          type="number"
          value={quantity}
        />
      </label>
      {priced ? (
        <label>
          Price
          <input
            onChange={(e) => setPrice(e.target.value)}
            step="any"
            type="number"
            value={price}
          />
        </label>
      ) : null}
      <span>
        <button disabled={!canAmend} type="submit">
          Amend
        </button>
        <button onClick={onCancel} type="button">
          Close
        </button>
      </span>
    </form>
  );
};

/**
 * Order blotter on `parentOrders`: status badge, fill progress, tick-formatted
 * avg price, filter tabs, per-row amend / cancel (enabled only for NEW,
 * PARTIALLY_FILLED, REPLACED), multi-select cancel, Cancel all and a child
 * orders panel. Selecting a row sets the selected instrument.
 */
export const OrderBlotter = forwardRef<HTMLDivElement, OrderBlotterProps>(
  function OrderBlotter(props, ref) {
    return (
      <InstrumentLookupProvider>
        <OrderBlotterInner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
