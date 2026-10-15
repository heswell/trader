// The ladder follows the APG data grid pattern: <table role="grid"> with
// aria-activedescendant, which these two rules flag as contradictory.
// biome-ignore-all lint/a11y/useSemanticElements: table role=grid is the APG data grid pattern
// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: table role=grid is the APG data grid pattern
import {
  roundToLot,
  Side,
  stepTicks,
  type TickSchedule,
} from "@heswell/trading-schemas";
import {
  Button,
  Input,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  type ChangeEvent,
  type FocusEvent,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { priceKey } from "../../hooks/useMarketData";
import {
  actionableOrders,
  type OwnOrder,
  type OwnOrdersAtPrice,
  ownOrdersKey,
} from "../../hooks/useOwnWorkingOrders";
import {
  formatPrice,
  formatQuantity,
  type PriceFormat,
} from "../../utils/formatting";
import {
  centreIndex,
  ladderPrices,
  ladderReferencePrice,
  needsRecentre,
} from "./ladderPrices";
import priceLadderCss from "./PriceLadder.css";

const classBase = "tradingPriceLadder";

export type PriceLadderTradeMode = "confirm" | "one-click";

/** A price level of one side of the book. */
export interface LadderLevel {
  price: number;
  size: number;
}

export interface LadderTradeIntent {
  side: Side;
  price: number;
  quantity: number;
}

export type PriceLadderColumn =
  | "ownBuy"
  | "bid"
  | "price"
  | "ask"
  | "ownSell"
  | "volume";

export interface PriceLadderViewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onError"> {
  /** Shown in the toolbar and accessible labels. */
  ric?: string;
  /** Content at the start of the toolbar (e.g. a LinkGroupSelector). */
  toolbarStart?: ReactNode;
  /** Price formatting (priceDecimals / tickSize / tickBands). */
  priceFormat?: PriceFormat;
  /** Tick schedule: the ladder has one row per tick. Required to render rows. */
  tickSchedule?: TickSchedule;
  lotSize?: number;
  bids?: readonly LadderLevel[];
  asks?: readonly LadderLevel[];
  last?: number;
  /** Centre price when there is no bid / ask / last (e.g. close). */
  referencePrice?: number;
  /** Own working orders, keyed by `ownOrdersKey(side, price)`. */
  ownOrders?: ReadonlyMap<string, OwnOrdersAtPrice>;
  /** Traded volume keyed by `priceKey(price)`. */
  tradedVolume?: ReadonlyMap<number, number>;
  /** Show the traded-volume column. Default false. */
  showVolume?: boolean;
  /** Visible rows. Default: as many as fit the height (min 5). */
  rowCount?: number;
  /** Auto-centre on mid / last. Controlled, with `onAutoCentreChange`. */
  autoCentre?: boolean;
  defaultAutoCentre?: boolean;
  onAutoCentreChange?: (autoCentre: boolean) => void;
  /** Order quantity. Controlled, with `onQuantityChange`. */
  quantity?: number;
  /** Initial quantity. Default: 100 rounded up to the lot size. */
  defaultQuantity?: number;
  onQuantityChange?: (quantity: number) => void;
  /** Click-to-trade mode. Controlled, with `onTradeModeChange`. */
  tradeMode?: PriceLadderTradeMode;
  defaultTradeMode?: PriceLadderTradeMode;
  onTradeModeChange?: (mode: PriceLadderTradeMode) => void;
  /** False disables new orders (amend / cancel stay available). */
  tradingEnabled?: boolean;
  /** Why trading is disabled, e.g. "Trading halted". */
  disabledReason?: string;
  /** Status / error line (rendered in a live region). */
  status?: ReactNode;
  statusKind?: "info" | "error";
  /** New order at a price (after confirmation in confirm mode). */
  onTrade?: (intent: LadderTradeIntent) => void;
  /** Cancel own orders at a price level. */
  onCancelOrders?: (orders: OwnOrder[], price: number) => void;
  /** Move (amend) own orders to `price`. */
  onAmendOrders?: (orders: OwnOrder[], price: number) => void;
  /** Cancel every own order for the instrument. Hidden when omitted. */
  onCancelAll?: () => void;
}

const COLUMNS: PriceLadderColumn[] = [
  "ownBuy",
  "bid",
  "price",
  "ask",
  "ownSell",
  "volume",
];
const COLUMN_LABELS: Record<PriceLadderColumn, string> = {
  ownBuy: "My bids",
  bid: "Bid qty",
  price: "Price",
  ask: "Ask qty",
  ownSell: "My offers",
  volume: "Volume",
};

const DEFAULT_ROWS = 25;
const FALLBACK_ROW_HEIGHT = 20;
const WHEEL_TICKS = 2;

interface LadderRowProps {
  gridId: string;
  slot: number;
  price: number;
  priceText: string;
  bidQty: number;
  askQty: number;
  ownBuyQty: number;
  ownBuyCount: number;
  ownSellQty: number;
  ownSellCount: number;
  volume: number;
  maxQty: number;
  showVolume: boolean;
  bestBid: boolean;
  bestAsk: boolean;
  ltp: boolean;
  inSpread: boolean;
  /** Index into COLUMNS of the cursor cell in this row, or -1. */
  cursorCol: number;
  dropTarget: boolean;
  moving: boolean;
}

const cellId = (gridId: string, slot: number, col: PriceLadderColumn) =>
  `${gridId}-${slot}-${col}`;

const qtyText = (qty: number) => (qty > 0 ? formatQuantity(qty) : "");
const ownText = (qty: number, count: number) =>
  qty > 0 ? `${formatQuantity(qty)}${count > 1 ? ` (${count})` : ""}` : "";

const LadderRow = memo(function LadderRow({
  gridId,
  slot,
  price,
  priceText,
  bidQty,
  askQty,
  ownBuyQty,
  ownBuyCount,
  ownSellQty,
  ownSellCount,
  volume,
  maxQty,
  showVolume,
  bestBid,
  bestAsk,
  ltp,
  inSpread,
  cursorCol,
  dropTarget,
  moving,
}: LadderRowProps) {
  const cell = (
    col: PriceLadderColumn,
    content: ReactNode,
    extra?: HTMLAttributes<HTMLTableCellElement> &
      Record<`data-${string}`, unknown>,
  ) => (
    <td
      {...extra}
      id={cellId(gridId, slot, col)}
      className={cx(`${classBase}-cell`, `${classBase}-${col}`)}
      data-col={col}
      data-cursor={COLUMNS[cursorCol] === col || undefined}
    >
      {content}
    </td>
  );
  const bar = (qty: number) =>
    qty > 0 ? (
      <span
        aria-hidden
        className={`${classBase}-bar`}
        style={{ width: `${Math.min(100, (qty / maxQty) * 100)}%` }}
      />
    ) : null;
  return (
    <tr
      aria-rowindex={slot + 2}
      className={`${classBase}-row`}
      data-price={price}
      data-best-bid={bestBid || undefined}
      data-best-ask={bestAsk || undefined}
      data-ltp={ltp || undefined}
      data-spread={inSpread || undefined}
      data-drop-target={dropTarget || undefined}
      data-moving={moving || undefined}
      data-cursor-row={cursorCol >= 0 || undefined}
    >
      {cell("ownBuy", ownText(ownBuyQty, ownBuyCount), {
        "data-own": ownBuyQty > 0 || undefined,
        "aria-label": ownBuyQty
          ? `my bids ${formatQuantity(ownBuyQty)} in ${ownBuyCount} orders`
          : undefined,
      })}
      {cell(
        "bid",
        <>
          {bar(bidQty)}
          <span className={`${classBase}-qty`}>{qtyText(bidQty)}</span>
        </>,
        { "data-side": Side.Buy },
      )}
      {cell("price", priceText, {
        "aria-label": `${priceText}${ltp ? ", last traded" : ""}${bestBid ? ", best bid" : ""}${bestAsk ? ", best ask" : ""}`,
      })}
      {cell(
        "ask",
        <>
          {bar(askQty)}
          <span className={`${classBase}-qty`}>{qtyText(askQty)}</span>
        </>,
        { "data-side": Side.Sell },
      )}
      {cell("ownSell", ownText(ownSellQty, ownSellCount), {
        "data-own": ownSellQty > 0 || undefined,
        "aria-label": ownSellQty
          ? `my offers ${formatQuantity(ownSellQty)} in ${ownSellCount} orders`
          : undefined,
      })}
      {showVolume ? cell("volume", qtyText(volume)) : null}
    </tr>
  );
});

const toMap = (levels: readonly LadderLevel[] | undefined) => {
  const map = new Map<number, number>();
  if (levels) for (const l of levels) map.set(priceKey(l.price), l.size);
  return map;
};

interface LadderToolbarProps {
  start: ReactNode;
  ric: string | undefined;
  quantityText: string;
  invalidQuantity: boolean;
  onQuantityText: (e: ChangeEvent<HTMLInputElement>) => void;
  tradeMode: PriceLadderTradeMode;
  setTradeMode: (mode: PriceLadderTradeMode) => void;
  autoCentre: boolean;
  setAutoCentre: (autoCentre: boolean) => void;
  recentre: () => void;
  onCancelAll?: () => void;
  cancelAllDisabled: boolean;
}

/**
 * Memoized: the ladder re-renders on every depth / price tick, the toolbar's
 * Salt components only when its own props change.
 */
const LadderToolbar = memo(function LadderToolbar({
  autoCentre,
  cancelAllDisabled,
  invalidQuantity,
  onCancelAll,
  onQuantityText,
  quantityText,
  recentre,
  ric,
  setAutoCentre,
  setTradeMode,
  start,
  tradeMode,
}: LadderToolbarProps) {
  return (
    <div className={`${classBase}-toolbar`}>
      {start}
      <span className={`${classBase}-ric`}>{ric ?? ""}</span>
      <span className={`${classBase}-qtyLabel`}>
        <span aria-hidden>Qty</span>
        <Input
          className={`${classBase}-qtyInput`}
          inputProps={{
            "aria-label": "Order quantity",
            inputMode: "numeric",
            "aria-invalid": invalidQuantity || undefined,
          }}
          value={quantityText}
          onChange={onQuantityText}
          validationStatus={invalidQuantity ? "error" : undefined}
        />
      </span>
      <ToggleButtonGroup
        aria-label="Trade mode"
        value={tradeMode}
        onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
          setTradeMode(e.currentTarget.value as PriceLadderTradeMode)
        }
      >
        <ToggleButton value="confirm">Confirm</ToggleButton>
        <ToggleButton value="one-click">1-click</ToggleButton>
      </ToggleButtonGroup>
      <Tooltip content="Auto-centre on mid / last (L)">
        <ToggleButton
          aria-label="Auto-centre"
          selected={autoCentre}
          value="auto-centre"
          onChange={() => setAutoCentre(!autoCentre)}
        >
          Auto
        </ToggleButton>
      </Tooltip>
      <Button appearance="bordered" onClick={recentre} aria-label="Centre (C)">
        Centre
      </Button>
      {onCancelAll ? (
        <Button
          appearance="bordered"
          sentiment="negative"
          onClick={onCancelAll}
          disabled={cancelAllDisabled}
        >
          Cancel all
        </Button>
      ) : null}
    </div>
  );
});

const useControlled = <T,>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T) => void] => {
  const [state, setState] = useState(defaultValue);
  const current = value === undefined ? state : value;
  const set = useCallback(
    (next: T) => {
      if (value === undefined) setState(next);
      onChange?.(next);
    },
    [value, onChange],
  );
  return [current, set];
};

interface DragState {
  side: Side;
  fromPrice: number;
  orders: OwnOrder[];
  /** pointer = mouse drag, keyboard = M to pick up, arrows, Enter to drop. */
  via: "pointer" | "keyboard";
}

/**
 * Presentational price ladder (DOM): one row per tick around a centre price;
 * columns own bids | bid qty | price | ask qty | own offers (| volume).
 * Holds the UI state (centre, cursor, auto-centre, confirm, drag) and emits
 * intents (`onTrade`, `onAmendOrders`, `onCancelOrders`, `onCancelAll`).
 * Rows are recycled by slot and memoised, so an update re-renders only rows
 * whose values changed. `PriceLadder` binds it to live data and RPCs.
 */
export const PriceLadderView = forwardRef<HTMLDivElement, PriceLadderViewProps>(
  function PriceLadderView(
    {
      asks,
      autoCentre: autoCentreProp,
      bids,
      className,
      defaultAutoCentre = true,
      defaultQuantity,
      defaultTradeMode = "confirm",
      disabledReason,
      last,
      lotSize = 1,
      onAmendOrders,
      onAutoCentreChange,
      onCancelAll,
      onCancelOrders,
      onQuantityChange,
      onTrade,
      onTradeModeChange,
      ownOrders,
      priceFormat,
      quantity: quantityProp,
      referencePrice,
      ric,
      rowCount: rowCountProp,
      showVolume = false,
      status,
      toolbarStart,
      statusKind = "info",
      tickSchedule,
      tradeMode: tradeModeProp,
      tradedVolume,
      tradingEnabled = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-price-ladder",
      css: priceLadderCss,
      window: targetWindow,
    });
    const gridId = useId().replace(/:/g, "");
    const helpId = `${gridId}-help`;

    const initialQuantity =
      defaultQuantity ?? roundToLot(Math.max(100, lotSize), lotSize, "up");
    const [quantity, setQuantity] = useControlled(
      quantityProp,
      initialQuantity,
      onQuantityChange,
    );
    const [quantityText, setQuantityText] = useState(String(quantity));
    useEffect(() => setQuantityText(String(quantity)), [quantity]);
    const [tradeMode, setTradeMode] = useControlled(
      tradeModeProp,
      defaultTradeMode,
      onTradeModeChange,
    );
    const [autoCentre, setAutoCentre] = useControlled(
      autoCentreProp,
      defaultAutoCentre,
      onAutoCentreChange,
    );

    // measure how many rows fit
    const bodyRef = useRef<HTMLTableSectionElement>(null);
    const [measuredRows, setMeasuredRows] = useState<number>();
    useLayoutEffect(() => {
      const body = bodyRef.current;
      if (rowCountProp !== undefined || !body) return;
      const measure = () => {
        const height = body.clientHeight;
        const row = body.querySelector<HTMLElement>(`.${classBase}-row`);
        const rowHeight = row?.offsetHeight || FALLBACK_ROW_HEIGHT;
        if (height > 0) {
          setMeasuredRows(Math.max(5, Math.floor(height / rowHeight)));
        }
      };
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(measure);
      observer.observe(body);
      return () => observer.disconnect();
    }, [rowCountProp]);
    const rowCount = rowCountProp ?? measuredRows ?? DEFAULT_ROWS;

    const bidMap = useMemo(() => toMap(bids), [bids]);
    const askMap = useMemo(() => toMap(asks), [asks]);
    const bestBid = bids?.[0]?.price;
    const bestAsk = asks?.[0]?.price;

    const reference = tickSchedule
      ? ladderReferencePrice(tickSchedule, {
          bestBid,
          bestAsk,
          last,
          fallback: referencePrice,
        })
      : undefined;

    // centre price: follows the reference while auto-centring
    const [centre, setCentre] = useState<number>();
    const [cursor, setCursor] = useState<{ price: number; col: number }>();
    const [drag, setDrag] = useState<DragState>();
    const [dropPrice, setDropPrice] = useState<number>();
    const [pending, setPending] = useState<LadderTradeIntent>();
    const effectiveCentre = centre ?? reference;
    const prices = useMemo(
      () =>
        tickSchedule && effectiveCentre !== undefined
          ? ladderPrices(effectiveCentre, tickSchedule, rowCount)
          : [],
      [effectiveCentre, tickSchedule, rowCount],
    );
    // (manual mode keeps the first centre until scrolled / re-centred)
    if (
      reference !== undefined &&
      !drag &&
      (centre === undefined || (autoCentre && needsRecentre(prices, reference)))
    ) {
      setCentre(reference);
    }

    // reset when the instrument changes
    const lastRic = useRef(ric);
    if (lastRic.current !== ric) {
      lastRic.current = ric;
      setCentre(undefined);
      setCursor(undefined);
      setDrag(undefined);
      setDropPrice(undefined);
      setPending(undefined);
    }

    const visibleColumns = showVolume ? COLUMNS : COLUMNS.slice(0, 5);
    const priceCol = COLUMNS.indexOf("price");
    const fmt = useCallback(
      (p: number) => formatPrice(p, priceFormat ?? {}),
      [priceFormat],
    );

    // the reference moves with every tick: read it at call time so recentre
    // (a toolbar prop) stays stable
    const referenceRef = useRef(reference);
    referenceRef.current = reference;
    const recentre = useCallback(() => {
      const target = referenceRef.current;
      if (target !== undefined) {
        setCentre(target);
        setCursor((c) => ({ price: target, col: c?.col ?? priceCol }));
      }
    }, [priceCol]);

    const scrollBy = useCallback(
      (ticks: number) => {
        if (!tickSchedule || effectiveCentre === undefined) return;
        setAutoCentre(false);
        setCentre(stepTicks(effectiveCentre, tickSchedule, ticks));
      },
      [tickSchedule, effectiveCentre, setAutoCentre],
    );

    const requestTrade = useCallback(
      (side: Side, price: number) => {
        if (!tradingEnabled || !(quantity > 0)) return;
        const intent = { side, price, quantity };
        if (tradeMode === "one-click") onTrade?.(intent);
        else setPending(intent);
      },
      [tradingEnabled, quantity, tradeMode, onTrade],
    );
    const confirmPending = useCallback(() => {
      if (pending) onTrade?.(pending);
      setPending(undefined);
    }, [pending, onTrade]);

    const ownAt = useCallback(
      (side: Side, price: number) =>
        ownOrders?.get(ownOrdersKey(side, price))?.orders,
      [ownOrders],
    );
    const cancelAt = useCallback(
      (price: number, side?: Side) => {
        const orders = [
          ...(side !== Side.Sell
            ? actionableOrders(ownAt(Side.Buy, price))
            : []),
          ...(side !== Side.Buy
            ? actionableOrders(ownAt(Side.Sell, price))
            : []),
        ];
        if (orders.length) onCancelOrders?.(orders, price);
      },
      [ownAt, onCancelOrders],
    );
    const dropOn = useCallback(
      (price: number | undefined) => {
        if (drag && price !== undefined && price !== drag.fromPrice) {
          onAmendOrders?.(drag.orders, price);
        }
        setDrag(undefined);
        setDropPrice(undefined);
      },
      [drag, onAmendOrders],
    );

    // pointer drag: own order cell -> another row
    useEffect(() => {
      if (drag?.via !== "pointer") return;
      const doc = targetWindow?.document ?? document;
      const end = () => {
        setDrag(undefined);
        setDropPrice(undefined);
      };
      doc.addEventListener("pointerup", end);
      return () => doc.removeEventListener("pointerup", end);
    }, [drag, targetWindow]);

    const rowPrice = (target: EventTarget | null) => {
      const row = (target as HTMLElement | null)?.closest?.<HTMLElement>(
        `.${classBase}-row`,
      );
      return row ? Number(row.dataset.price) : undefined;
    };
    const cellCol = (target: EventTarget | null) =>
      (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-col]")
        ?.dataset.col as PriceLadderColumn | undefined;

    const handleClick = (e: MouseEvent) => {
      const price = rowPrice(e.target);
      const col = cellCol(e.target);
      if (price === undefined || !col) return;
      setCursor({ price, col: COLUMNS.indexOf(col) });
      if (col === "bid") requestTrade(Side.Buy, price);
      else if (col === "ask") requestTrade(Side.Sell, price);
    };
    const handleDoubleClick = (e: MouseEvent) => {
      // double click own orders: cancel at level
      const price = rowPrice(e.target);
      const col = cellCol(e.target);
      if (price === undefined) return;
      if (col === "ownBuy") cancelAt(price, Side.Buy);
      else if (col === "ownSell") cancelAt(price, Side.Sell);
    };
    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const price = rowPrice(e.target);
      const col = cellCol(e.target);
      if (price === undefined || (col !== "ownBuy" && col !== "ownSell")) {
        return;
      }
      const side = col === "ownBuy" ? Side.Buy : Side.Sell;
      const orders = actionableOrders(ownAt(side, price));
      if (orders.length === 0) return;
      e.preventDefault();
      setDrag({ side, fromPrice: price, orders, via: "pointer" });
      setDropPrice(price);
    };
    const handlePointerOver = (e: PointerEvent) => {
      if (drag?.via !== "pointer") return;
      const price = rowPrice(e.target);
      if (price !== undefined) setDropPrice(price);
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (drag?.via !== "pointer") return;
      dropOn(rowPrice(e.target) ?? dropPrice);
    };
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      scrollBy(e.deltaY > 0 ? -WHEEL_TICKS : WHEEL_TICKS);
    };

    const moveCursor = (ticks: number) => {
      if (!tickSchedule) return;
      const from = cursor?.price ?? prices[centreIndex(prices.length)];
      if (from === undefined) return;
      const next = stepTicks(from, tickSchedule, ticks);
      setCursor({ price: next, col: cursor?.col ?? priceCol });
      if (drag?.via === "keyboard") setDropPrice(next);
      const top = prices[0];
      const bottom = prices[prices.length - 1];
      if (next > top || next < bottom) scrollBy(ticks);
    };
    const moveColumn = (delta: number) => {
      const current = cursor?.col ?? priceCol;
      const next = Math.max(
        0,
        Math.min(visibleColumns.length - 1, current + delta),
      );
      const price = cursor?.price ?? prices[centreIndex(prices.length)];
      if (price !== undefined) setCursor({ price, col: next });
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
      if (e.target !== e.currentTarget) return;
      const price = cursor?.price ?? prices[centreIndex(prices.length)];
      const col = COLUMNS[cursor?.col ?? priceCol];
      let handled = true;
      switch (e.key) {
        case "ArrowUp":
          moveCursor(e.shiftKey ? 5 : 1);
          break;
        case "ArrowDown":
          moveCursor(e.shiftKey ? -5 : -1);
          break;
        case "ArrowLeft":
          moveColumn(-1);
          break;
        case "ArrowRight":
          moveColumn(1);
          break;
        case "PageUp":
          moveCursor(Math.max(1, Math.floor(rowCount / 2)));
          break;
        case "PageDown":
          moveCursor(-Math.max(1, Math.floor(rowCount / 2)));
          break;
        case "b":
        case "B":
          if (price !== undefined) requestTrade(Side.Buy, price);
          break;
        case "s":
        case "S":
          if (price !== undefined) requestTrade(Side.Sell, price);
          break;
        case "c":
        case "C":
          recentre();
          break;
        case "l":
        case "L":
          setAutoCentre(!autoCentre);
          break;
        case "m":
        case "M": {
          if (price === undefined) break;
          const side =
            col === "ownSell" || col === "ask"
              ? Side.Sell
              : col === "ownBuy" || col === "bid"
                ? Side.Buy
                : undefined;
          const candidates = (side ? [side] : [Side.Buy, Side.Sell])
            .map((s) => ({ s, orders: actionableOrders(ownAt(s, price)) }))
            .find(({ orders }) => orders.length > 0);
          if (candidates) {
            setDrag({
              side: candidates.s,
              fromPrice: price,
              orders: candidates.orders,
              via: "keyboard",
            });
            setDropPrice(price);
          }
          break;
        }
        case "Delete":
        case "Backspace":
          if (price !== undefined) {
            cancelAt(
              price,
              col === "ownBuy"
                ? Side.Buy
                : col === "ownSell"
                  ? Side.Sell
                  : undefined,
            );
          }
          break;
        case "Enter":
        case " ":
          if (drag?.via === "keyboard") dropOn(dropPrice);
          else if (pending) confirmPending();
          else if (price !== undefined && col === "bid")
            requestTrade(Side.Buy, price);
          else if (price !== undefined && col === "ask")
            requestTrade(Side.Sell, price);
          break;
        case "Escape":
          if (drag) {
            setDrag(undefined);
            setDropPrice(undefined);
          } else if (pending) setPending(undefined);
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const handleFocus = (e: FocusEvent<HTMLTableElement>) => {
      if (e.target === e.currentTarget && !cursor) {
        const price = prices[centreIndex(prices.length)];
        if (price !== undefined) setCursor({ price, col: priceCol });
      }
    };

    // derived per-row props
    const maxQty = useMemo(() => {
      let max = 1;
      for (const v of bidMap.values()) max = Math.max(max, v);
      for (const v of askMap.values()) max = Math.max(max, v);
      return max;
    }, [bidMap, askMap]);
    const lastKey = last !== undefined ? priceKey(last) : undefined;
    const cursorKey = cursor ? priceKey(cursor.price) : undefined;
    const dropKey =
      drag && dropPrice !== undefined ? priceKey(dropPrice) : undefined;
    const movingKey = drag ? priceKey(drag.fromPrice) : undefined;
    let activeDescendant: string | undefined;

    const rows = prices.map((price, slot) => {
      const key = priceKey(price);
      const ownBuy = ownOrders?.get(ownOrdersKey(Side.Buy, price));
      const ownSell = ownOrders?.get(ownOrdersKey(Side.Sell, price));
      const cursorCol = cursorKey === key ? (cursor?.col ?? -1) : -1;
      if (cursorCol >= 0) {
        activeDescendant = cellId(gridId, slot, COLUMNS[cursorCol]);
      }
      return (
        <LadderRow
          // rows are recycled by slot (position), prices scroll through them
          // biome-ignore lint/suspicious/noArrayIndexKey: slot identity is intended
          key={slot}
          gridId={gridId}
          slot={slot}
          price={price}
          priceText={price > 0 ? fmt(price) : ""}
          bidQty={bidMap.get(key) ?? 0}
          askQty={askMap.get(key) ?? 0}
          ownBuyQty={ownBuy?.quantity ?? 0}
          ownBuyCount={ownBuy?.orders.length ?? 0}
          ownSellQty={ownSell?.quantity ?? 0}
          ownSellCount={ownSell?.orders.length ?? 0}
          volume={tradedVolume?.get(key) ?? 0}
          maxQty={maxQty}
          showVolume={showVolume}
          bestBid={bestBid !== undefined && key === priceKey(bestBid)}
          bestAsk={bestAsk !== undefined && key === priceKey(bestAsk)}
          ltp={key === lastKey}
          inSpread={
            bestBid !== undefined &&
            bestAsk !== undefined &&
            price > bestBid &&
            price < bestAsk
          }
          cursorCol={cursorCol}
          dropTarget={key === dropKey && key !== movingKey}
          moving={key === movingKey}
        />
      );
    });

    const sideText = (side: Side) => (side === Side.Buy ? "Buy" : "Sell");
    const handleQuantity = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        setQuantityText(text);
        const value = Number(text.replace(/,/g, ""));
        if (Number.isFinite(value) && value > 0) setQuantity(value);
      },
      [setQuantity],
    );
    const invalidQuantity =
      !(quantity > 0) ||
      Math.abs(quantity / lotSize - Math.round(quantity / lotSize)) > 1e-9;

    let message: ReactNode = null;
    if (!tickSchedule) {
      message = ric ? "Waiting for prices…" : "Select an instrument";
    } else if (effectiveCentre === undefined) {
      message = "Waiting for prices…";
    }

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-trade-mode={tradeMode}
        data-auto-centre={autoCentre || undefined}
        data-dragging={drag ? drag.via : undefined}
        ref={ref}
      >
        <LadderToolbar
          autoCentre={autoCentre}
          cancelAllDisabled={!ownOrders || ownOrders.size === 0}
          invalidQuantity={invalidQuantity}
          onCancelAll={onCancelAll}
          onQuantityText={handleQuantity}
          quantityText={quantityText}
          recentre={recentre}
          ric={ric}
          setAutoCentre={setAutoCentre}
          setTradeMode={setTradeMode}
          start={toolbarStart}
          tradeMode={tradeMode}
        />
        {pending ? (
          <fieldset
            className={`${classBase}-confirm`}
            aria-label="Confirm order"
            data-side={pending.side}
          >
            <span aria-live="assertive">
              {sideText(pending.side)} {formatQuantity(pending.quantity)} {ric}{" "}
              @ {fmt(pending.price)}?
            </span>
            <Button
              appearance="solid"
              sentiment={pending.side === Side.Buy ? "positive" : "negative"}
              onClick={confirmPending}
            >
              {sideText(pending.side)}
            </Button>
            <Button
              appearance="transparent"
              onClick={() => setPending(undefined)}
            >
              Cancel
            </Button>
          </fieldset>
        ) : null}
        <table
          className={`${classBase}-grid`}
          role="grid"
          aria-label={`Price ladder ${ric ?? ""}`.trim()}
          aria-describedby={helpId}
          aria-rowcount={prices.length + 1}
          aria-colcount={visibleColumns.length}
          aria-activedescendant={activeDescendant}
          aria-busy={message ? true : undefined}
          tabIndex={0}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerOver={handlePointerOver}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          data-columns={visibleColumns.length}
        >
          <thead>
            <tr className={`${classBase}-header`} aria-rowindex={1}>
              {visibleColumns.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className={cx(`${classBase}-cell`, `${classBase}-${col}`)}
                >
                  {COLUMN_LABELS[col]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={`${classBase}-body`} ref={bodyRef}>
            {message ? (
              <tr>
                <td
                  className={`${classBase}-message`}
                  colSpan={visibleColumns.length}
                >
                  {message}
                </td>
              </tr>
            ) : (
              rows
            )}
          </tbody>
        </table>
        <output
          className={`${classBase}-status`}
          role={statusKind === "error" ? "alert" : undefined}
          aria-live={statusKind === "error" ? "assertive" : "polite"}
          data-kind={statusKind}
        >
          {drag?.via === "keyboard"
            ? `Moving ${sideText(drag.side).toLowerCase()} orders from ${fmt(drag.fromPrice)}${dropPrice !== undefined ? ` to ${fmt(dropPrice)}` : ""}: Enter to amend, Escape to cancel`
            : pending
              ? "Enter to confirm, Escape to cancel"
              : !tradingEnabled && disabledReason
                ? disabledReason
                : status}
        </output>
        <div id={helpId} className={`${classBase}-help`}>
          Up and down arrows move the price cursor, left and right change
          column. B buys and S sells at the cursor price, Enter on the bid or
          ask column trades. Delete cancels my orders at the cursor price. M
          picks up my orders to move them, then arrows and Enter amend. C
          centres, L toggles auto-centre.
        </div>
      </div>
    );
  },
);
