import {
  ConnectionBanner,
  StaleIndicator,
  TRADING_ORDER_EVENT_KINDS,
  type TradingConnectionState,
  useSelectedInstrument,
  useStaleIndicator,
  useTradingConnectionStatus,
  useTradingNotifications,
} from "@heswell/trading-ui";
import { Button, Checkbox, Text } from "@salt-ds/core";
import { useState } from "react";

/** Notification settings, the fill sound and a test toast. */
export const NotificationSettingsExample = () => {
  const { settings, updateSettings, enableSound, notify } =
    useTradingNotifications();
  const { selectedInstrument } = useSelectedInstrument();
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}
    >
      <Text>
        Orders you place anywhere (ticket, other examples, background) toast
        here. Toggle per event type:
      </Text>
      {TRADING_ORDER_EVENT_KINDS.map((kind) => (
        <Checkbox
          checked={settings.kinds[kind]}
          key={kind}
          label={kind}
          onChange={(e) =>
            updateSettings({ kinds: { [kind]: e.target.checked } })
          }
        />
      ))}
      <Checkbox
        checked={settings.sound}
        label="Beep on fills"
        onChange={(e) => {
          // enableSound must run inside the user gesture
          if (e.target.checked) enableSound();
          else updateSettings({ sound: false });
        }}
      />
      <Button
        onClick={() =>
          notify({
            kind: "fill",
            execId: `demo-${Date.now()}`,
            ric: selectedInstrument?.ric ?? "VOD.L",
            side: "BUY",
            fillQty: 100,
            fillPx: 101.5,
            source: "showcase",
          })
        }
        style={{ alignSelf: "flex-start" }}
      >
        Show a test fill
      </Button>
    </div>
  );
};

const STATES: TradingConnectionState[] = [
  "connecting",
  "reconnecting",
  "disconnected",
  "failed",
];

/** Banner variants, the live connection state and the stale indicator. */
export const ConnectionStateExample = () => {
  const live = useTradingConnectionStatus();
  const [lastUpdate, setLastUpdate] = useState(() => Date.now());
  const stale = useStaleIndicator({ lastUpdate, staleAfterMs: 5_000 });
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}
    >
      <Text>
        Live: <strong>{live.state}</strong>
        {live.local ? " (local test data)" : ` (${live.connectionId})`}
      </Text>
      {STATES.map((state) => (
        <ConnectionBanner key={state} state={state} />
      ))}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Button onClick={() => setLastUpdate(Date.now())}>Tick</Button>
        <Text>
          stale: {String(stale.stale)} {stale.reason ?? ""}
        </Text>
        <StaleIndicator lastUpdate={lastUpdate} staleAfterMs={5_000} />
        <StaleIndicator reason="reconnecting" />
      </div>
    </div>
  );
};
