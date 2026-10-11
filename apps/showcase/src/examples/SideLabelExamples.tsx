import { Side } from "@heswell/trading-schemas";
import { SideLabel } from "@heswell/trading-ui";

export const SideLabelExamples = () => (
  <div style={{ display: "flex", gap: 16, padding: 16 }}>
    <SideLabel side={Side.Buy} />
    <SideLabel side={Side.Sell} />
    <SideLabel side={Side.Buy} variant="pill" />
    <SideLabel side={Side.Sell} variant="pill" />
  </div>
);
