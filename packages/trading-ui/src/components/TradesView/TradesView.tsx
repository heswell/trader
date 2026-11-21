import { ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import { ExportCsvButton } from "../ExportCsvButton";
import { useRowCount } from "../InstrumentGrid/InstrumentGridFooter";
import { InstrumentLookupProvider } from "../InstrumentLookup";
import { PanelLinkGroupSelector } from "../LinkGroupSelector";
import { useStaleData } from "../StaleIndicator/useStaleData";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";

import tradesViewCss from "./TradesView.css";

registerTradingCellRenderers();

const classBase = "tradingTradesView";

/** All instruments, or only the linked instrument. */
export type TradesScope = "all" | "linked";

const COLUMNS = [
  "tradeId",
  "ric",
  "price",
  "size",
  "aggressorSide",
  "timestamp",
  "seq",
];

const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});

export const tradesViewTableConfig: TableConfig = {
  columnDefaultWidth: 100,
  rowSeparators: true,
  columns: [
    {
      name: "timestamp",
      label: "Time",
      width: 110,
      type: renderer(TradingRenderer.Time),
    },
    { name: "ric", label: "RIC", width: 90 },
    {
      name: "aggressorSide",
      label: "Side",
      width: 60,
      type: renderer(TradingRenderer.Side),
    },
    {
      name: "price",
      label: "Price",
      align: "right",
      type: renderer(TradingRenderer.Price),
    },
    {
      name: "size",
      label: "Size",
      align: "right",
      type: { name: "number", formatting: { useLocaleString: true } },
    },
    { name: "tradeId", label: "Trade id", width: 130 },
    { name: "seq", label: "Seq", align: "right", width: 80 },
  ],
};

export interface TradesViewProps
  extends HTMLAttributes<HTMLDivElement>,
    LinkGroupProps {
  /** Initial scope. Default "all". */
  defaultScope?: TradesScope;
  /** Show the panel link group selector in the toolbar. Default false. */
  showLinkGroupSelector?: boolean;
  /** Suggested CSV file name. Default "trades.csv". */
  csvFileName?: string;
}

const scopeFilter = (scope: TradesScope, ric?: string) =>
  scope === "linked" ? `ric = ${filterString(ric ?? "-")}` : "";

const Inner = forwardRef<HTMLDivElement, TradesViewProps>(
  function TradesViewInner(
    {
      className,
      csvFileName = "trades.csv",
      defaultLinkGroup,
      defaultScope = "all",
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      showLinkGroupSelector = false,
      ...htmlAttributes
    },
    ref,
  ) {
    const { connectionState, staleProps } = useStaleData();
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-trades-view",
      css: tradesViewCss,
      window: targetWindow,
    });
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `TradesView:${htmlAttributes.id}`
        : "TradesView",
    });
    const { selectedInstrument } = useSelectedInstrument({
      linkGroup: channel,
    });
    const ric = selectedInstrument?.ric;
    const [scope, setScope] = useState<TradesScope>(defaultScope);
    const [config, setConfig] = useState(tradesViewTableConfig);

    const dataSource = useTradingDataSource("trades", {
      columns: COLUMNS,
      filterSpec: { filter: scopeFilter(defaultScope, ric) },
      sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
    });
    useEffect(() => {
      dataSource.filter = { filter: scopeFilter(scope, ric) };
    }, [dataSource, scope, ric]);
    const rowCount = useRowCount(dataSource);

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        data-scope={scope}
        data-testid="trading-trades-view"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`}>
          {showLinkGroupSelector ? (
            <PanelLinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <ToggleButtonGroup
            aria-label="Instruments"
            className={`${classBase}-scope`}
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              setScope(e.currentTarget.value as TradesScope)
            }
            value={scope}
          >
            <ToggleButton value="all">All instruments</ToggleButton>
            <ToggleButton
              title="Trades in the linked instrument"
              value="linked"
            >
              {ric ?? "Linked"}
            </ToggleButton>
          </ToggleButtonGroup>
          <span className={`${classBase}-spacer`} />
          <ExportCsvButton
            dataSource={dataSource}
            disabled={connectionState !== "connected" || rowCount === 0}
            fileName={csvFileName}
            table="trades"
            tableConfig={config}
          />
        </div>
        <div
          {...staleProps}
          className={cx(`${classBase}-table`, staleProps.className)}
        >
          <Table
            config={config}
            dataSource={dataSource}
            onConfigChange={setConfig}
            renderBufferSize={20}
          />
        </div>
        <div className={`${classBase}-footer`} data-testid="trades-row-count">
          {rowCount.toLocaleString()} {rowCount === 1 ? "trade" : "trades"}
        </div>
      </div>
    );
  },
);

/**
 * Every trade on the `trades` table (time and sales across instruments,
 * newest first), sortable by any column, or only the linked instrument's.
 * Export CSV writes all of them in the current scope and sort, however
 * many: the table can hold a million rows (exchangeSim.tradesSeed).
 */
export const TradesView = forwardRef<HTMLDivElement, TradesViewProps>(
  function TradesView(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
