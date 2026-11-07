import type { ScenarioDef } from "../src/engine/control/ScenarioRunner";
import calm from "./calm.json";
import flashCrash from "./flash-crash.json";
import liquidityCrunch from "./liquidity-crunch.json";
import newsJump from "./news-jump.json";
import trendingDay from "./trending-day.json";
import volatileOpen from "./volatile-open.json";

/** The scenarios every simulator starts with (also bundled for the browser). */
export const BUILT_IN_SCENARIOS: readonly ScenarioDef[] = [
  calm,
  volatileOpen,
  trendingDay,
  liquidityCrunch,
  flashCrash,
  newsJump,
] as ScenarioDef[];
