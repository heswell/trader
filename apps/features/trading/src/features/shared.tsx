import {
  AccountSelector,
  TradingFeatureRoot,
  useSelectedAccount,
} from "@heswell/trading-ui";
import { usePortalModuleRegistry } from "@vuu-ui/core/portal";
import type { CSSProperties, ReactNode } from "react";

/** Portal roles (granted as `vuu-portal` client roles, see docs/portal-integration.md). */
export const ROLE = {
  view: "trading-view",
  execute: "trading-execute",
  supervisor: "trading-supervisor",
} as const;

/**
 * What the signed-in user may do, derived from the modules the portal server
 * registered for them: the server only sends modules whose `accessRole` the
 * user holds, so a module gated by `trading-execute` proves the role. The
 * OMS enforces the same roles on every RPC; this only shapes the UI.
 */
export const useEntitlements = () => {
  let modules: readonly { accessRole?: string }[] = [];
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: always called; try only guards the throw outside a portal (standalone dev)
    modules = usePortalModuleRegistry().remoteModules;
  } catch {
    modules = [];
  }
  const has = (role: string) => modules.some((m) => m.accessRole === role);
  return { canTrade: has(ROLE.execute), isSupervisor: has(ROLE.supervisor) };
};

const frame: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  height: "100%",
  minHeight: 0,
  padding: 4,
};
const toolbarStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 8,
};
/** Style for a component that fills the rest of a FeatureFrame. */
export const fillStyle: CSSProperties = { flex: 1, minHeight: 0 };

export const FeatureFrame = ({
  children,
  toolbar,
}: {
  children: ReactNode;
  toolbar?: ReactNode;
}) => (
  <div style={frame}>
    {toolbar ? <div style={toolbarStyle}>{toolbar}</div> : null}
    {children}
  </div>
);

/**
 * Every exposed feature renders inside a TradingFeatureRoot: the first one
 * in a window mounts the notification toasts / connection banner / ticket
 * launcher, nested ones (e.g. child modules of the Trader workspace) reuse
 * the enclosing root.
 */
export const withFeatureRoot = <P extends object>(
  Component: (props: P) => ReactNode,
  displayName: string,
) => {
  const Feature = (props: P) => (
    <TradingFeatureRoot>
      <Component {...props} />
    </TradingFeatureRoot>
  );
  Feature.displayName = displayName;
  return Feature;
};

/** An account dropdown + the selected account (for depth / ladder). */
export const useAccountToolbar = () => {
  const [account, setAccount, accounts] = useSelectedAccount();
  const toolbar = (
    <AccountSelector
      accounts={accounts}
      onChange={setAccount}
      value={account}
    />
  );
  return { account, toolbar };
};
