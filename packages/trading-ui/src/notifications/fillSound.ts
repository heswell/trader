type AudioContextCtor = typeof AudioContext;

type AudioWindow = {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
};

const audioContextCtor = (
  win: Window | undefined,
): AudioContextCtor | undefined => {
  const w = win as AudioWindow | undefined;
  return w?.AudioContext ?? w?.webkitAudioContext;
};

/**
 * A short Web Audio beep for fills. Browsers only allow audio after a user
 * gesture, so the AudioContext is created / resumed by `arm()`, which must be
 * called from a click or key handler (e.g. the "enable sound" toggle).
 * `beep()` is a no-op until armed, and never throws.
 */
export class FillSound {
  #context: AudioContext | undefined;
  readonly #window: Window | undefined;

  constructor(win: Window | undefined = globalThis.window) {
    this.#window = win;
  }

  get supported() {
    return audioContextCtor(this.#window) !== undefined;
  }

  get armed() {
    return this.#context !== undefined && this.#context.state === "running";
  }

  /** Create / resume the AudioContext. Call from a user gesture handler. */
  arm(): boolean {
    const Ctor = audioContextCtor(this.#window);
    if (!Ctor) return false;
    try {
      const context = this.#context ?? new Ctor();
      this.#context = context;
      if (context.state === "suspended") void context.resume();
      return true;
    } catch {
      return false;
    }
  }

  beep({ frequency = 880, durationMs = 120, volume = 0.08 } = {}) {
    const context = this.#context;
    if (!context || context.state !== "running") return false;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const end = start + durationMs / 1000;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end);
      return true;
    } catch {
      return false;
    }
  }

  dispose() {
    void this.#context?.close().catch(() => undefined);
    this.#context = undefined;
  }
}
