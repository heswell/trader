import {
  filterString,
  orderBlotterTabFilter,
  useDataSourceRows,
  useTradingDataSource,
} from "@heswell/trading-ui";
import {
  AuthenticationProvider,
  useAuthenticatedUser,
  usePortalVuuAuthTarget,
  useVuuServers,
  type VuuServerDescriptor,
} from "@vuu-ui/core";
import { useEffect, useMemo } from "react";
import type { TradingNavBadgeValues } from "./tradingNavBadges";

export type TradingServerConnection = Pick<
  VuuServerDescriptor,
  "connectionId" | "restUrl" | "websocketUrl"
>;

/** The connection id the trading features publish in their config.json. */
export const TRADING_CONNECTION_ID = "trading";

export interface TradingNavFeedValues {
  badges: TradingNavBadgeValues;
  /** The user's own trading account (none for a supervisor). */
  account?: string;
}

/**
 * The trading server among the servers the registered modules use: the one
 * with the trading connection id, else the first that isn't the portal's.
 */
export const findTradingServer = (
  servers: readonly VuuServerDescriptor[],
  portalConnectionId: string,
): TradingServerConnection | undefined => {
  const server =
    servers.find((s) => s.connectionId === TRADING_CONNECTION_ID) ??
    servers.find((s) => s.connectionId !== portalConnectionId);
  if (!server) return undefined;
  const { connectionId, restUrl, websocketUrl } = server;
  return { connectionId, restUrl, websocketUrl };
};

/** The trading server connection, from the registered modules' servers. */
export const useTradingServer = () => {
  const servers = useVuuServers();
  const portalTarget = usePortalVuuAuthTarget();
  return useMemo(
    () => findTradingServer(servers, portalTarget.connectionId),
    [servers, portalTarget.connectionId],
  );
};

const sumColumn = (rows: readonly Record<string, unknown>[], column: string) =>
  rows.reduce((total, row) => total + (Number(row[column]) || 0), 0);

const MAX_POSITIONS = 2_000;

interface FeedProps {
  onChange: (values: TradingNavFeedValues) => void;
}

const Feed = ({ onChange }: FeedProps) => {
  const { userName } = useAuthenticatedUser();

  // As the Orders blotter's Working tab: the server's permission filter
  // scopes parentOrders to the accounts the user may see.
  const orders = useTradingDataSource("parentOrders", { columns: ["orderId"] });
  const working = useDataSourceRows(orders, {
    filter: orderBlotterTabFilter("working"),
    rowCount: 1,
  });

  // As the Positions view totals, but converted to USD so they can be summed.
  const positions = useTradingDataSource("positionPrices", {
    columns: ["totalPnlUsd"],
  });
  const positionRows = useDataSourceRows(positions, {
    filter: "",
    rowCount: MAX_POSITIONS,
  });

  const accounts = useTradingDataSource("accounts", {
    columns: ["account", "owner"],
  });
  const ownAccounts = useDataSourceRows(accounts, {
    filter: `owner = ${filterString(userName)}`,
    rowCount: 1,
  });

  const ordersWorking = working.loaded ? working.size : undefined;
  const dayPnl = positionRows.loaded
    ? Math.round(sumColumn(positionRows.rows, "totalPnlUsd"))
    : undefined;
  const account = ownAccounts.rows[0]?.account as string | undefined;

  useEffect(() => {
    onChange({
      account,
      badges: {
        "orders.working": ordersWorking,
        "positions.dayPnl": dayPnl,
      },
    });
  }, [account, dayPnl, onChange, ordersWorking]);

  return null;
};

/**
 * Feeds the nav badges and the user menu's account from the trading
 * server: small viewports on parentOrders, positionPrices and accounts over
 * the same (shared) connection the trading features use. Renders nothing.
 */
export const TradingNavFeed = ({ onChange }: FeedProps) => {
  const connection = useTradingServer();
  if (!connection) return null;
  return (
    <AuthenticationProvider
      connection={connection}
      mode="vuu-connection"
      onError={(error) => console.warn("[TradingNavFeed]", error)}
    >
      <Feed onChange={onChange} />
    </AuthenticationProvider>
  );
};
