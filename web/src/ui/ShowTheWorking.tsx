// "Show the working" (#118): expert detail, collapsed by default.
import type { ReactNode } from "react";

export function ShowTheWorking({
  title = "Show the working",
  children,
  open = false,
}: {
  title?: ReactNode;
  children: ReactNode;
  /** Start expanded (default collapsed). */
  open?: boolean;
}) {
  return (
    <details className="ui-working" open={open || undefined}>
      <summary>{title}</summary>
      <div className="ui-working-body">{children}</div>
    </details>
  );
}
