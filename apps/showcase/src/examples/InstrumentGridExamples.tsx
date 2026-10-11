import { InstrumentGrid, type SelectedInstrument } from "@heswell/trading-ui";
import { Text } from "@salt-ds/core";
import { useCallback, useState } from "react";

const useLog = () => {
  const [log, setLog] = useState(
    "Right-click a row or use the toolbar buttons",
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
  <div
    style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}
  >
    <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    <Text role="status" aria-live="polite">
      {log}
    </Text>
  </div>
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
