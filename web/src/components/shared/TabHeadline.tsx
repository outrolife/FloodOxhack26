// The one-sentence takeaway at the top of a tab (#103). Text comes from
// lib/headlines.ts, generated from the data on screen.
import type { ReactNode } from "react";
import type { Headline } from "../../lib/headlines";

export function TabHeadline({ h, children }: { h: Headline | null; children?: ReactNode }) {
  if (!h) return null;
  return (
    <section className="tab-headline" aria-live="polite">
      <p className="tab-headline-main">{h.headline}</p>
      {h.detail && <p className="tab-headline-detail">{h.detail}</p>}
      {children}
    </section>
  );
}
