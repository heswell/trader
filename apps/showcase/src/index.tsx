import "@vuu-ui/vuu-icons/index.css";
import "@vuu-ui/vuu-theme/index.css";
// registers the vuu.price-move-background (and other) cell renderers
import "@vuu-ui/vuu-table-extras";
import { SaltProviderNext } from "@salt-ds/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShowcaseApp } from "./ShowcaseApp";

const container = document.getElementById("root");
if (!container) throw Error("#root element missing");

createRoot(container).render(
  <StrictMode>
    <SaltProviderNext theme="vuu-theme" density="high" mode="light">
      <ShowcaseApp />
    </SaltProviderNext>
  </StrictMode>,
);
