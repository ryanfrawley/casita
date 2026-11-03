import type { ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: string;
  actions?: ReactNode;
  /** `page` fills a view; `inline` sits inside a card or table. */
  size?: "page" | "inline";
  className?: string;
}

/** What a view says when there's nothing in it yet, framed in the Casita arch. */
export function EmptyState({
  title,
  description,
  icon = "house",
  actions,
  size = "page",
  className,
}: EmptyStateProps) {
  const inline = size === "inline";
  const Title = inline ? "h3" : "h2";
  return (
    <div className={cx("ca-empty", `ca-empty-${inline ? "inline" : "page"}`, className)}>
      <div className="ca-empty-arch" aria-hidden>
        <Icon name={icon} size={inline ? 22 : 30} />
      </div>
      <Title className="ca-empty-title">{title}</Title>
      {description ? <p className="ca-empty-desc">{description}</p> : null}
      {actions ? <div className="ca-empty-actions">{actions}</div> : null}
    </div>
  );
}
