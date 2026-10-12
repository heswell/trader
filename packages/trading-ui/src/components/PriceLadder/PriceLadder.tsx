import {
  type AmendOrderResponse,
  OrdStatus,
  type CancelAllResponse,
  type CancelOrderResponse,
  type CreateOrderRequest,
  type CreateOrderResponse,
  OrdType,
  type RpcName,
  TimeInForce,
} from "@heswell/trading-schemas";
import { forwardRef, useCallback, useMemo, useRef, useState } from "react";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import {
  useFollowedInstrument,
  useMarketDepth,
  useTradedVolume,
} from "../../hooks/useMarketData";
import {
  type OwnOrder,
  useOwnWorkingOrders,
} from "../../hooks/useOwnWorkingOrders";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { useTradingNotifications } from "../../notifications/TradingNotificationsProvider";
import {
  orderEventKindForStatus,
  rpcRejectEvent,
  type TradingOrderEvent,
} from "../../notifications/tradingOrderEvents";
import { formatPrice } from "../../utils/formatting";
import {
  instrumentTickSchedule,
  isInactivePhase,
  tradingPhaseText,
} from "../../utils/marketData";
import { LinkGroupSelector } from "../LinkGroupSelector";
import {
  type LadderTradeIntent,
  PriceLadderView,
  type PriceLadderViewProps,
} from "./PriceLadderView";

export type PriceLadderOrderEvent =
  | {
      type: "create";
      request: CreateOrderRequest;
      response: CreateOrderResponse;
    }
  | {
      type: "amend";
      order: OwnOrder;
      price: number;
      response: AmendOrderResponse;
    }
  | { type: "cancel"; order: OwnOrder; response: CancelOrderResponse }
  | {
      type: "cancelAll";
      ric: string;
      account?: string;
      response: CancelAllResponse;
    };

export type PriceLadderAction =
  | { type: "create"; request: CreateOrderRequest }
  | { type: "amend"; order: OwnOrder; price: number }
  | { type: "cancel"; order: OwnOrder }
  | { type: "cancelAll"; ric: string; account?: string };

export interface PriceLadderProps
  extends Omit<
      PriceLadderViewProps,
      | "asks"
      | "bids"
      | "last"
      | "lotSize"
      | "onAmendOrders"
      | "onCancelAll"
      | "onCancelOrders"
      | "onTrade"
      | "ownOrders"
      | "priceFormat"
      | "referencePrice"
      | "ric"
      | "status"
      | "statusKind"
      | "tickSchedule"
      | "tradedVolume"
    >,
    LinkGroupProps {
  /** Instrument to show; defaults to the selected instrument. */
  ric?: string;
  /**
   * Account for new orders; also restricts own orders to it. Without an
   * account the ladder is view-only for new orders.
   */
  account?: string;
  /** Depth levels per side to request (max 10). Default 10. */
  levels?: number;
  timeInForce?: TimeInForce;
  /** Prefix of generated clOrdIds. Default "LDR". */
  clOrdIdPrefix?: string;
  /** Successful order RPCs (create / amend / cancel / cancelAll). */
  onOrderEvent?: (event: PriceLadderOrderEvent) => void;
  /** Rejected order RPCs (also shown in the ladder's status line). */
  onError?: (error: TradingRpcError, action: PriceLadderAction) => void;
  /**
   * Report new orders and failed requests to the TradingNotificationsProvider
   * (if there is one; deduplicated with the order stream toasts by clOrdId).
   * Default true.
   */
  notify?: boolean;
}

export const PRICE_LADDER_SOURCE = "ladder";

const rpcNames: Record<PriceLadderAction["type"], RpcName> = {
  create: "createOrder",
  amend: "amendOrder",
  cancel: "cancelOrder",
  cancelAll: "cancelAll",
};

let clOrdSeq = 0;
const newClOrdId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${++clOrdSeq}`;

/** The order a ladder action is about, as a notification event. */
const actionEvent = (
  action: PriceLadderAction,
): Omit<TradingOrderEvent, "kind"> => {
  switch (action.type) {
    case "create": {
      const { request } = action;
      return {
        clOrdId: request.clOrdId,
        ric: request.ric,
        side: request.side,
        quantity: request.quantity,
        price: request.price,
        account: request.account,
        status: OrdStatus.Rejected,
      };
    }
    case "amend":
    case "cancel": {
      const { order } = action;
      return {
        orderId: order.orderId,
        ric: order.ric,
        side: order.side,
        quantity: order.quantity,
        price: action.type === "amend" ? action.price : order.price,
      };
    }
    case "cancelAll":
      return { ric: action.ric, account: action.account };
  }
};

const toRpcError = (err: unknown, rpcName: RpcName) =>
  err instanceof TradingRpcError
    ? err
    : new TradingRpcError(rpcName, `INTERNAL_ERROR: ${String(err)}`);

/**
 * Price ladder (depth of market) bound to live data: EXCHANGE depth,
 * instrumentPrices and (optionally) trades for the selected instrument (or
 * `ric`), plus the user's working orders from the OMS. Click-to-trade sends
 * `createOrder` (LIMIT, own clOrdId); dragging own orders sends
 * `amendOrder`; Delete / double-click sends `cancelOrder`; Cancel all sends
 * `cancelAll`. Results are reported through `onOrderEvent` / `onError`.
 */
export const PriceLadder = forwardRef<HTMLDivElement, PriceLadderProps>(
  function PriceLadder(
    {
      account,
      clOrdIdPrefix = "LDR",
      defaultLinkGroup,
      levels = 10,
      linkGroup: linkGroupProp,
      notify: notifyEnabled = true,
      onError,
      onLinkGroupChange,
      onOrderEvent,
      ric: ricProp,
      showLinkGroupSelector = false,
      showVolume = false,
      timeInForce = TimeInForce.Day,
      tradingEnabled = true,
      ...props
    },
    ref,
  ) {
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: props.id ? `PriceLadder:${props.id}` : "PriceLadder",
    });
    const { ric, instrument } = useFollowedInstrument(ricProp, {
      linkGroup: channel,
    });
    const { bids, asks } = useMarketDepth(ric, {
      levels: Math.max(1, Math.min(levels, 10)),
    });
    const own = useOwnWorkingOrders(ric, { account });
    const tradedVolume = useTradedVolume(ric, { enabled: showVolume });
    const tickSchedule = useMemo(
      () => instrumentTickSchedule(instrument),
      [instrument],
    );
    const priceFormat = useMemo(
      () =>
        instrument
          ? {
              priceDecimals: instrument.priceDecimals,
              tickSize: instrument.tickSize,
              tickBands: instrument.tickBands,
            }
          : undefined,
      [instrument],
    );
    const [status, setStatus] = useState<{
      text: string;
      kind: "info" | "error";
    }>();
    const notifications = useTradingNotifications();
    const notify = useCallback(
      (event: TradingOrderEvent) => {
        if (notifyEnabled && notifications.provided)
          notifications.notify({ source: PRICE_LADDER_SOURCE, ...event });
      },
      [notifications, notifyEnabled],
    );
    const callbacks = useRef({ onError, onOrderEvent, notify });
    callbacks.current = { onError, onOrderEvent, notify };

    const fail = useCallback((err: unknown, action: PriceLadderAction) => {
      const error = toRpcError(err, rpcNames[action.type]);
      setStatus({ text: `${error.reason}: ${error.text}`, kind: "error" });
      callbacks.current.onError?.(error, action);
      callbacks.current.notify(rpcRejectEvent(error, actionEvent(action)));
    }, []);

    const { dataSource } = own;
    const fmt = useCallback(
      (p: number) => formatPrice(p, priceFormat ?? {}),
      [priceFormat],
    );

    const handleTrade = useCallback(
      async ({ side, price, quantity }: LadderTradeIntent) => {
        if (!ric || !account) return;
        const request: CreateOrderRequest = {
          account,
          ric,
          side,
          ordType: OrdType.Limit,
          quantity,
          price,
          timeInForce,
          clOrdId: newClOrdId(clOrdIdPrefix),
        };
        try {
          const response = await sendTradingRpc(
            dataSource,
            "createOrder",
            request,
          );
          setStatus({
            text: `${response.orderId} ${response.status}`,
            kind: "info",
          });
          callbacks.current.onOrderEvent?.({
            type: "create",
            request,
            response,
          });
          callbacks.current.notify({
            ...actionEvent({ type: "create", request }),
            kind: orderEventKindForStatus(response.status) ?? "ack",
            orderId: response.orderId,
            status: response.status,
          });
        } catch (err) {
          fail(err, { type: "create", request });
        }
      },
      [ric, account, timeInForce, clOrdIdPrefix, dataSource, fail],
    );

    const handleCancelOrders = useCallback(
      async (orders: OwnOrder[]) => {
        await Promise.all(
          orders.map(async (order) => {
            try {
              const response = await sendTradingRpc(dataSource, "cancelOrder", {
                orderId: order.orderId,
              });
              callbacks.current.onOrderEvent?.({
                type: "cancel",
                order,
                response,
              });
            } catch (err) {
              fail(err, { type: "cancel", order });
            }
          }),
        );
      },
      [dataSource, fail],
    );

    const handleAmendOrders = useCallback(
      async (orders: OwnOrder[], price: number) => {
        await Promise.all(
          orders.map(async (order) => {
            try {
              const response = await sendTradingRpc(dataSource, "amendOrder", {
                orderId: order.orderId,
                price,
              });
              setStatus({
                text: `${order.orderId} → ${fmt(price)} ${response.status}`,
                kind: "info",
              });
              callbacks.current.onOrderEvent?.({
                type: "amend",
                order,
                price,
                response,
              });
            } catch (err) {
              fail(err, { type: "amend", order, price });
            }
          }),
        );
      },
      [dataSource, fail, fmt],
    );

    const handleCancelAll = useCallback(async () => {
      if (!ric) return;
      try {
        const response = await sendTradingRpc(dataSource, "cancelAll", {
          ric,
          ...(account ? { account } : {}),
        });
        setStatus({
          text: `Cancelled ${response.orderIds.length} order(s)`,
          kind: "info",
        });
        callbacks.current.onOrderEvent?.({
          type: "cancelAll",
          ric,
          account,
          response,
        });
      } catch (err) {
        fail(err, { type: "cancelAll", ric, account });
      }
    }, [ric, account, dataSource, fail]);

    const phase = instrument?.phase;
    const inactive = isInactivePhase(phase);
    const canTrade = tradingEnabled && !!account && !!ric && !inactive;
    const disabledReason = !account
      ? "No account: view only"
      : inactive && phase
        ? tradingPhaseText[phase]
        : undefined;

    return (
      <PriceLadderView
        {...props}
        asks={asks}
        bids={bids}
        data-phase={phase}
        disabledReason={disabledReason}
        last={instrument?.last || undefined}
        lotSize={instrument?.lotSize || 1}
        onAmendOrders={handleAmendOrders}
        onCancelAll={handleCancelAll}
        onCancelOrders={handleCancelOrders}
        onTrade={handleTrade}
        ownOrders={own.byPrice}
        priceFormat={priceFormat}
        ref={ref}
        referencePrice={instrument?.close || instrument?.refPrice || undefined}
        data-link-group={linkGroup}
        ric={ric}
        showVolume={showVolume}
        status={status?.text}
        statusKind={status?.kind}
        tickSchedule={tickSchedule}
        toolbarStart={
          showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : (
            props.toolbarStart
          )
        }
        tradedVolume={tradedVolume}
        tradingEnabled={canTrade}
      />
    );
  },
);
