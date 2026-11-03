import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="g-section">
      <h2 className="ca-text-title">{title}</h2>
      {children}
    </section>
  );
}

/** One component's demos on a raised card, with a line saying what to look for. */
export function Demo({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="g-section">
      <h2 className="ca-text-heading">{title}</h2>
      {note ? <p className="ca-text-caption g-note g-demo-note">{note}</p> : null}
      <div className="g-card g-demo">{children}</div>
    </section>
  );
}
