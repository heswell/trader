import "@vuu-ui/vuu-icons/index.css";
import "@vuu-ui/vuu-theme/index.css";
// registers the vuu.price-move-background (and other) cell renderers
import "@vuu-ui/vuu-table-extras";
import { SaltProviderNext } from "@salt-ds/core";
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ShowcaseApp, type ShowcaseThemeMode } from "./ShowcaseApp";

const MODE_KEY = "showcase.mode";

/** `?mode=dark` (screenshots), else the last choice, else light. */
const initialMode = (): ShowcaseThemeMode => {
  const fromUrl = new URLSearchParams(window.location.search).get("mode");
  if (fromUrl === "dark" || fromUrl === "light") return fromUrl;
  try {
    return localStorage.getItem(MODE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
};

const ShowcaseRoot = () => {
  const [mode, setMode] = useState(initialMode);
  const changeMode = useCallback((next: ShowcaseThemeMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // private window: the choice lasts for this page only
    }
  }, []);
  return (
    <SaltProviderNext theme="vuu-theme" density="high" mode={mode}>
      <ShowcaseApp mode={mode} onModeChange={changeMode} />
    </SaltProviderNext>
  );
};

const container = document.getElementById("root");
if (!container) throw Error("#root element missing");

createRoot(container).render(
  <StrictMode>
    <ShowcaseRoot />
  </StrictMode>,
);
