import {
  Side,
  type TickSchedule,
  TradingPhase,
  ticksBetween,
} from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useMemo,
} from "react";
import { levelKey, useLevelFlash } from "../../hooks/useLevelFlash";
import {
  type DepthLevel,
  type InstrumentPrice,
  useFollowedInstrument,
  useMarketDepth,
} from "../../hooks/useMarketData";
import {
  ownOrdersKey,
  useOwnWorkingOrders,
} from "../../hooks/useOwnWorkingOrders";
import { formatPrice, formatQuantity } from "../../utils/formatting";
import {
  instrumentTickSchedule,
  isInactivePhase,
  tradingPhaseText,
} from "../../utils/marketData";
import marketDepthCss from "./MarketDepth.css";

const classBase = "tradingMarketDepth";

export interface MarketDepthLevelClick {
  side: Side;
  price: number;
  level: number;
}

export interface MarketDepthProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Instrument to show; defaults to the selected instrument. */
  ric?: string;
  /** Levels per side, 1-10 (the exchange publishes depthLevels = 10). Default 10. */
  levels?: number;
  /** Show own working orders at each price. Default true. */
  showOwnOrders?: boolean;
  /** Restrict own orders to one account (default: all visible accounts). */
  account?: string;
  /** Flash a level when its quantity changes. Default true. */
  flash?: boolean;
  /** Show the cumulative-quantity depth bars. Default true. */
  showDepthBars?: boolean;
  /** A price was clicked / activated (e.g. to prefill an order ticket). */
  onLevelClick?: (level: MarketDepthLevelClick) => void;
}

const decimalsIn = (text: string) => {
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
};

const spreadInfo = (
  bid: number | undefined,
  ask: number | undefined,
  instrument: InstrumentPrice | undefined,
  schedule: TickSchedule | undefined,
) => {
  if (bid === undefined || ask === undefined) return undefined;
  const decimals = decimalsIn(formatPrice(bid, instrument ?? {}));
  return {
    spread: formatPrice(ask - bid, { priceDecimals: decimals }),
    ticks: schedule ? ticksBetween(bid, ask, schedule) : undefined,
    mid: formatPrice((ask + bid) / 2, { priceDecimals: decimals + 1 }),
  };
};

/** Bid cells run orders | qty | price (outside-in); ask cells mirror it. */
const cells = (isBid: boolean, [orders, qty, price]: ReactNode[]) =>
  isBid ? [orders, qty, price] : [price, qty, orders];

/**
 * Aggregated market depth (EXCHANGE `depth`) for the selected instrument (or
 * `ric`): bids and asks side by side, best first, with order count,
 * quantity, price, cumulative depth bars, own working orders and change
 * flashes, plus a spread / mid summary and the trading phase.
 */
export const MarketDepth = forwardRef<HTMLDivElement, MarketDepthProps>(
  function MarketDepth(
    {
      account,
      className,
      flash = true,
      levels: levelsProp = 10,
      onLevelClick,
      ric: ricProp,
      showDepthBars = true,
      showOwnOrders = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-market-depth",
      css: marketDepthCss,
      window: targetWindow,
    });
    const levels = Math.max(1, Math.min(Math.trunc(levelsProp), 10));
    const { ric, instrument } = useFollowedInstrument(ricProp);
    const { bids, asks, loaded, version } = useMarketDepth(ric, { levels });
    const own = useOwnWorkingOrders(showOwnOrders ? ric : undefined, {
      account,
    });
    const allLevels = useMemo(() => [...bids, ...asks], [bids, asks]);
    const flashes = useLevelFlash(allLevels, version, ric);
    const schedule = useMemo(
      () => instrumentTickSchedule(instrument),
      [instrument],
    );

    const phase = instrument?.phase;
    const inactive = isInactivePhase(phase);
    const maxCum = Math.max(
      bids[bids.length - 1]?.cumSize ?? 0,
      asks[asks.length - 1]?.cumSize ?? 0,
      1,
    );
    const spread = spreadInfo(
      bids[0]?.price,
      asks[0]?.price,
      instrument,
      schedule,
    );
    const fmtPrice = (p: number) => formatPrice(p, instrument ?? {});

    const activate = (side: Side, level: DepthLevel) =>
      onLevelClick?.({ side, price: level.price, level: level.level });

    const renderSide = (side: Side, level: DepthLevel | undefined) => {
      const isBid = side === Side.Buy;
      const sideClass = `${classBase}-${isBid ? "bid" : "ask"}`;
      const sideLabel = isBid ? "Bid" : "Ask";
      if (!level) {
        return cells(isBid, [
          <td key={`${side}-orders`} className={sideClass} data-empty />,
          <td key={`${side}-qty`} className={sideClass} data-empty />,
          <td
            key={`${side}-price`}
            className={cx(sideClass, `${classBase}-price`)}
            data-empty
          />,
        ]);
      }
      const levelFlash = flash
        ? flashes.get(levelKey(side, level.price))
        : undefined;
      const ownAtPrice = own.byPrice.get(ownOrdersKey(side, level.price));
      const price = fmtPrice(level.price);
      return cells(isBid, [
        <td
          key={`${side}-orders`}
          className={cx(sideClass, `${classBase}-orders`)}
          aria-label={`${level.orderCount} orders`}
        >
          {level.orderCount}
        </td>,
        <td
          key={`${side}-qty`}
          className={cx(sideClass, `${classBase}-qty`)}
          data-own={ownAtPrice ? true : undefined}
        >
          {ownAtPrice ? (
            <span
              className={`${classBase}-ownMarker`}
              title={`Own: ${ownAtPrice.orders.length} order(s), ${formatQuantity(ownAtPrice.quantity)}`}
            >
              <span className={`${classBase}-srOnly`}>own </span>
              {formatQuantity(ownAtPrice.quantity, { compact: true })}
            </span>
          ) : null}
          <span className={`${classBase}-size`}>
            {formatQuantity(level.size)}
          </span>
        </td>,
        <td
          key={`${side}-price`}
          className={cx(sideClass, `${classBase}-price`)}
          data-level={level.level}
        >
          {showDepthBars ? (
            <span
              aria-hidden
              className={`${classBase}-bar`}
              style={{ width: `calc(50% * ${level.cumSize / maxCum})` }}
            />
          ) : null}
          {levelFlash ? (
            <span
              aria-hidden
              className={`${classBase}-flash`}
              data-flash={levelFlash.direction}
              key={levelFlash.seq}
            />
          ) : null}
          {onLevelClick ? (
            <button
              type="button"
              className={`${classBase}-priceText`}
              aria-label={`${sideLabel} ${price}`}
              onClick={() => activate(side, level)}
            >
              {price}
            </button>
          ) : (
            <span className={`${classBase}-priceText`}>{price}</span>
          )}
        </td>,
      ]);
    };

    let body: ReactNode;
    if (!ric) {
      body = <div className={`${classBase}-message`}>Select an instrument</div>;
    } else if (loaded && bids.length === 0 && asks.length === 0) {
      body = (
        <output className={`${classBase}-message`}>
          {inactive && phase
            ? tradingPhaseText[phase]
            : "No orders in the book"}
        </output>
      );
    } else {
      const rows: ReactNode[] = [];
      for (let i = 0; i < levels; i++) {
        rows.push(
          <tr
            className={`${classBase}-row`}
            // rows are depth levels (slots), so the index is the identity
            key={`level-${i}`}
            data-level={i}
          >
            {renderSide(Side.Buy, bids[i])}
            {renderSide(Side.Sell, asks[i])}
          </tr>,
        );
      }
      const header = (isBid: boolean) => {
        const sideClass = `${classBase}-${isBid ? "bid" : "ask"}`;
        return cells(isBid, [
          <th key={`${isBid}-orders`} scope="col" className={sideClass}>
            Orders
          </th>,
          <th key={`${isBid}-qty`} scope="col" className={sideClass}>
            {isBid ? "Bid qty" : "Ask qty"}
          </th>,
          <th
            key={`${isBid}-price`}
            scope="col"
            className={cx(sideClass, `${classBase}-price`)}
          >
            {isBid ? "Bid" : "Ask"}
          </th>,
        ]);
      };
      body = (
        <table
          className={`${classBase}-table`}
          aria-label={`Market depth ${ric}`}
          aria-busy={!loaded || undefined}
        >
          <thead>
            <tr className={`${classBase}-header`}>
              {header(true)}
              {header(false)}
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      );
    }

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-phase={phase}
        data-inactive={inactive || undefined}
        ref={ref}
      >
        {ric ? (
          <div className={`${classBase}-summary`}>
            <span className={`${classBase}-ric`}>{ric}</span>
            {spread ? (
              <span className={`${classBase}-spread`}>
                Spread {spread.spread}
                {spread.ticks !== undefined ? (
                  <abbr title={`${spread.ticks} ticks`}>
                    {` (${spread.ticks}t)`}
                  </abbr>
                ) : null}{" "}
                · Mid {spread.mid}
              </span>
            ) : bids.length || asks.length ? (
              <span className={`${classBase}-spread`}>One-sided book</span>
            ) : null}
            {phase && phase !== TradingPhase.Continuous ? (
              <output className={`${classBase}-phase`} aria-live="polite">
                {tradingPhaseText[phase] ?? phase}
              </output>
            ) : null}
          </div>
        ) : null}
        {body}
      </div>
    );
  },
);
