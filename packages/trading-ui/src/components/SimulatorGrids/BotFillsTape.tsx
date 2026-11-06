import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useEffect } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useFollowedInstrument } from "../../hooks/useMarketData";
import type { LinkGroupProps } from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import { InstrumentLookupProvider } from "../InstrumentLookup";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { useStaleData } from "../StaleIndicator/useStaleData";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import { renderer, simGridClass, useSimGridSetup } from "./useSimGridSetup";

registerTradingCellRenderers();

const COLUMNS = [
  "id",
  "tradeId",
  "ric",
  "party",
  "group",
  "kind",
  "account",
  "side",
  "price",
  "quantity",
  "notionalUsd",
  "liquidity",
  "timestamp",
  "markoutBps",
];

const right = { align: "right" as const };

const tableConfig: TableConfig = {
  columnDefaultWidth: 90,
  rowSeparators: true,
  columns: [
    {
      name: "timestamp",
      label: "Time",
      width: 110,
      type: renderer(TradingRenderer.Time),
    },
    { name: "ric", width: 90 },
    { name: "party", label: "Who", width: 130 },
    { name: "group", width: 70 },
    { name: "side", width: 60, type: renderer(TradingRenderer.Side) },
    { name: "quantity", label: "Qty", ...right },
    { name: "price", ...right, type: renderer(TradingRenderer.Price) },
    {
      name: "notionalUsd",
      label: "Notional $",
      ...right,
      width: 120,
      type: renderer(TradingRenderer.Notional),
    },
    { name: "liquidity", width: 90, type: renderer(TradingRenderer.Liquidity) },
    { name: "markoutBps", label: "Markout bp", ...right, width: 100 },
    { name: "tradeId", width: 120 },
    { name: "kind", hidden: true },
    { name: "account", hidden: true },
    { name: "id", hidden: true },
  ],
};

export interface BotFillsTapeProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /** One bot's (or `OMS:<account>`'s) fills, on every instrument. */
  party?: string;
  /** Instrument; default: the followed (linked) instrument, unless `party` is set. */
  ric?: string;
  /** Hide the toolbar (e.g. inside a detail panel). */
  hideToolbar?: boolean;
}

const filterOf = (party: string | undefined, ric: string | undefined) =>
  party
    ? `party = ${filterString(party)}`
    : ric
      ? `ric = ${filterString(ric)}`
      : "";

const Inner = forwardRef<HTMLDivElement, BotFillsTapeProps>(
  function BotFillsTapeInner(
    {
      className,
      defaultLinkGroup,
      hideToolbar = false,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      party,
      ric: ricProp,
      showLinkGroupSelector = false,
      ...htmlAttributes
    },
    ref,
  ) {
    const { staleProps } = useStaleData();
    const { linkGroup, channel, setLinkGroup, handleSelect } = useSimGridSetup(
      "BotFillsTape",
      { defaultLinkGroup, linkGroup: linkGroupProp, onLinkGroupChange },
      htmlAttributes.id,
    );
    const { ric: followed } = useFollowedInstrument(ricProp, {
      linkGroup: channel,
    });
    const ric = party ? ricProp : followed;
    const dataSource = useTradingDataSource("botFills", {
      columns: COLUMNS,
      filterSpec: { filter: filterOf(party, ric) },
      sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
    });
    useEffect(() => {
      dataSource.filter = { filter: filterOf(party, ric) };
    }, [party, ric, dataSource]);

    return (
      <div
        {...htmlAttributes}
        {...staleProps}
        className={cx(simGridClass, className, staleProps.className)}
        data-link-group={linkGroup}
        data-testid="trading-bot-fills-tape"
        ref={ref}
      >
        {hideToolbar ? null : (
          <div className={`${simGridClass}-toolbar`}>
            {showLinkGroupSelector ? (
              <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
            ) : null}
            <span>
              {party
                ? `Fills of ${party}`
                : ric
                  ? `${ric} attributed fills`
                  : "All attributed fills"}
            </span>
          </div>
        )}
        <div className={`${simGridClass}-table`}>
          <Table
            config={tableConfig}
            dataSource={dataSource}
            onSelect={handleSelect}
            selectionModel="single"
          />
        </div>
      </div>
    );
  },
);

/**
 * Attributed fills from `botFills` (sim-admin only): one row per side of
 * every trade, naming the bot or `OMS:<account>`, maker or taker, with the
 * markout `markoutMs` later (> 0 = the fill made money). Follows the linked
 * instrument, or shows one party's fills.
 */
export const BotFillsTape = forwardRef<HTMLDivElement, BotFillsTapeProps>(
  function BotFillsTape(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
