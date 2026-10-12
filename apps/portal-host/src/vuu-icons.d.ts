// @vuu-ui/vuu-icons 4.0.0-alpha.21 ships JS without type declarations for its main entry.
declare module "@vuu-ui/vuu-icons" {
  import type { HTMLAttributes } from "react";
  export const VuuLogo: (props: HTMLAttributes<HTMLSpanElement>) => JSX.Element;
}
