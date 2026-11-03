import type { ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface CodeLine {
  text: string;
  /** Replaces the line number. */
  gutter?: ReactNode;
  tone?: "error" | "info" | "muted";
  message?: string;
}
export interface CodeMark {
  line: number;
  tone: "error" | "info";
  message?: string;
}
export interface CodeViewProps {
  code?: string;
  lines?: (string | CodeLine)[];
  /** Flags lines by number. */
  marks?: CodeMark[];
  title?: string;
  actions?: ReactNode;
  maxHeight?: number | string;
  wrap?: boolean;
  /** Default true. */
  lineNumbers?: boolean;
  startLine?: number;
  label?: string;
  className?: string;
}

/** Monospace text with line numbers: an automation file, a config block, an integration's log. */
export function CodeView({
  code,
  lines: given = [],
  marks = [],
  title,
  actions,
  maxHeight,
  wrap,
  lineNumbers,
  startLine = 1,
  label,
  className,
}: CodeViewProps) {
  const lines = typeof code === "string" ? code.replace(/\n$/, "").split("\n") : given;
  const marked = new Map(marks.map((mark) => [mark.line, mark]));
  return (
    <figure className={cx("ca-code", wrap && "ca-code-wrap", className)}>
      {title || actions ? (
        <figcaption className="ca-code-head">
          <span className="ca-code-title">{title}</span>
          {actions ? <span className="ca-code-actions">{actions}</span> : null}
        </figcaption>
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: a section would add a landmark heading level this has none for */}
      <div
        className="ca-code-scroll"
        style={maxHeight ? { maxHeight } : undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to be scrolled by keyboard
        tabIndex={0}
        role="region"
        aria-label={title ?? label ?? "Code"}
      >
        <table className="ca-code-table">
          <tbody>
            {lines.map((entry, i) => {
              const line: CodeLine = typeof entry === "string" ? { text: entry } : entry;
              const number = startLine + i;
              const mark = marked.get(number) ?? (line.tone ? line : undefined);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity
                <tr key={i} className={cx("ca-code-line", mark && `ca-code-${mark.tone}`)}>
                  {lineNumbers === false ? null : (
                    <td className="ca-code-gutter">{line.gutter ?? number}</td>
                  )}
                  <td className="ca-code-text">
                    {/* An empty line still needs a character to keep its height. */}
                    {line.text || "​"}
                    {mark?.message ? (
                      <span className="ca-code-msg">
                        <Icon name={mark.tone === "error" ? "triangle-alert" : "info"} size={14} />
                        {mark.message}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
