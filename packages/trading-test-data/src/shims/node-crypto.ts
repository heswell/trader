/**
 * Browser replacement for the `node:crypto` import in
 * @heswell/hft-limit-order-book (it only uses randomUUID, as a default order
 * id). Bundlers alias `node:crypto` to this file, see docs/ui-guide.md.
 */
export const randomUUID = (): string => globalThis.crypto.randomUUID();

export default { randomUUID };
