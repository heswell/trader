import { useModuleRegistry } from "@vuu-ui/core";
import { PortalShell } from "@vuu-ui/core/portal";
import { TraderNav } from "./nav/TraderNav";

import "./App.css";

/** The portal id keys saved state (layouts) in the browser: keep it stable. */
export const PORTAL_ID = "trader-portal";

export interface AppProps {
  /** Environment chip in the nav brand, from config.json `environment`. */
  environment?: string;
}

export const App = ({ environment }: AppProps) => {
  const { modules: remoteModules } = useModuleRegistry();
  return (
    <PortalShell
      header={false}
      id={PORTAL_ID}
      remoteModules={remoteModules}
      title="Trader"
    >
      <TraderNav environment={environment} remoteModules={remoteModules} />
    </PortalShell>
  );
};
