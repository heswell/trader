import {
  ACTIVE_LINK_GROUP,
  TimeSeriesChart,
  type TimeSeriesChartProps,
} from "@heswell/trading-ui";
import { Checkbox, ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { type SyntheticEvent, useRef, useState } from "react";
import {
  FeatureFrame,
  fillStyle,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

type Fields = NonNullable<TimeSeriesChartProps["fields"]>;

const FIELDS = {
  mid: ["mid"],
  spread: ["mid", "spreadBps"],
} satisfies Record<string, Fields>;

type FieldSet = keyof typeof FIELDS;

const DEFAULT_SPAN_MS = 3_600_000;

export interface HistoryProps extends LinkedFeatureProps {
  /** Show the subscription's numbers (buckets, rows sent, server time); default true. */
  showStats?: boolean;
}

/**
 * Five years of 1 s mid (and spread) for the linked instrument: the server
 * downsamples to the visible window and generates older history per bucket
 * on demand, so the range buttons go from 1h to 5y and a zoom drills down to
 * single seconds anywhere in it.
 */
const History = ({
  defaultLinkGroup = ACTIVE_LINK_GROUP,
  showStats: defaultShowStats = true,
}: HistoryProps) => {
  const [fieldSet, setFieldSet] = useState<FieldSet>("mid");
  const [showStats, setShowStats] = useState(defaultShowStats);
  // Changing the series opens a new subscription: keep the span shown.
  const spanRef = useRef(DEFAULT_SPAN_MS);
  const [spanMs, setSpanMs] = useState(DEFAULT_SPAN_MS);
  const toolbar = (
    <>
      <ToggleButtonGroup
        aria-label="Series"
        onChange={(e: SyntheticEvent<HTMLButtonElement>) => {
          setSpanMs(spanRef.current);
          setFieldSet(e.currentTarget.value as FieldSet);
        }}
        value={fieldSet}
      >
        <ToggleButton value="mid">Mid</ToggleButton>
        <ToggleButton value="spread">Mid + spread</ToggleButton>
      </ToggleButtonGroup>
      <Checkbox
        checked={showStats}
        label="Stats"
        onChange={(e) => setShowStats(e.target.checked)}
      />
    </>
  );
  return (
    <FeatureFrame toolbar={toolbar}>
      <TimeSeriesChart
        defaultLinkGroup={defaultLinkGroup}
        defaultSpanMs={spanMs}
        fields={FIELDS[fieldSet]}
        id="history"
        onStats={(stats) => {
          spanRef.current = stats.spanMs;
        }}
        showLinkGroupSelector
        showStats={showStats}
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(History, "TradingHistory");
