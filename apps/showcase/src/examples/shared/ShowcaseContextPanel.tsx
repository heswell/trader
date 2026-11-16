import { ShellContextPanel, ShellContextPanelProvider } from "@vuu-ui/core";
import type { ReactNode } from "react";

/**
 * Stands in for the portal shell's context panel, so components that show
 * a context panel (the instrument grid's column picker, the blotter's order
 * book) open it at the right edge rather than in a dialog.
 */
export const ShowcaseContextPanel = ({ children }: { children: ReactNode }) => (
  <ShellContextPanelProvider>
    <div
      style={{
        display: "flex",
        height: "100%",
        minWidth: 0,
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {children}
      </div>
      {/* PortalShell's css gives the panel its height */}
      <style>{".showcaseContextPanel>.vuuContextPanel{height:100%}"}</style>
      <ShellContextPanel className="showcaseContextPanel" />
    </div>
  </ShellContextPanelProvider>
);
