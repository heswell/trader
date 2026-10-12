import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (!container) throw Error("Root element not found");

createRoot(container).render(
  <div style={{ padding: 24, fontFamily: "sans-serif" }}>
    The trading features are module-federation remotes: open them from the
    portal (<code>bun run start:all</code>, then the /Trading menu). They use
    the portal&apos;s authenticated Vuu connection.
  </div>,
);
