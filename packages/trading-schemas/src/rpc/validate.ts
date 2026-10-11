/**
 * Minimal runtime validator for flat RPC params (Vuu RPC params are a flat
 * Record<string, string | number | boolean>). No external dependencies.
 */

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type Validator<T> = (
  value: unknown,
  path: string,
) => ValidationResult<T>;

const ok = <T>(value: T): ValidationResult<T> => ({ ok: true, value });
const fail = (error: string): ValidationResult<never> => ({
  ok: false,
  errors: [error],
});

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
}

export const string =
  ({ minLength = 1, maxLength = 128 }: StringOptions = {}): Validator<string> =>
  (value, path) => {
    if (value === undefined || value === null)
      return fail(`${path} is required`);
    if (typeof value !== "string") return fail(`${path} must be a string`);
    const v = value.trim();
    if (v.length < minLength) return fail(`${path} is required`);
    if (v.length > maxLength)
      return fail(`${path} must be at most ${maxLength} characters`);
    return ok(v);
  };

export interface NumberOptions {
  integer?: boolean;
  /** Inclusive minimum. */
  min?: number;
  /** Exclusive minimum. */
  greaterThan?: number;
  max?: number;
}

export const number =
  ({ integer, min, greaterThan, max }: NumberOptions = {}): Validator<number> =>
  (value, path) => {
    // Accept numeric strings, some clients send all params as strings.
    if (value === undefined || value === null)
      return fail(`${path} is required`);
    const n =
      typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n))
      return fail(`${path} must be a number`);
    if (integer && !Number.isInteger(n))
      return fail(`${path} must be an integer`);
    if (min !== undefined && n < min) return fail(`${path} must be >= ${min}`);
    if (greaterThan !== undefined && n <= greaterThan)
      return fail(`${path} must be > ${greaterThan}`);
    if (max !== undefined && n > max) return fail(`${path} must be <= ${max}`);
    return ok(n);
  };

export const boolean = (): Validator<boolean> => (value, path) =>
  typeof value === "boolean"
    ? ok(value)
    : value === "true" || value === "false"
      ? ok(value === "true")
      : fail(`${path} must be a boolean`);

export const oneOf =
  <T extends string>(allowed: readonly T[]): Validator<T> =>
  (value, path) =>
    typeof value === "string" && allowed.includes(value as T)
      ? ok(value as T)
      : fail(`${path} must be one of ${allowed.join(", ")}`);

declare const optionalBrand: unique symbol;
export type OptionalValidator<T> = Validator<T | undefined> & {
  [optionalBrand]: true;
};

/** undefined, null and "" are treated as absent. */
export const optional = <T>(validator: Validator<T>): OptionalValidator<T> =>
  ((value: unknown, path: string) =>
    value === undefined || value === null || value === ""
      ? ok(undefined)
      : validator(value, path)) as OptionalValidator<T>;

type Shape = Record<string, Validator<unknown>>;

export type Infer<V> = V extends Validator<infer T> ? T : never;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalValidator<unknown> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

export type InferShape<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
};

/**
 * Validate a flat params object. Unknown keys are rejected so that typos
 * (e.g. `qty` instead of `quantity`) fail loudly.
 */
export const object =
  <S extends Shape>(shape: S): Validator<InferShape<S>> =>
  (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`${path} must be an object`);
    }
    const input = value as Record<string, unknown>;
    const errors: string[] = [];
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (!(key in shape)) errors.push(`${path}.${key} is not a known field`);
    }
    for (const [key, validator] of Object.entries(shape)) {
      const result = validator(input[key], `${path}.${key}`);
      if (result.ok) {
        if (result.value !== undefined) out[key] = result.value;
      } else {
        errors.push(...result.errors);
      }
    }
    return errors.length ? { ok: false, errors } : ok(out as InferShape<S>);
  };
