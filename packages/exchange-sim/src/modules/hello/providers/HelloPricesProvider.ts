import { Provider } from "@heswell/vuu-server";

type ProviderTable = ConstructorParameters<typeof Provider>[0];

export const HELLO_INSTRUMENTS: readonly [string, string, number][] = [
  ["VOD.L", "Vodafone Group", 72.5],
  ["BP.L", "BP plc", 480.1],
  ["HSBA.L", "HSBC Holdings", 690.3],
  ["AAPL.OQ", "Apple Inc", 190.25],
  ["MSFT.OQ", "Microsoft Corp", 410.8],
  ["SAP.DE", "SAP SE", 175.4],
];

/** Seeds a handful of instruments and random-walks their prices on a timer. */
export class HelloPricesProvider extends Provider {
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #mids = new Map<string, number>();
  readonly #ticks = new Map<string, number>();

  constructor(
    table: ProviderTable,
    private readonly tickIntervalMs = 250,
  ) {
    super(table);
  }

  async load() {
    for (const [ric, description, mid] of HELLO_INSTRUMENTS) {
      this.#mids.set(ric, mid);
      this.#ticks.set(ric, 0);
      this.table.insert([ric, description, ...this.#quote(mid), mid, 0], false);
    }
    this.#timer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  tick() {
    const [ric, ,] =
      HELLO_INSTRUMENTS[Math.floor(Math.random() * HELLO_INSTRUMENTS.length)];
    const mid =
      (this.#mids.get(ric) ?? 100) * (1 + (Math.random() - 0.5) * 0.002);
    const ticks = (this.#ticks.get(ric) ?? 0) + 1;
    this.#mids.set(ric, mid);
    this.#ticks.set(ric, ticks);
    const [bid, ask] = this.#quote(mid);
    this.table.updateByKey(ric, { bid, ask, last: round(mid), ticks });
  }

  doStop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #quote(mid: number): [number, number] {
    const halfSpread = mid * 0.0005;
    return [round(mid - halfSpread), round(mid + halfSpread)];
  }
}

const round = (value: number) => Math.round(value * 100) / 100;
