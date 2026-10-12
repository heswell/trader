import { useModuleRegistry } from "@vuu-ui/core";
import {
  NavContainer,
  PortalAppSwitcher,
  PortalHeader,
  PortalLogo,
  PortalShell,
} from "@vuu-ui/core/portal";
import { VuuLogo } from "@vuu-ui/vuu-icons";

import "./App.css";

/** The portal id keys saved state (layouts) in the browser: keep it stable. */
export const PORTAL_ID = "trader-portal";

export const App = () => {
  const { modules: remoteModules } = useModuleRegistry();
  return (
    <PortalShell id={PORTAL_ID} remoteModules={remoteModules} title="Trader">
      <NavContainer>
        <PortalLogo alt="Portal home">
          <VuuLogo />
        </PortalLogo>
        <PortalAppSwitcher remoteModules={remoteModules} />
      </NavContainer>
      <PortalHeader />
    </PortalShell>
  );
};
