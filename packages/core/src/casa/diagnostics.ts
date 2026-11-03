// casa/diagnostics.ts
// What the compiler says about a page: a stable code, a span, and one sentence naming the
// thing and the fix. Warnings never block a save; errors always do.

export interface Span {
  /** Character offsets into the source, `end` exclusive. */
  start: number;
  end: number;
  /** 1-based position of `start`. */
  line: number;
  col: number;
}

export type Level = "error" | "warning";

export interface Diagnostic {
  code: string;
  level: Level;
  message: string;
  span: Span;
}

export const NOWHERE: Span = { start: 0, end: 0, line: 1, col: 1 };

export const at = (span: Span) => `${span.line}:${span.col}`;

/** Collects diagnostics as a pass runs; `failed` says whether any was an error. */
export class Diagnostics {
  readonly list: Diagnostic[] = [];

  error(code: string, span: Span, message: string): void {
    this.list.push({ code, level: "error", message, span });
  }

  warn(code: string, span: Span, message: string): void {
    this.list.push({ code, level: "warning", message, span });
  }

  get failed(): boolean {
    return this.list.some((d) => d.level === "error");
  }
}

/** Edit distance with transpositions, for "did you mean". */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    (rows[i] as number[])[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      (rows[i] as number[])[j] = Math.min(
        ((rows[i - 1] as number[])[j] as number) + 1,
        ((rows[i] as number[])[j - 1] as number) + 1,
        ((rows[i - 1] as number[])[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        (rows[i] as number[])[j] = Math.min(
          (rows[i] as number[])[j] as number,
          ((rows[i - 2] as number[])[j - 2] as number) + 1,
        );
      }
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/** The closest of `candidates` to `name`, when it is close enough to be a slip of the hand. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const allowed = Math.max(1, Math.floor(name.length / 3));
  const lower = name.toLowerCase();
  const related =
    best !== undefined &&
    (lower.startsWith(best.toLowerCase()) || best.toLowerCase().startsWith(lower));
  return bestDistance <= allowed || (related && bestDistance <= name.length / 2) ? best : undefined;
}

export const didYouMean = (name: string, candidates: Iterable<string>): string => {
  const guess = suggest(name, candidates);
  return guess ? `; did you mean \`${guess}\`` : "";
};
