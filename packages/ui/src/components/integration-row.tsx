import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { Badge, type BadgeProps } from "./badge.tsx";
import { Button } from "./button.tsx";

type Status = "running" | "starting" | "error" | "stopped";

export interface IntegrationRowProps {
  name: string;
  integrationId: string;
  status: Status;
  entities?: number;
  /** "since 9:02 am" */
  since?: string;
  /** Shown in place of the meta line while the status is `error`. */
  error?: string;
  onReload?: () => void;
  className?: string;
}

const STATUS: Record<Status, [tone: NonNullable<BadgeProps["tone"]>, word: string]> = {
  running: ["ok", "Running"],
  starting: ["pending", "Starting"],
  error: ["error", "Error"],
  stopped: ["neutral", "Stopped"],
};

export function IntegrationRow({
  name,
  integrationId,
  status,
  entities,
  since,
  error,
  onReload,
  className,
}: IntegrationRowProps) {
  const [tone, word] = STATUS[status] ?? STATUS.stopped;
  return (
    <div className={cx("ca-introw", className)}>
      <span className="ca-introw-icon">
        <Icon name="plug" size={20} />
      </span>
      <div className="ca-introw-main">
        <div className="ca-introw-name">
          {name} <code className="ca-mono">{integrationId}</code>
        </div>
        {status === "error" && error ? (
          <div className="ca-introw-error">{error}</div>
        ) : (
          <div className="ca-introw-meta">
            {[entities != null ? `${entities} entities` : null, since].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <Badge tone={tone} icon={status === "stopped" ? null : undefined}>
        {word}
      </Badge>
      {onReload ? (
        <Button variant="quiet" size="sm" onClick={onReload}>
          Reload
        </Button>
      ) : null}
    </div>
  );
}
