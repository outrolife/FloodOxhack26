// The one sentence a screen answers (#118). Big, plain, first on screen.
import type { ReactNode } from "react";

export function Headline({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="ui-headline">
      <h1 className="ui-headline-main" aria-live="polite">{children}</h1>
      {sub && <p className="ui-headline-sub">{sub}</p>}
    </div>
  );
}
