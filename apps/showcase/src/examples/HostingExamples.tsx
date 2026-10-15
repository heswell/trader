import {
  createMemorySettingsStorage,
  InstrumentGrid,
  OrderTicket,
  StaleIndicator,
  type TradingConnectionState,
  TradingConnectionStateOverride,
  TradingFeatureRoot,
  type UserSettingsStorage,
  UserSettingsProvider,
  useInTradingFeatureRoot,
  useTradingConnectionStatus,
} from "@heswell/trading-ui";
import { Text, ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { type SyntheticEvent, useMemo, useState } from "react";

const column = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 16,
  height: "100%",
  minHeight: 0,
} as const;

const RootReadout = () => (
  <Text>
    useInTradingFeatureRoot():{" "}
    <strong>{String(useInTradingFeatureRoot())}</strong>
  </Text>
);

/**
 * What an MF feature renders. Notifications are off here because the
 * showcase host already streams them (in a portal, one root per window
 * streams: a window-global lease).
 */
export const FeatureRootExample = () => (
  <div style={column}>
    <RootReadout />
    <TradingFeatureRoot notifications={false}>
      <RootReadout />
      <div style={{ flex: 1, minHeight: 0 }}>
        <InstrumentGrid showToolbar={false} />
      </div>
    </TradingFeatureRoot>
  </div>
);

const STATES: (TradingConnectionState | "live")[] = [
  "live",
  "connecting",
  "reconnecting",
  "disconnected",
  "failed",
];

const StateReadout = () => {
  const { state } = useTradingConnectionStatus();
  return (
    <Text>
      useTradingConnectionStatus(): <strong>{state}</strong> <StaleIndicator />
    </Text>
  );
};

/** Force a connection state to see how components degrade, without a server. */
export const ConnectionOverrideExample = () => {
  const [state, setState] = useState<TradingConnectionState | "live">(
    "reconnecting",
  );
  return (
    <div style={column}>
      <ToggleButtonGroup
        aria-label="Connection state"
        onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
          setState(e.currentTarget.value as TradingConnectionState | "live")
        }
        value={state}
      >
        {STATES.map((s) => (
          <ToggleButton key={s} value={s}>
            {s}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <TradingConnectionStateOverride
        state={state === "live" ? undefined : state}
      >
        <StateReadout />
        <OrderTicket variant="compact" />
      </TradingConnectionStateOverride>
    </div>
  );
};

/** In-memory storage that reports every write. */
const useObservedStorage = () => {
  const [writes, setWrites] = useState<string[]>([]);
  const storage = useMemo<UserSettingsStorage>(() => {
    const memory = createMemorySettingsStorage();
    return {
      getItem: (key) => memory.getItem(key),
      setItem: (key, value) => {
        memory.setItem(key, value);
        setWrites((w) => [`${key} = ${value}`, ...w].slice(0, 5));
      },
      removeItem: (key) => memory.removeItem?.(key),
    };
  }, []);
  return { storage, writes };
};

/**
 * UserSettingsProvider: the grid's watchlists persist to the given storage
 * (here in memory, shown below) instead of localStorage.
 */
export const UserSettingsExample = () => {
  const { storage, writes } = useObservedStorage();
  return (
    <div style={column}>
      <Text>Create a watchlist from the grid toolbar; writes appear here:</Text>
      <pre style={{ margin: 0, minHeight: 48, whiteSpace: "pre-wrap" }}>
        {writes.join("\n") || "(none yet)"}
      </pre>
      <UserSettingsProvider storage={storage}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <InstrumentGrid />
        </div>
      </UserSettingsProvider>
    </div>
  );
};
