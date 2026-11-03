import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface CopyChipProps {
  /** What is copied, and what is shown unless `children` says otherwise. */
  value: string;
  children?: ReactNode;
  /** Default true. */
  mono?: boolean;
  label?: string;
  onCopy?: (value: string) => void;
  className?: string;
}

/** Copies through a hidden textarea, for pages the Clipboard API refuses (plain http on the LAN). */
function copyByHand(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // no clipboard at all
  }
  area.remove();
  return copied;
}

/** Text with a copy button: an entity id, a topic, a token. */
export function CopyChip({ value, children, mono, label, onCopy, className }: CopyChipProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const done = () => {
    setCopied(true);
    onCopy?.(value);
  };
  const copy = () => {
    const fallback = () => {
      if (copyByHand(value)) done();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(done, fallback);
    else fallback();
  };
  return (
    <span className={cx("ca-copy", mono !== false && "ca-mono", className)}>
      <span className="ca-copy-text" title={value}>
        {children ?? value}
      </span>
      <button
        type="button"
        className="ca-copy-btn"
        onClick={copy}
        aria-label={label ?? `Copy ${value}`}
        title={copied ? "Copied" : "Copy"}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
      <span className="ca-copy-done" role="status">
        {copied ? "Copied" : null}
      </span>
    </span>
  );
}
