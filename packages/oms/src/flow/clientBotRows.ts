import { botParamKey } from "@heswell/trading-schemas";
import type { TableSink } from "../modules/oms/TableSink";
import type { ClientBot, ClientFlow } from "./ClientFlow";
import { CLIENT_PARAM_SPECS } from "./clientPersonas";

/**
 * Keep the clientBots and clientBotParams tables in step with `flow`:
 * stats rows on the flow's publish interval, parameter rows when they
 * change, both deleted when a bot is removed.
 */
export const publishClientBots = (
  flow: ClientFlow,
  sink: TableSink,
  clock: () => number,
) => {
  const lastParams = new Map<string, string>();
  const write = (bot: ClientBot) => {
    sink.clientBot({
      botId: bot.id,
      persona: bot.persona,
      account: bot.account.account,
      paused: bot.paused,
      sideMode: bot.params.sideMode,
      ordersPerMin: bot.params.ordersPerMin,
      submitted: bot.submitted,
      rejected: bot.rejected,
      completed: bot.completed,
      lastOrderId: bot.lastOrderId,
      lastReject: bot.lastReject,
      updated: clock(),
      ...flow.stats(bot),
    });
    const params = bot.params as unknown as Record<string, unknown>;
    const baseline = bot.baseline as unknown as Record<string, unknown>;
    const signature = JSON.stringify(params);
    if (lastParams.get(bot.id) === signature) return;
    lastParams.set(bot.id, signature);
    for (const spec of [
      { name: "persona", type: "string", readOnly: true, description: "" },
      { name: "account", type: "string", readOnly: true, description: "" },
      ...CLIENT_PARAM_SPECS,
    ] as const) {
      const identity = spec.name === "persona" || spec.name === "account";
      const value = identity
        ? spec.name === "persona"
          ? bot.persona
          : bot.account.account
        : params[spec.name];
      const base = identity ? value : baseline[spec.name];
      const range = "min" in spec || "max" in spec;
      const row: Record<string, unknown> = {
        id: botParamKey(bot.id, spec.name),
        botId: bot.id,
        persona: bot.persona,
        account: bot.account.account,
        name: spec.name,
        type: spec.type,
        value: String(value),
        min: range && "min" in spec ? spec.min : null,
        max: range && "max" in spec ? spec.max : null,
        unit: ("unit" in spec ? spec.unit : undefined) ?? "",
        description:
          spec.description ||
          (spec.name === "persona"
            ? "Starter persona the bot was added from."
            : "Account the bot trades."),
        readOnly: "readOnly" in spec && spec.readOnly === true,
        baseline: String(base),
        changed: base !== value,
      };
      for (const key of ["min", "max"]) row[key] ??= null;
      sink.clientBotParam(row);
    }
  };
  const offChange = flow.onBotChange(write);
  const offRemoved = flow.onBotRemoved((bot) => {
    lastParams.delete(bot.id);
    sink.deleteRow("clientBots", bot.id);
    for (const spec of [
      "persona",
      "account",
      ...CLIENT_PARAM_SPECS.map((s) => s.name),
    ])
      sink.deleteRow("clientBotParams", botParamKey(bot.id, spec));
  });
  for (const bot of flow.bots) write(bot);
  return () => {
    offChange();
    offRemoved();
  };
};
