/** A row of the OMS `accounts` table. Limits are in USD. */
export interface Account {
  account: string;
  name: string;
  desk: string;
  /** Trader (user name) that owns the account. */
  owner: string;
  currency: string;
  maxOrderQty: number;
  maxOrderNotional: number;
  maxPositionNotional: number;
  enabled: boolean;
}

const account = (
  account: string,
  name: string,
  desk: string,
  owner: string,
  maxOrderQty: number,
  maxOrderNotional: number,
  maxPositionNotional: number,
  enabled = true,
): Account => ({
  account,
  name,
  desk,
  owner,
  currency: "USD",
  maxOrderQty,
  maxOrderNotional,
  maxPositionNotional,
  enabled,
});

/**
 * Seeded accounts: three desks, five traders. `sam` is a supervisor (no
 * accounts). ACC-ASIA-03 is disabled so the ACCOUNT_DISABLED path can be shown.
 */
export const SEED_ACCOUNTS: readonly Account[] = Object.freeze([
  account(
    "ACC-US-01",
    "US Flow",
    "EQ-US",
    "alice",
    50_000,
    2_000_000,
    10_000_000,
  ),
  account("ACC-US-02", "US Prop", "EQ-US", "bob", 20_000, 1_000_000, 5_000_000),
  account(
    "ACC-EU-01",
    "EU Flow",
    "EQ-EU",
    "carol",
    100_000,
    2_000_000,
    10_000_000,
  ),
  account("ACC-EU-02", "EU Prop", "EQ-EU", "dave", 50_000, 750_000, 3_000_000),
  account(
    "ACC-ASIA-01",
    "Asia Flow",
    "EQ-ASIA",
    "erin",
    200_000,
    1_500_000,
    8_000_000,
  ),
  account(
    "ACC-ASIA-02",
    "Asia Prop",
    "EQ-ASIA",
    "erin",
    100_000,
    500_000,
    2_000_000,
  ),
  account(
    "ACC-ASIA-03",
    "Asia Legacy",
    "EQ-ASIA",
    "erin",
    10_000,
    100_000,
    500_000,
    false,
  ),
]);

/** Desk of the simulated clients (OMS client bots). */
export const SIM_CLIENTS_DESK = "SIM-CLIENTS";
/** Owner (user name) of the Sim clients accounts. */
export const SIM_CLIENTS_OWNER = "simclient";

/**
 * The Sim clients desk: `count` accounts CLIENT-01… with institutional
 * limits (about $2m per order, $25m position), traded by the client bots.
 */
export const simClientAccounts = (count: number): Account[] =>
  Array.from({ length: count }, (_, i) =>
    account(
      `CLIENT-${String(i + 1).padStart(2, "0")}`,
      `Sim client ${i + 1}`,
      SIM_CLIENTS_DESK,
      SIM_CLIENTS_OWNER,
      1_000_000,
      2_000_000,
      25_000_000,
    ),
  );
