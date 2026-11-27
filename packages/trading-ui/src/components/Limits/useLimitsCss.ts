import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import limitsCss from "./Limits.css";

/** Injects the limits stylesheet (shared by every limits component). */
export const useLimitsCss = () => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-limits",
    css: limitsCss,
    window: targetWindow,
  });
};
