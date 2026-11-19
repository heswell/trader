import { InstrumentType } from "@heswell/trading-schemas";
import {
  InstrumentGrid,
  OPTIONS_SET_COLUMNS,
  OptionChain,
  OrderTicketPanel,
  PositionsView,
} from "@heswell/trading-ui";
import { Button, Text } from "@salt-ds/core";
import { useState } from "react";
import { ShowcaseContextPanel } from "./shared/ShowcaseContextPanel";

const fill = { height: "100%", minHeight: 0 } as const;

/** The local test data lists options on these (see LOCAL_EXCHANGE_DEFAULTS). */
const UNDERLYINGS = ["AAPL.OQ", "STECH"];

const UnderlyingButtons = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (underlying: string) => void;
}) => (
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <Text styleAs="label">Underlying</Text>
    {UNDERLYINGS.map((u) => (
      <Button
        appearance={u === value ? "solid" : "bordered"}
        key={u}
        onClick={() => onChange(u)}
      >
        {u}
      </Button>
    ))}
  </div>
);

/**
 * The chain with a docked ticket: Enter (or a click) on a liquid bid sells,
 * on an ask buys; quote-only strikes are dimmed and only select.
 */
export const OptionChainTicket = () => {
  const [underlying, setUnderlying] = useState("AAPL.OQ");
  return (
    <div style={{ display: "flex", gap: 16, padding: 16, ...fill }}>
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 8,
          minWidth: 0,
        }}
      >
        <UnderlyingButtons onChange={setUnderlying} value={underlying} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <OptionChain underlying={underlying} />
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <OrderTicketPanel style={{ width: 380 }} />
        <Text styleAs="label" style={{ maxWidth: 380 }}>
          Type <code>aapl 175c</code>, <code>b 5 stech 4000p jan</code> in the
          instrument field. ⌥↑ / ⌥↓ step strikes, ⌥⇧↑ / ⌥⇧↓ expiries, ⌥C call /
          put.
        </Text>
      </div>
    </div>
  );
};

/** Every listed option in the instrument grid: the Options column set. */
export const OptionInstrumentGrid = () => (
  <ShowcaseContextPanel>
    <div style={{ flex: 1, minHeight: 0 }}>
      <InstrumentGrid
        columns={OPTIONS_SET_COLUMNS}
        initialGroupBy="underlying"
        instrumentType={InstrumentType.Option}
      />
    </div>
  </ShowcaseContextPanel>
);

/**
 * Positions grouped by underlying with Greeks: a stock, its futures and
 * its options net their delta. Trade from the chain to build some.
 */
export const OptionPositions = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16, ...fill }}>
    <div style={{ flex: 1, minHeight: 0 }}>
      <OptionChain underlying="AAPL.OQ" />
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <PositionsView defaultGrouping="underlying" showTotals={false} />
    </div>
  </div>
);
