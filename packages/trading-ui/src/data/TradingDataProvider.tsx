import { DataProvider, type LocalVuuServer, useData } from "@vuu-ui/core";
import { ConnectionManager, VuuDataSource } from "@vuu-ui/vuu-data-remote";
import type { DataSourceConstructorProps } from "@vuu-ui/vuu-data-types";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Where trading data comes from:
 * - `inherit`: use the enclosing @vuu-ui/core DataProvider (a portal host or
 *   an outer provider). This is how MF features run inside vuu-portal.
 * - `local`: an in-browser LocalVuuServer (e.g. @heswell/trading-test-data).
 * - `remote`: a Vuu server connection already opened with
 *   ConnectionManager.connectTo(connectionId, ...) (see connectToVuuServer).
 */
export type TradingDataMode = "inherit" | "local" | "remote";

export type TradingDataProviderProps = { children: ReactNode } & (
  | {
      /** Use the enclosing @vuu-ui/core DataProvider (portal host). */
      mode: "inherit";
    }
  | {
      /** In-browser data. */
      mode: "local";
      /** e.g. `createTradingLocalServer()` from @heswell/trading-test-data/react. */
      localServer: LocalVuuServer;
    }
  | {
      /** A Vuu server connection. */
      mode: "remote";
      /** The id passed to connectToVuuServer / ConnectionManager.connectTo. */
      connectionId: string;
    }
);

export interface TradingDataModeContextValue {
  mode: TradingDataMode;
  connectionId?: string;
}

const TradingDataModeContext = createContext<TradingDataModeContextValue>({
  mode: "inherit",
});

/** The active TradingDataProvider mode (`inherit` without a provider). */
export const useTradingDataMode = () => useContext(TradingDataModeContext);

const RemoteDataProvider = ({
  children,
  connectionId,
}: {
  children: ReactNode;
  connectionId: string;
}) => {
  // Mirrors @vuu-ui/core VuuDataSourceProvider, but bound to an explicit
  // connectionId rather than the AuthenticationProvider's.
  const BoundVuuDataSource = useMemo(
    () =>
      class extends VuuDataSource {
        constructor(props: DataSourceConstructorProps) {
          super({ ...props, connectionId });
        }
      },
    [connectionId],
  );
  const getServerAPI = useMemo(
    () => () => ConnectionManager.serverAPIFor(connectionId),
    [connectionId],
  );
  return (
    <DataProvider
      VuuDataSource={BoundVuuDataSource}
      getServerAPI={getServerAPI}
      isLocalData={false}
    >
      {children}
    </DataProvider>
  );
};

/**
 * Selects the data source implementation for every trading component below
 * it. Components never construct data sources directly: they call
 * useTradingDataSource (or useData().VuuDataSource), so the same component
 * runs against the portal's server, a standalone server or local test data.
 */
export const TradingDataProvider = (props: TradingDataProviderProps) => {
  const { children, mode } = props;
  const connectionId =
    props.mode === "remote"
      ? props.connectionId
      : props.mode === "local"
        ? props.localServer.connectionId
        : undefined;
  const modeValue = useMemo(
    () => ({ mode, connectionId }),
    [mode, connectionId],
  );
  let content = children;
  if (props.mode === "local") {
    const { DataSourceProvider } = props.localServer;
    content = <DataSourceProvider>{children}</DataSourceProvider>;
  } else if (props.mode === "remote") {
    content = (
      <RemoteDataProvider connectionId={props.connectionId}>
        {children}
      </RemoteDataProvider>
    );
  }
  return (
    <TradingDataModeContext.Provider value={modeValue}>
      {content}
    </TradingDataModeContext.Provider>
  );
};

/** True when a data provider is available (outside one, data sources fail). */
export const useHasDataProvider = () => {
  const { VuuDataSource } = useData();
  return VuuDataSource?.name !== "NullDataSourceConstructor";
};
