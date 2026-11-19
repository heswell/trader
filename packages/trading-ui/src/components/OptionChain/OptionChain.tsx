import { InstrumentType, Side } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import { formatPrice } from "../../utils/formatting";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { useOrderTicketLauncher } from "../OrderTicket/OrderTicketLauncher";
import {
  atmStrike,
  type ChainOption,
  type ChainStrike,
  formatExpiry,
} from "./optionChainModel";
import { useOptionChain } from "./useOptionChain";

import optionChainCss from "./OptionChain.css";

const classBase = "tradingOptionChain";

/** Notification / selection source id of OptionChain. */
export const OPTION_CHAIN_SOURCE = "OptionChain";

/** The quote cells of a row, left to right: call bid / ask, put bid / ask. */
const CELLS = [
  { right: "call", side: Side.Sell, quote: "bid" },
  { right: "call", side: Side.Buy, quote: "ask" },
  { right: "put", side: Side.Sell, quote: "bid" },
  { right: "put", side: Side.Buy, quote: "ask" },
] as const;
type CellIndex = 0 | 1 | 2 | 3;

export interface OptionChainProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /**
   * The underlying (a ric, or its root). Default: follow the link group's
   * selected instrument - a stock or index, or the underlying of an option
   * or future.
   */
  underlying?: string;
  /** Called when the user picks an option (click, Enter). */
  onSelect?: (option: ChainOption) => void;
  /**
   * Open the order ticket (OrderTicketLauncher) on Enter / click of a
   * liquid bid (Sell) or ask (Buy), and on B / S. Default true.
   */
  launchOrderTicket?: boolean;
}

const pct = (vol: number | undefined) =>
  vol === undefined ? "" : `${(vol * 100).toFixed(1)}%`;
const greek = (n: number | undefined) => (n === undefined ? "" : n.toFixed(2));

/** The underlying a selected instrument implies (see OptionChainProps). */
const useLinkedUnderlying = (ric: string | undefined) => {
  const { rows } = useTradingRows("instruments", {
    columns: ["ric", "instrumentType", "underlying"],
    enabled: !!ric,
    filter: ric ? `ric = ${filterString(ric)}` : undefined,
    rowCount: 1,
  });
  const row = rows[0];
  if (!ric || row?.ric !== ric) return undefined;
  const type = row.instrumentType;
  return (type === InstrumentType.Option ||
    type === InstrumentType.Future ||
    type === InstrumentType.Continuation) &&
    row.underlying
    ? String(row.underlying)
    : ric;
};

/**
 * An option chain: one expiry at a time (tabs), strikes down the middle,
 * calls on the left and puts on the right with bid, ask, implied vol and
 * delta. Liquid strikes (with a book) are highlighted and trade from the
 * chain; quote-only strikes are dimmed, show model prices and take no
 * orders. The at-the-money strike is marked.
 *
 * Keyboard: arrows move between the quotes (↑ / ↓ strikes, ← / → call bid,
 * call ask, put bid, put ask), Page Up / Page Down change expiry, Enter
 * picks the option (and on a liquid strike opens the ticket: Sell at the
 * bid, Buy at the ask), B / S open a Buy / Sell ticket.
 */
export const OptionChain = forwardRef<HTMLDivElement, OptionChainProps>(
  function OptionChain(
    {
      className,
      defaultLinkGroup,
      launchOrderTicket = true,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      onSelect,
      showLinkGroupSelector = false,
      underlying: underlyingProp,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-option-chain",
      css: optionChainCss,
      window: targetWindow,
    });
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `${OPTION_CHAIN_SOURCE}:${htmlAttributes.id}`
        : OPTION_CHAIN_SOURCE,
    });
    const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument(
      { linkGroup: channel },
    );
    const selectedRic = selectedInstrument?.ric;
    const linkedUnderlying = useLinkedUnderlying(
      underlyingProp ? undefined : selectedRic,
    );
    // keep the last underlying while a new selection is looked up
    const [underlying, setUnderlying] = useState(underlyingProp);
    useEffect(() => {
      const next = underlyingProp ?? linkedUnderlying;
      if (next) setUnderlying(next);
    }, [underlyingProp, linkedUnderlying]);

    const { chain, loaded } = useOptionChain(underlying);
    const [expiry, setExpiry] = useState<number>();
    const selectedOption = selectedRic
      ? chain.byRic.get(selectedRic)
      : undefined;
    // follow a selected option's expiry; else keep a listed one
    useEffect(() => {
      if (selectedOption) setExpiry(selectedOption.expiry);
    }, [selectedOption]);
    const activeExpiry =
      expiry !== undefined && chain.expiries.includes(expiry)
        ? expiry
        : chain.expiries[0];
    const strikes = useMemo<ChainStrike[]>(
      () =>
        activeExpiry === undefined
          ? []
          : (chain.strikes.get(activeExpiry) ?? []),
      [chain, activeExpiry],
    );
    const forward =
      activeExpiry === undefined ? undefined : chain.forwards.get(activeExpiry);
    const atm = atmStrike(strikes, forward);

    // roving focus: a strike and a quote cell
    const [focus, setFocus] = useState<{ strike?: number; cell: CellIndex }>({
      cell: 1,
    });
    const focusStrike =
      focus.strike !== undefined &&
      strikes.some((s) => s.strike === focus.strike)
        ? focus.strike
        : ((selectedOption?.expiry === activeExpiry
            ? selectedOption?.strike
            : undefined) ??
          atm ??
          strikes[0]?.strike);
    const tableRef = useRef<HTMLTableElement>(null);
    const focusCell = useCallback((strike: number, cell: CellIndex) => {
      setFocus({ strike, cell });
      requestAnimationFrame(() =>
        tableRef.current
          ?.querySelector<HTMLElement>(
            `[data-strike="${strike}"] [data-cell="${cell}"]`,
          )
          ?.focus(),
      );
    }, []);

    // bring the at-the-money strike into view on a new expiry / underlying
    const scrolledRef = useRef<string | undefined>(undefined);
    useEffect(() => {
      const key = `${underlying}|${activeExpiry}`;
      if (atm === undefined || scrolledRef.current === key) return;
      scrolledRef.current = key;
      tableRef.current
        ?.querySelector<HTMLElement>(`[data-strike="${atm}"]`)
        ?.scrollIntoView?.({ block: "center" });
    }, [atm, activeExpiry, underlying]);

    const launcher = useOrderTicketLauncher();
    const canLaunch = launchOrderTicket && launcher.available;
    const { openOrderTicket } = launcher;

    const pick = useCallback(
      (option: ChainOption) => {
        setSelectedInstrument(option.instrument, OPTION_CHAIN_SOURCE);
        onSelect?.(option);
      },
      [onSelect, setSelectedInstrument],
    );
    const trade = useCallback(
      (option: ChainOption, side: Side, withPrice: boolean) => {
        pick(option);
        if (!canLaunch || !option.liquid) return;
        const price = side === Side.Buy ? option.ask : option.bid;
        openOrderTicket({
          ric: option.ric,
          instrument: option.instrument,
          side,
          ...(withPrice && price !== undefined ? { price } : {}),
        });
      },
      [canLaunch, openOrderTicket, pick],
    );
    const optionAt = (strike: ChainStrike | undefined, cell: CellIndex) =>
      CELLS[cell].right === "call" ? strike?.call : strike?.put;

    const handleKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const i = strikes.findIndex((s) => s.strike === focusStrike);
      const row = strikes[i];
      const { cell } = focus;
      const move = (di: number, dc = 0) => {
        const next = strikes[Math.max(0, Math.min(strikes.length - 1, i + di))];
        const c = Math.max(0, Math.min(3, cell + dc)) as CellIndex;
        if (next) focusCell(next.strike, c);
      };
      const option = optionAt(row, cell);
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          return move(-1);
        case "ArrowDown":
          event.preventDefault();
          return move(1);
        case "ArrowLeft":
          event.preventDefault();
          return move(0, -1);
        case "ArrowRight":
          event.preventDefault();
          return move(0, 1);
        case "PageUp":
        case "PageDown": {
          event.preventDefault();
          const e = chain.expiries.indexOf(activeExpiry ?? -1);
          const next = chain.expiries[e + (event.key === "PageUp" ? -1 : 1)];
          if (next !== undefined) setExpiry(next);
          return;
        }
        case "Enter":
        case " ":
          if (!option) return;
          event.preventDefault();
          return trade(option, CELLS[cell].side, true);
        case "b":
        case "B":
        case "s":
        case "S":
          if (!option) return;
          event.preventDefault();
          return trade(
            option,
            event.key.toLowerCase() === "b" ? Side.Buy : Side.Sell,
            false,
          );
      }
    };

    const quoteCell = (
      strike: ChainStrike,
      option: ChainOption | undefined,
      cell: CellIndex,
      itm: boolean,
    ) => {
      const { quote, side } = CELLS[cell];
      const value = option?.[quote];
      const focused = strike.strike === focusStrike && focus.cell === cell;
      const tradeable = !!option?.liquid;
      return (
        <td
          aria-label={
            option
              ? `${option.ric} ${quote} ${formatPrice(value, option.instrument)}${tradeable ? `: ${side === Side.Buy ? "buy" : "sell"}` : ", quote only"}`
              : undefined
          }
          className={cx(`${classBase}-quote`, `${classBase}-${quote}`)}
          data-cell={cell}
          data-itm={itm || undefined}
          data-tradeable={tradeable || undefined}
          key={cell}
          onClick={
            option
              ? () => {
                  setFocus({ strike: strike.strike, cell });
                  trade(option, side, true);
                }
              : undefined
          }
          role="gridcell"
          tabIndex={focused ? 0 : -1}
          title={
            option && !tradeable
              ? "Quote only: no book, takes no orders"
              : undefined
          }
        >
          {option ? formatPrice(value, option.instrument) : ""}
        </td>
      );
    };

    /** One right's cells: Δ, IV, bid, ask (mirrored for puts). */
    const rightCells = (
      strike: ChainStrike,
      right: "call" | "put",
      itm: boolean,
    ) => {
      const option = right === "call" ? strike.call : strike.put;
      const [bid, ask]: [CellIndex, CellIndex] =
        right === "call" ? [0, 1] : [2, 3];
      const flag = itm || undefined;
      const stats = [
        <td className={`${classBase}-delta`} data-itm={flag} key="delta">
          {greek(option?.delta)}
        </td>,
        <td className={`${classBase}-iv`} data-itm={flag} key="iv">
          {pct(option?.impliedVol)}
        </td>,
      ];
      const quotes = [
        quoteCell(strike, option, bid, itm),
        quoteCell(strike, option, ask, itm),
      ];
      return right === "put"
        ? [...quotes, ...stats.reverse()]
        : [...stats, ...quotes];
    };

    const title = chain.underlyings[0] ?? underlying;
    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        data-testid="trading-option-chain"
        ref={ref}
      >
        <div className={`${classBase}-header`}>
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <span className={`${classBase}-title`}>
            {title ? `${title} options` : "Options"}
          </span>
          {forward !== undefined ? (
            <span className={`${classBase}-forward`}>
              Fwd {formatPrice(forward, { priceDecimals: 2 })}
            </span>
          ) : null}
          <div
            aria-label="Expiry"
            className={`${classBase}-expiries`}
            role="tablist"
          >
            {chain.expiries.map((e) => (
              <button
                aria-selected={e === activeExpiry}
                className={`${classBase}-expiry`}
                key={e}
                onClick={() => setExpiry(e)}
                role="tab"
                tabIndex={e === activeExpiry ? 0 : -1}
                type="button"
              >
                {formatExpiry(e)}
              </button>
            ))}
          </div>
        </div>
        {strikes.length === 0 ? (
          <div className={`${classBase}-empty`}>
            {!underlying
              ? "Select a stock, an index or an option"
              : loaded
                ? `No options listed on ${underlying}`
                : "Loading…"}
          </div>
        ) : (
          <div className={`${classBase}-scroll`}>
            <table
              aria-label={`${title} ${activeExpiry ? formatExpiry(activeExpiry) : ""} option chain`}
              className={`${classBase}-table`}
              onKeyDown={handleKeyDown}
              ref={tableRef}
              role="grid"
            >
              <thead>
                <tr className={`${classBase}-rights`}>
                  <th colSpan={4} scope="colgroup">
                    Calls
                  </th>
                  <th />
                  <th colSpan={4} scope="colgroup">
                    Puts
                  </th>
                </tr>
                <tr>
                  <th scope="col">Δ</th>
                  <th scope="col">IV</th>
                  <th scope="col">Bid</th>
                  <th scope="col">Ask</th>
                  <th className={`${classBase}-strikeHeader`} scope="col">
                    Strike
                  </th>
                  <th scope="col">Bid</th>
                  <th scope="col">Ask</th>
                  <th scope="col">IV</th>
                  <th scope="col">Δ</th>
                </tr>
              </thead>
              <tbody>
                {strikes.map((s) => {
                  const liquid = !!(s.call?.liquid || s.put?.liquid);
                  return (
                    <tr
                      aria-selected={
                        selectedRic !== undefined &&
                        (s.call?.ric === selectedRic ||
                          s.put?.ric === selectedRic)
                      }
                      className={`${classBase}-row`}
                      data-atm={s.strike === atm || undefined}
                      data-liquid={liquid || undefined}
                      data-strike={s.strike}
                      key={s.strike}
                    >
                      {rightCells(
                        s,
                        "call",
                        forward !== undefined && s.strike < forward,
                      )}
                      <th className={`${classBase}-strike`} scope="row">
                        {formatPrice(s.strike, {
                          ...(s.call ?? s.put)?.instrument,
                          priceDecimals: Number.isInteger(s.strike) ? 0 : 2,
                        })}
                      </th>
                      {rightCells(
                        s,
                        "put",
                        forward !== undefined && s.strike > forward,
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className={`${classBase}-footer`}>
          <span className={`${classBase}-legend`} data-liquid>
            Book
          </span>
          <span className={`${classBase}-legend`}>Quote only</span>
          <span className={`${classBase}-keys`}>
            ↵ trade · B / S · PgUp / PgDn expiry
          </span>
        </div>
      </div>
    );
  },
);
