import { Dropdown, Option } from "@salt-ds/core";
import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import {
  LAST_ACCOUNT_STORAGE_KEY,
  type OrderTicketAccount,
} from "../OrderTicket";

const ACCOUNT_COLUMNS = [
  "account",
  "name",
  "desk",
  "owner",
  "currency",
  "enabled",
];

/** Enabled accounts visible to the user (from the OMS `accounts` table). */
export const useTradingAccounts = (): OrderTicketAccount[] => {
  const { rows } = useTradingRows("accounts", {
    columns: ACCOUNT_COLUMNS,
    rowCount: 200,
  });
  return useMemo(
    () =>
      (rows as unknown as OrderTicketAccount[]).filter(
        (a) => a.enabled !== false,
      ),
    [rows],
  );
};

const readLastAccount = () => {
  try {
    return (
      globalThis.localStorage?.getItem(LAST_ACCOUNT_STORAGE_KEY) ?? undefined
    );
  } catch {
    return undefined;
  }
};

/**
 * The account a component trades / shows own orders for: the caller's
 * choice, else the order ticket's last account, else the first visible one.
 * Returns [account, setAccount, accounts].
 */
export const useSelectedAccount = (
  initial?: string,
): [string | undefined, (account: string) => void, OrderTicketAccount[]] => {
  const accounts = useTradingAccounts();
  const [chosen, setChosen] = useState(initial);
  const [fallback, setFallback] = useState<string>();
  useEffect(() => {
    if (accounts.length === 0) return;
    const last = readLastAccount();
    setFallback(
      accounts.find((a) => a.account === last)?.account ?? accounts[0].account,
    );
  }, [accounts]);
  const account =
    chosen && accounts.some((a) => a.account === chosen) ? chosen : fallback;
  return [account, setChosen, accounts];
};

export interface AccountSelectorProps {
  /** Accounts to offer, e.g. from useSelectedAccount / useTradingAccounts. */
  accounts: readonly OrderTicketAccount[];
  /** Accessible name (default "Account"). */
  "aria-label"?: string;
  className?: string;
  /** Called with the account id the user picked. */
  onChange: (account: string) => void;
  /** The selected account id. */
  value?: string;
}

/** A compact account dropdown for component toolbars. */
export const AccountSelector = ({
  accounts,
  "aria-label": ariaLabel = "Account",
  className,
  onChange,
  value,
}: AccountSelectorProps) => (
  <Dropdown<string>
    aria-label={ariaLabel}
    bordered
    className={className}
    disabled={accounts.length === 0}
    onSelectionChange={(_e: SyntheticEvent, [selected]: string[]) => {
      if (selected) onChange(selected);
    }}
    placeholder="No account"
    selected={value ? [value] : []}
    value={value ?? ""}
    variant="secondary"
  >
    {accounts.map((a) => (
      <Option key={a.account} value={a.account}>
        {a.name ? `${a.account} · ${a.name}` : a.account}
      </Option>
    ))}
  </Dropdown>
);
