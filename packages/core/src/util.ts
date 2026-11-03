export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Lowercase `[a-z0-9_]` slug; never empty. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "unnamed";
}

/** `base`, or the first of `base_2`, `base_3`, … that is not taken. */
export function uniqueSlug(base: string, taken: (candidate: string) => boolean): string {
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}_${n}`;
  return id;
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
