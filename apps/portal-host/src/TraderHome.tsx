import { Link } from "react-router-dom";

/**
 * Content for the portal root (`/`), where the nav brand links to. App.tsx
 * wraps it in `<PortalLandingPage>`, which must be a direct PortalShell child.
 */
export const TraderHome = () => (
  <div className="traderHome">
    <h1>Trader</h1>
    <p>Choose a page from the navigation, or open a workspace.</p>
    <Link className="traderHome-link" to="/workspaces/trader">
      Open the Trader workspace
    </Link>
  </div>
);
