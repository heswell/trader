import { Side } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useMemo } from "react";
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { filterString } from "../../utils/filters";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { sideColour } from "../../utils/colours";
import { formatPrice, formatQuantity } from "../../utils/formatting";
import { formatTime } from "../../utils/time";
import {
  InstrumentLookupProvider,
  useInstrumentLookup,
} from "../InstrumentLookup";

import tradeTapeCss from "./TradeTape.css";

const classBase = "tradingTradeTape";

export interface TradeTapeProps
  extends HTMLAttributes<HTMLDivElement>,
    LinkGroupProps {
  /** Instrument to show. Defaults to the selected instrument. */
  ric?: string;
  /** Maximum rows kept and rendered (newest first). Default 100. */
  maxRows?: number;
  /** Trades with size >= this are highlighted (absolute). */
  largeSizeThreshold?: number;
  /**
   * Otherwise highlight sizes at or above this percentile (0-100) of the
   * trades currently shown. Default 90.
   */
  largeSizePercentile?: number;
  /** Show times in UTC instead of local. Default false. */
  utc?: boolean;
}

/** Size at the given percentile of `sizes` (nearest rank). */
export const sizePercentile = (
  sizes: readonly number[],
  percentile: number,
) => {
  if (sizes.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...sizes].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
};

const Inner = forwardRef<HTMLDivElement, TradeTapeProps>(
  function TradeTapeInner(
    {
      className,
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      showLinkGroupSelector = false,
      largeSizePercentile = 90,
      largeSizeThreshold,
      maxRows = 100,
      ric: ricProp,
      utc = false,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-trade-tape",
      css: tradeTapeCss,
      window: targetWindow,
    });
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `TradeTape:${htmlAttributes.id}`
        : "TradeTape",
    });
    const { selectedInstrument } = useSelectedInstrument({
      linkGroup: channel,
    });
    const lookup = useInstrumentLookup();
    const ric = ricProp ?? selectedInstrument?.ric;

    const dataSource = useTradingDataSource("trades", {
      columns: [
        "tradeId",
        "ric",
        "price",
        "size",
        "aggressorSide",
        "timestamp",
        "seq",
      ],
      sort: { sortDefs: [{ column: "seq", sortType: "D" }] },
    });
    const { rows: records } = useDataSourceRows(dataSource, {
      rowCount: maxRows,
      filter: ric ? `ric = ${filterString(ric)}` : 'ric = "-"',
    });
    // drop rows of the previous instrument until the filtered rows arrive
    const trades = useMemo(
      () => (ric ? records.filter((r) => r.ric === ric).slice(0, maxRows) : []),
      [records, ric, maxRows],
    );
    const threshold = useMemo(
      () =>
        largeSizeThreshold ??
        sizePercentile(
          trades.map((t) => Number(t.size)),
          largeSizePercentile,
        ),
      [trades, largeSizeThreshold, largeSizePercentile],
    );
    const instrument = ric ? lookup.get(ric) : undefined;

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        data-testid="trading-trade-tape"
        ref={ref}
      >
        {showLinkGroupSelector ? (
          <div className={`${classBase}-toolbar`}>
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
            <span className={`${classBase}-ric`}>{ric}</span>
          </div>
        ) : null}
        <div aria-hidden="true" className={`${classBase}-header`}>
          <span>Time</span>
          <span>Price</span>
          <span>Size</span>
          <span>Side</span>
        </div>
        <div
          aria-label={ric ? `Trades in ${ric}` : "Trades"}
          className={`${classBase}-rows`}
          role="log"
        >
          {ric ? null : (
            <div className={`${classBase}-empty`}>Select an instrument</div>
          )}
          {trades.map((t) => {
            const size = Number(t.size);
            const aggressor = String(t.aggressorSide);
            return (
              <div
                className={`${classBase}-row`}
                data-aggressor={aggressor}
                data-large={size >= threshold}
                key={t.$key}
              >
                <span>{formatTime(t.timestamp, { utc })}</span>
                <span
                  className={`${classBase}-price`}
                  style={{ color: sideColour(aggressor) }}
                >
                  {formatPrice(Number(t.price), instrument)}
                </span>
                <span className={`${classBase}-size`}>
                  {formatQuantity(size)}
                </span>
                <span>
                  {aggressor === Side.Buy
                    ? "▲ Buy"
                    : aggressor === Side.Sell
                      ? "▼ Sell"
                      : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

/**
 * Time & sales tape on `trades` for one instrument (the `ric` prop or the
 * selected instrument), newest first, bounded to `maxRows`. Updates are
 * coalesced to one render per animation frame. Aggressor side is shown by
 * arrow and text as well as colour; large trades are highlighted.
 */
export const TradeTape = forwardRef<HTMLDivElement, TradeTapeProps>(
  function TradeTape(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
