import type { ComponentType } from "react";

export interface ShowcaseExample {
  /** Unique, url-safe id: `<component>-<variant>`, e.g. `price-ladder-basic`. */
  id: string;
  title: string;
  /** Group in the sidebar, normally the component name. */
  group: string;
  description?: string;
  Component: ComponentType;
}
