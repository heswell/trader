import {
  DepthChartView,
  ExposureTreemap,
  type ExposureMeasure,
  MarketDepth,
  PnlHistoryChart,
  PriceChart,
  SlippageChart,
  SpreadChart,
} from "@heswell/trading-ui";
import { Checkbox, FlexLayout } from "@salt-ds/core";
import { type CSSProperties, useState } from "react";
import { InstrumentSelector } from "./shared/InstrumentSelector";

const ACCOUNT = "ACC-US-01";
const panel: CSSProperties = {
  border: "1px solid var(--salt-separable-tertiary-borderColor)",
  minHeight: 0,
  minWidth: 0,
};
const withSelector = (rows: string): CSSProperties => ({
  display: "grid",
  gap: 8,
  gridTemplateColumns: "minmax(320px, 0.8fr) minmax(480px, 2fr)",
  gridTemplateRows: rows,
  height: "100%",
});

/**
 * PriceChart following the selected instrument: 1s / 1m / 5m candles,
 * volume, VWAP and the fills of every visible account (or ACC-US-01 only),
 * with the overlays switchable.
 */
export const PriceChartExample = () => {
  const [vwap, setVwap] = useState(true);
  const [fills, setFills] = useState(true);
  const [volume, setVolume] = useState(true);
  const [oneAccount, setOneAccount] = useState(false);
  return (
    <div style={withSelector("auto 1fr")}>
      <div style={{ gridRow: "1 / span 2", minHeight: 0 }}>
        <InstrumentSelector showAdmin />
      </div>
      <FlexLayout align="center" gap={2} wrap>
        <Checkbox
          label="VWAP"
          checked={vwap}
          onChange={(e) => setVwap(e.target.checked)}
        />
        <Checkbox
          label="Fills"
          checked={fills}
          onChange={(e) => setFills(e.target.checked)}
        />
        <Checkbox
          label="ACC-US-01 only"
          checked={oneAccount}
          onChange={(e) => setOneAccount(e.target.checked)}
        />
        <Checkbox
          label="Volume"
          checked={volume}
          onChange={(e) => setVolume(e.target.checked)}
        />
      </FlexLayout>
      <PriceChart
        account={oneAccount ? ACCOUNT : undefined}
        defaultInterval="1s"
        showFills={fills}
        showVolume={volume}
        showVwap={vwap}
        style={panel}
      />
    </div>
  );
};

/** DepthChartView and SpreadChart for the selected instrument. */
export const DepthChartExample = () => (
  <div style={withSelector("1fr 1fr")}>
    <div style={{ gridRow: "1 / span 2", minHeight: 0 }}>
      <InstrumentSelector showAdmin />
    </div>
    <DepthChartView style={panel} />
    <SpreadChart style={panel} />
  </div>
);

/** SpreadChart (bookSamples) for the selected instrument. */
export const SpreadChartExample = () => (
  <div style={withSelector("1fr")}>
    <InstrumentSelector />
    <SpreadChart style={panel} />
  </div>
);

/** PnlHistoryChart with its account selector. */
export const PnlHistoryChartExample = () => (
  <PnlHistoryChart style={{ ...panel, height: "100%" }} />
);

/**
 * ExposureTreemap across every visible account (measure switched from
 * outside, selector hidden) and for ACC-US-01 with its own toggle.
 */
export const ExposureTreemapExample = () => {
  const [measure, setMeasure] = useState<ExposureMeasure>("exposure");
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "auto 1fr",
        height: "100%",
      }}
    >
      <Checkbox
        label="P&L (all accounts)"
        checked={measure === "pnl"}
        onChange={(e) => setMeasure(e.target.checked ? "pnl" : "exposure")}
      />
      <span />
      <ExposureTreemap
        measure={measure}
        showMeasureSelector={false}
        style={panel}
      />
      <ExposureTreemap account={ACCOUNT} style={panel} />
    </div>
  );
};

/** SlippageChart for every visible account. */
export const SlippageChartExample = () => (
  <SlippageChart style={{ ...panel, height: "100%" }} />
);

/**
 * Every live chart at once for the selected instrument (perf scenario
 * `chart-workspace`, see docs/performance.md): price chart, depth chart,
 * spread / imbalance and the MarketDepth table.
 */
export const ChartWorkspace = () => (
  <div
    style={{
      display: "grid",
      gap: 8,
      gridTemplateColumns: "minmax(300px, 0.7fr) 2fr 1fr",
      gridTemplateRows: "1.4fr 1fr",
      height: "100%",
    }}
  >
    <div style={{ gridRow: "1 / span 2", minHeight: 0 }}>
      <InstrumentSelector />
    </div>
    <PriceChart account={ACCOUNT} defaultInterval="1s" style={panel} />
    <DepthChartView style={panel} />
    <SpreadChart style={panel} />
    <MarketDepth account={ACCOUNT} levels={5} style={panel} />
  </div>
);
