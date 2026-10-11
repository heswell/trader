import {
  type MarketDepthLevelClick,
  MarketDepth,
  useSelectedInstrument,
} from "@heswell/trading-ui";
import { Button, Checkbox, FlexLayout, Text } from "@salt-ds/core";
import { useState } from "react";
import { InstrumentPicker } from "./shared/InstrumentPicker";

const panel = {
  border: "1px solid var(--salt-separable-tertiary-borderColor)",
  minHeight: 0,
  overflow: "auto",
} as const;

/**
 * MarketDepth following the selected instrument (own orders for
 * ACC-US-01), with display options and exchange halt / resume, plus a second
 * depth pinned to an explicit `ric`.
 */
export const MarketDepthExamples = () => {
  const { selectedInstrument } = useSelectedInstrument();
  const [levels, setLevels] = useState(10);
  const [bars, setBars] = useState(true);
  const [flash, setFlash] = useState(true);
  const [pinned, setPinned] = useState<string>();
  const [clicked, setClicked] = useState<MarketDepthLevelClick>();
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        gridTemplateColumns: "minmax(360px, 1fr) minmax(420px, 1.2fr)",
        gridTemplateRows: "auto 1fr 1fr",
        height: "100%",
      }}
    >
      <div style={{ gridRow: "1 / span 3", minHeight: 0 }}>
        <InstrumentPicker source="showcase-depth" showAdmin />
      </div>
      <FlexLayout align="center" gap={2} wrap>
        <Checkbox
          label="10 levels"
          checked={levels === 10}
          onChange={(e) => setLevels(e.target.checked ? 10 : 5)}
        />
        <Checkbox
          label="Depth bars"
          checked={bars}
          onChange={(e) => setBars(e.target.checked)}
        />
        <Checkbox
          label="Flash"
          checked={flash}
          onChange={(e) => setFlash(e.target.checked)}
        />
        <Button
          disabled={!selectedInstrument}
          onClick={() => setPinned(selectedInstrument?.ric)}
        >
          Pin {selectedInstrument?.ric ?? ""}
        </Button>
        <Text>
          {clicked
            ? `Clicked ${clicked.side} ${clicked.price} (level ${clicked.level})`
            : "Click a price"}
        </Text>
      </FlexLayout>
      <div style={panel}>
        <MarketDepth
          account="ACC-US-01"
          levels={levels}
          showDepthBars={bars}
          flash={flash}
          onLevelClick={setClicked}
        />
      </div>
      <div style={panel}>
        {pinned ? (
          <MarketDepth ric={pinned} levels={5} />
        ) : (
          <Text style={{ padding: 16 }}>
            Pin an instrument to show a second depth with an explicit ric
          </Text>
        )}
      </div>
    </div>
  );
};
