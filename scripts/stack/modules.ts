import { TRADING_FEATURES } from "../../apps/features/trading/src/catalog";
import { navIconDataUri } from "../../apps/features/trading/src/navIcons";

/** The default features origin (scripts/stack/config.ts TRADER_FEATURES_PORT). */
export const DEFAULT_FEATURES_ORIGIN = "http://localhost:5110";

const q = (value: string) => JSON.stringify(value);

/**
 * apps/portal-config/default-modules.yaml for the trading features served
 * from `featuresOrigin` (each at <origin>/<key>).
 */
export const modulesYaml = (featuresOrigin = DEFAULT_FEATURES_ORIGIN) => {
  const idOf = new Map(TRADING_FEATURES.map((f) => [f.key, f.id]));
  const lines = [
    "# GENERATED from apps/features/trading/src/catalog.ts by",
    "# `bun run features:sync` (CI checks it): edit the catalog, not this file.",
    "#",
    "# Seeds the portal's runtime modules file on first start (start:all reseeds",
    "# when this file changes). Roles are vuu-portal client roles, see",
    "# docs/portal-integration.md. Child modules (parentModuleId != 0) have no",
    "# menu location: the parent renders them, and the server lists them only",
    "# when the user also holds the parent's role. navOrder sorts the nav",
    "# (sections by their lowest entry), navBadge keys a live badge the host",
    "# renders, notificationTopics routes NOTIFICATIONS rows by topic, workspace",
    "# lists the module in the Panels palette (VuuModuleDescriptor.workspace).",
    "modules:",
  ];
  for (const f of TRADING_FEATURES) {
    const parentModuleId = f.parent ? (idOf.get(f.parent) ?? 0) : 0;
    lines.push(
      `  - id: ${f.id}`,
      "    version: 1",
      `    parentModuleId: ${parentModuleId}`,
      `    name: ${q(f.name)}`,
      `    title: ${q(f.title)}`,
      `    description: ${q(f.description)}`,
      "    enabled: true",
      `    location: ${q(f.location ?? "")}`,
      `    path: ${q(f.path ?? "")}`,
      `    mfComponent: ${q(f.expose.replace(/^\.\//, ""))}`,
      `    mfScope: ${q(f.mfScope)}`,
      `    mfUrl: ${q(`${featuresOrigin}/${f.key}`)}`,
      `    navIconUrl: ${q(f.navIcon ? navIconDataUri(f.navIcon) : "")}`,
      `    accessRole: ${q(f.accessRole)}`,
    );
    if (f.navOrder !== undefined) lines.push(`    navOrder: ${f.navOrder}`);
    if (f.navBadge) lines.push(`    navBadge: ${q(f.navBadge)}`);
    if (f.notificationTopics?.length) {
      lines.push(
        `    notificationTopics: [${f.notificationTopics.map(q).join(", ")}]`,
      );
    }
    if (f.workspace) lines.push(`    workspace: ${JSON.stringify(f.workspace)}`);
  }
  return `${lines.join("\n")}\n`;
};
