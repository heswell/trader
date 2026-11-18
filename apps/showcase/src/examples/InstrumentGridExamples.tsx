import { InstrumentType } from "@heswell/trading-schemas";
import {
  InstrumentGrid,
  NamePrompt,
  type SelectedInstrument,
} from "@heswell/trading-ui";
import { Button, Text } from "@salt-ds/core";
import { useCallback, useState } from "react";
import { ShowcaseContextPanel } from "./shared/ShowcaseContextPanel";

const useLog = () => {
  const [log, setLog] = useState(
    "Hover or select a row for Buy / Sell / Depth, press B / S / D, or right-click",
  );
  const action = useCallback(
    (verb: string) => (i: SelectedInstrument) => setLog(`${verb} ${i.ric}`),
    [],
  );
  return { log, action };
};

const Layout = ({
  children,
  log,
}: {
  children: React.ReactNode;
  log: string;
}) => (
  <ShowcaseContextPanel>
    <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    <Text role="status" aria-live="polite" style={{ marginTop: 8 }}>
      {log}
    </Text>
  </ShowcaseContextPanel>
);

export const InstrumentGridExamples = () => {
  const { action, log } = useLog();
  return (
    <Layout log={log}>
      <InstrumentGrid
        onBuy={action("Buy")}
        onSell={action("Sell")}
        onOpenDepth={action("Open depth for")}
      />
    </Layout>
  );
};

export const InstrumentGridPrices = () => {
  const { action, log } = useLog();
  return (
    <Layout log={log}>
      <InstrumentGrid
        table="prices"
        onBuy={action("Buy")}
        onSell={action("Sell")}
      />
    </Layout>
  );
};

/** Open the showcase with ?active=200 so that 200 instruments tick. */
export const InstrumentGridTicking200 = () => {
  const { action, log } = useLog();
  return (
    <Layout log={log}>
      <InstrumentGrid
        sparkline={{ length: 60, valueColumn: "last" }}
        onBuy={action("Buy")}
        onSell={action("Sell")}
      />
    </Layout>
  );
};

/** Continuations (AZNc1, AZNc2): each mirrors the contract in its `contract` column. */
export const InstrumentGridContinuations = () => {
  const { action, log } = useLog();
  return (
    <Layout log={log}>
      <InstrumentGrid
        instrumentType={InstrumentType.Continuation}
        columns={[
          "ric",
          "contract",
          "underlying",
          "description",
          "expiry",
          "contractMultiplier",
          "bid",
          "ask",
          "last",
          "changePct",
          "phase",
        ]}
        initialGroupBy="underlying"
        onBuy={action("Buy")}
        onSell={action("Sell")}
      />
    </Layout>
  );
};

/** Futures only: type, underlying, expiry and multiplier columns; Buy opens contracts. */
export const InstrumentGridFutures = () => {
  const { action, log } = useLog();
  return (
    <Layout log={log}>
      <InstrumentGrid
        instrumentType={InstrumentType.Future}
        columns={[
          "ric",
          "description",
          "underlying",
          "expiry",
          "contractMultiplier",
          "bid",
          "ask",
          "last",
          "changePct",
          "phase",
          "settlementPrice",
        ]}
        initialGroupBy="underlying"
        onBuy={action("Buy")}
        onSell={action("Sell")}
      />
    </Layout>
  );
};

/** The grid's Salt dialogs on their own: name a new list or column set. */
export const InstrumentGridDialogs = () => {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState("Open a dialog");
  return (
    <ShowcaseContextPanel>
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={() => setOpen(true)}>New column set…</Button>
      </div>
      {open ? (
        <NamePrompt
          onClose={() => setOpen(false)}
          onConfirm={(name) => setLog(`Created ${name}`)}
          placeholder="e.g. Screening"
          title="New column set"
          validate={(name) =>
            name.toLowerCase() === "prices"
              ? `A column set called ${name} already exists`
              : undefined
          }
        />
      ) : null}
      <Text role="status" aria-live="polite" style={{ marginTop: 8 }}>
        {log}
      </Text>
    </ShowcaseContextPanel>
  );
};
