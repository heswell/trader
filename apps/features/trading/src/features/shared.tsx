import {
  AccountSelector,
  InstrumentPicker,
  type LinkGroupId,
  TradingFeatureRoot,
  useSelectedAccount,
} from "@heswell/trading-ui";
import { useVuuAuthorizations } from "@vuu-ui/core";
import type { CSSProperties, ReactNode } from "react";

/**
 * Trading server roles (`trader-trading-server` client roles, see
 * docs/portal-integration.md).
 */
export const ROLE = {
  view: "trading-view",
  execute: "trading-execute",
  supervisor: "trading-supervisor",
} as const;

/**
 * What the signed-in user may do: the roles of the trading Vuu session (the
 * remote's config.json connection, whose token the trading server issued).
 * The OMS enforces the same roles on every RPC; this only shapes the UI.
 */
export const useEntitlements = () => {
  let roles: readonly string[] = [];
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: always called; try only guards the throw without a Vuu connection (standalone dev)
    roles = useVuuAuthorizations();
  } catch {
    roles = [];
  }
  return {
    canTrade: roles.includes(ROLE.execute),
    isSupervisor: roles.includes(ROLE.supervisor),
  };
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
 * Props of a feature that follows a link group. A portal workspace item
 * passes them as its `portal-module` props (see the Trader system
 * workspace); the user's later choice in the selector is saved per item.
 */
export interface LinkedFeatureProps {
  /** Link group used until the user picks another. */
  defaultLinkGroup?: LinkGroupId;
}

/** Props of a feature that can host an instrument picker in its toolbar. */
export interface PickerFeatureProps extends LinkedFeatureProps {
  /**
   * Show an InstrumentPicker (with its own link group selector, initially
   * the feature's group) that publishes to the group. Default `true`, so a
   * panel added from the Panels palette (no props) drives its own group.
   */
  showInstrumentPicker?: boolean;
}

/** Toolbar picker of a PickerFeatureProps feature (saved under `id`). */
export const ToolbarPicker = ({
  id,
  linkGroup,
}: {
  id: string;
  linkGroup: LinkGroupId;
}) => (
  <InstrumentPicker
    aria-label="Instrument"
    defaultLinkGroup={linkGroup}
    id={id}
    placeholder="Search ric"
    showLinkGroupSelector
    style={{ width: 240 }}
  />
);

/**
 * Every exposed feature renders inside a TradingFeatureRoot: the first one
 * in a window mounts the notification toasts / connection banner / ticket
 * launcher, nested ones reuse the enclosing root. Each item of a portal
 * workspace is its own remote module and so its own root.
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
export const useAccountToolbar = (before?: ReactNode) => {
  const [account, setAccount, accounts] = useSelectedAccount();
  const toolbar = (
    <>
      {before}
      <AccountSelector
        accounts={accounts}
        onChange={setAccount}
        value={account}
      />
    </>
  );
  return { account, toolbar };
};
