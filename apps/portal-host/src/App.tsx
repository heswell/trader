import { useModuleRegistry } from "@vuu-ui/core";
import {
  AddPanelButton,
  createPortalComponentRegistries,
  PortalShell,
  type PortalWorkspacesOptions,
} from "@vuu-ui/core/portal";
import { TraderNav } from "./nav/TraderNav";
import { SYSTEM_WORKSPACES } from "./workspaces/traderWorkspace";

import "./App.css";

/** The portal id keys saved state (layouts) in the browser: keep it stable. */
export const PORTAL_ID = "trader-portal";

const registries = createPortalComponentRegistries();

/**
 * Portal workspaces: the Trader system workspace and the user's own, made
 * of `portal-module` items. "Add panel" in the workspace header opens the
 * Panels palette (the modules with `workspace` metadata) in the shell's
 * context panel.
 */
export const WORKSPACES: PortalWorkspacesOptions = {
  componentRenderers: registries.renderers,
  headerActions: <AddPanelButton />,
  settingsCodecs: registries.settingsCodecs,
  systemWorkspaces: SYSTEM_WORKSPACES,
};

export interface AppProps {
  /** Environment chip in the nav brand, from config.json `environment`. */
  environment?: string;
}

/**
 * The context panel (the Panels palette, the ticket launcher) takes its own
 * column beside the content rather than covering it.
 */
const CONTEXT_PANEL = { placement: "inline" } as const;

export const App = ({ environment }: AppProps) => {
  const { modules: remoteModules } = useModuleRegistry();
  return (
    <PortalShell
      contextPanel={CONTEXT_PANEL}
      header={false}
      id={PORTAL_ID}
      remoteModules={remoteModules}
      title="Trader"
      workspaces={WORKSPACES}
    >
      <TraderNav environment={environment} remoteModules={remoteModules} />
    </PortalShell>
  );
};
