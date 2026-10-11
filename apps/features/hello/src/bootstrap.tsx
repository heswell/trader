import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (!container) {
  throw Error("Root element not found");
}

createRoot(container).render(
  <div style={{ padding: 24 }}>
    The hello feature must be loaded by the portal host (it needs a host-managed
    Vuu connection).
  </div>,
);
