import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import simulatorControlsCss from "./SimulatorControls.css";

export const controlsClass = "tradingSimControls";

export const useControlsCss = () =>
  useComponentCssInjection({
    testId: "trading-simulator-controls",
    css: simulatorControlsCss,
    window: useWindow(),
  });

export const plain = (value: unknown) =>
  value === null || value === undefined || value === "" ? "–" : String(value);
