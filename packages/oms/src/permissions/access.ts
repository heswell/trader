import type { Account } from "../reference/accounts";

/** Client roles (Keycloak `vuu-portal` client) recognised by the OMS. */
export const TradingRole = Object.freeze({
  /** See own accounts' orders, fills and positions. */
  View: "trading-view",
  /** Submit / amend / cancel orders for visible accounts. */
  Execute: "trading-execute",
  /** See every account of the desks the user owns accounts in (all desks if none). */
  Supervisor: "trading-supervisor",
} as const);
export type TradingRole = (typeof TradingRole)[keyof typeof TradingRole];
export const TRADING_ROLES: readonly string[] = Object.values(TradingRole);

export type PermissionMode = "auto" | "strict";

export interface TradingUser {
  name: string;
  authorizations: readonly string[];
}

export interface AccessScope {
  /** True when every account (present and future) is visible. */
  readonly all: boolean;
  readonly accounts: ReadonlySet<string>;
  readonly canExecute: boolean;
  /** How the scope was derived, for logs / errors. */
  readonly basis: "trader" | "supervisor" | "dev" | "none";
}

const scope = (
  basis: AccessScope["basis"],
  accounts: Iterable<string> | "all",
  canExecute: boolean,
): AccessScope => ({
  all: accounts === "all",
  accounts: new Set(accounts === "all" ? [] : accounts),
  canExecute,
  basis,
});

/**
 * Resolve what a user can see and trade.
 *
 * - trading-supervisor: accounts of every desk in which the user owns an
 *   account; all accounts if the user owns none.
 * - trading-view / trading-execute: accounts the user owns.
 * - trading-execute is required to trade (any visible account).
 * - No trading-* role: in `auto` mode (dev / permissive auth, which grants no
 *   roles) owners see and trade their own accounts and anyone else sees and
 *   trades everything; in `strict` mode the user sees nothing.
 */
export const resolveAccess = (
  user: TradingUser,
  accounts: readonly Account[],
  mode: PermissionMode = "auto",
): AccessScope => {
  const roles = new Set(user.authorizations);
  const owned = accounts.filter((a) => a.owner === user.name);
  const canExecute = roles.has(TradingRole.Execute);
  if (roles.has(TradingRole.Supervisor)) {
    if (owned.length === 0) return scope("supervisor", "all", canExecute);
    const desks = new Set(owned.map((a) => a.desk));
    return scope(
      "supervisor",
      accounts.filter((a) => desks.has(a.desk)).map((a) => a.account),
      canExecute,
    );
  }
  if (roles.has(TradingRole.View) || canExecute) {
    return scope(
      "trader",
      owned.map((a) => a.account),
      canExecute,
    );
  }
  if (mode === "strict") return scope("none", [], false);
  return owned.length > 0
    ? scope(
        "dev",
        owned.map((a) => a.account),
        true,
      )
    : scope("dev", "all", true);
};

export const canSeeAccount = (access: AccessScope, account: unknown) =>
  access.all || (typeof account === "string" && access.accounts.has(account));
