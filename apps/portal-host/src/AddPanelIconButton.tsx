import { usePanelsPaletteState } from "@vuu-ui/core/portal";
import { IconButton } from "@vuu-ui/vuu-ui-controls";
import { useEffect } from "react";

/**
 * "Add panel" for the workspace header as a vuu IconButton: toggles the
 * Panels palette, like vuu-ui's AddPanelButton, without its text label.
 */
export const AddPanelIconButton = () => {
  const paletteState = usePanelsPaletteState();
  const register = paletteState?.register;
  // Tell the shell a palette trigger exists (as AddPanelButton does).
  useEffect(() => register?.(), [register]);
  if (!paletteState) return null;
  return (
    <IconButton
      aria-label="Add panel"
      aria-pressed={paletteState.open}
      className="traderAddPanelButton"
      icon="add"
      onClick={paletteState.toggleOpen}
      sentiment="accented"
      title="Add panel"
    />
  );
};
