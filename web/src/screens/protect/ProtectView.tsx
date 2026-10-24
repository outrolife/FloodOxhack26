// Protect screen body (#121): headline, stats, hero map, controls, pin cards and
// the working. No Leaflet import here (the map comes in through `renderMap`), so
// it renders in node tests.
import type { ReactNode } from "react";
import type { Sandbags, SpreadManifest } from "../../contracts";
import { GradientLegend } from "../../components/spread/SpreadPanel";
import { SANDBAG_NOTE, SANDBAG_SOURCES, SCORE_LABEL } from "../../components/spread/SandbagList";
import { SPREAD_LIMITATIONS, frameUrl } from "../../components/spread/frames";
import { formatDateTime, formatShort } from "../../time";
import { Headline, Screen, StatTile } from "../../ui";
import {
  DEPLOY_HOURS,
  type OutlineFeature,
  TOP_N,
  firstDeadline,
  frameForHour,
  framesForIssue,
  headline,
  hourCaption,
  selectWithinBudget,
  timing,
  totalBags,
  validationSentence,
  wetByHour,
} from "./logic";
import { PinCard } from "./PinCard";
import type { Pin } from "./ProtectMap";
import "./protect.css";

export type Context = "e2014" | "live";

export const SCREENING_LABEL = "Screening, not instructions";
export const BUDGET_MAX = 1000;
const HOUR = 3_600_000;

export type MapProps = {
  manifest: SpreadManifest;
  frameUrl: string | null;
  pins: Pin[];
  selected: string | null;
  onSelect: (id: string) => void;
  outline: OutlineFeature | null;
};

export function ProtectView({
  context,
  onContext,
  manifest,
  sandbags,
  outline,
  budget,
  onBudget,
  tau: tauWanted,
  onTau,
  playing,
  onPlay,
  selected,
  onSelect,
  renderMap,
}: {
  context: Context;
  onContext: (c: Context) => void;
  manifest: SpreadManifest;
  sandbags: Sandbags;
  outline: OutlineFeature | null;
  budget: number;
  onBudget: (n: number) => void;
  /** Chosen lead, hours (the nearest frame is shown). */
  tau: number;
  onTau: (h: number) => void;
  playing: boolean;
  onPlay: (on: boolean) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  renderMap: (p: MapProps) => ReactNode;
}) {
  const issuedAt = sandbags.issuedAt;
  const frames = framesForIssue(manifest, issuedAt);
  const taus = frames.map((f) => f.tau);
  const frame = frameForHour(frames, tauWanted);
  const idx = frame ? frames.indexOf(frame) : 0;
  const tau = frame?.tau ?? 0;
  const sel = selectWithinBudget(sandbags.candidates, budget);
  const deadline = firstDeadline(sel.shown, issuedAt, taus);
  const sentence = headline({
    context,
    issuedAt,
    shown: sel.shown,
    budget,
    deadline: deadline ? formatDateTime(deadline) : null,
  });
  const quiet = context === "live" && !deadline;
  const pins: Pin[] = sel.shown.map((c, i) => ({
    c,
    n: i + 1,
    wet: wetByHour(c, issuedAt, tau),
    hours: timing(c, issuedAt, taus)?.firstWetH ?? null,
  }));
  const reached = pins.filter((p) => p.wet).length;
  const activeId = sel.shown.some((c) => c.id === selected) ? selected : (sel.shown[0]?.id ?? null);
  const iou = validationSentence(manifest.validation);
  const fileBags = totalBags(sandbags.candidates);
  const when = frame ? formatDateTime(Date.parse(issuedAt) + tau * HOUR) : null;

  const head = (
    <Headline
      sub={
        <>
          <span className="protect-badge">Experimental</span> <span className="protect-badge is-screen">{SCREENING_LABEL}</span>{" "}
          {context === "live" ? "Live forecast" : "January 2014 replay"}, made {formatDateTime(issuedAt)}.
        </>
      }
    >
      {sentence}
    </Headline>
  );

  const stats = (
    <>
      <StatTile
        value={sel.bagsShown}
        label={`bags for these ${sel.shown.length}`}
        sub={`of ${budget} in the budget`}
        title="Bags assume 10 per metre of exposed wall (an assumption, see the working)."
      />
      <StatTile
        value={deadline ? formatShort(deadline) : "None"}
        label="first bags in place by"
        sub={deadline ? `${DEPLOY_HOURS} h before the earliest water` : "nothing wet in half the runs"}
      />
      {manifest.validation && (
        <StatTile
          value={`${Math.round(manifest.validation.iou * 100)}%`}
          label="overlap with the real 2014 flood"
          sub="map vs recorded outline"
          title={iou ?? undefined}
        />
      )}
    </>
  );

  const hero = (
    <div className="protect-hero">
      {renderMap({ manifest, frameUrl: frame ? frameUrl(frame.png, context) : null, pins, selected: activeId, onSelect, outline })}
      <div className="protect-legend">
        <GradientLegend runs={manifest.runs} />
        {outline && (
          <div className="protect-outline-key">
            <span className="protect-dash" aria-hidden="true" /> Real recorded flood outline, winter 2013/14
          </div>
        )}
      </div>
    </div>
  );

  const aside = (
    <>
      <div className="protect-controls" role="group" aria-label="Protect controls">
        <div className="protect-seg" role="radiogroup" aria-label="Which forecast">
          {(["e2014", "live"] as const).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={context === c} onClick={() => onContext(c)}>
              {c === "e2014" ? "January 2014" : "Live now"}
            </button>
          ))}
        </div>

        <label className="protect-slider">
          <span>
            Hour: <strong>+{tau} h</strong>
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(frames.length - 1, 0)}
            step={1}
            value={idx}
            disabled={frames.length < 2}
            aria-valuetext={`${tau} hours ahead`}
            onChange={(e) => onTau(frames[Number(e.target.value)]?.tau ?? tauWanted)}
          />
        </label>
        <p className="protect-caption">
          {frame ? (
            <>
              {hourCaption(tau)} ({when}). {reached} of {pins.length} {pins.length === 1 ? "building is" : "buildings are"}{" "}
              reached by then.
            </>
          ) : (
            "No flood-spread frame for this forecast."
          )}
        </p>
        <button type="button" className="protect-play" onClick={() => onPlay(!playing)} disabled={frames.length < 2}>
          {playing ? "Pause" : "Play the hours"}
        </button>

        <label className="protect-slider">
          <span>
            Bag budget: <strong>{budget}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={BUDGET_MAX}
            step={10}
            value={budget}
            aria-valuetext={`${budget} sandbags`}
            onChange={(e) => onBudget(Number(e.target.value))}
          />
        </label>
        <p className="protect-caption">
          Picks the most score per bag first, until the budget runs out.
          {sandbags.candidates.length > 0 &&
            ` The screening lists ${sandbags.candidates.length} ${sandbags.candidates.length === 1 ? "building" : "buildings"} needing ${fileBags} bags in all, so any budget from ${fileBags} picks them all.`}
        </p>
      </div>

      {quiet && (
        <div className="protect-quiet">
          <strong>Nothing to protect right now.</strong> No building is wet in half the simulated runs in the next{" "}
          {taus.length ? Math.max(...taus) : 72} h.
          <button type="button" className="protect-play" onClick={() => onContext("e2014")}>
            See it for January 2014
          </button>
        </div>
      )}

      {sel.shown.length > 0 && (
        <ol className="protect-cards" aria-label={`Top ${TOP_N} buildings to check`}>
          {sel.shown.map((c, i) => (
            <PinCard
              key={c.id}
              c={c}
              n={i + 1}
              issuedAt={issuedAt}
              taus={taus}
              active={c.id === activeId}
              onSelect={onSelect}
            />
          ))}
        </ol>
      )}
      <p className="small muted">
        {SCREENING_LABEL}: a list for a person to check, never an instruction. {SCORE_LABEL} Not an official warning:{" "}
        <a href="https://www.gov.uk/check-flooding" target="_blank" rel="noreferrer">
          gov.uk/check-flooding
        </a>
        .
      </p>
    </>
  );

  const working = (
    <div className="protect-working">
      <h3>How the map is made (S3, experimental)</h3>
      <p>{SPREAD_LIMITATIONS}</p>
      <p>
        For each forecast lead ({taus.join(", ")} h), {manifest.runs} runs each draw a river level from the River
        Clock forecast, turn it into a water surface with the New Botley gauge datum, add LiDAR noise to the ground, and
        mark the cells below the water that connect to the river. The colour is the share of runs in which a square is
        wet.
      </p>
      {iou && <p>{iou}</p>}
      <ul>
        {manifest.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>

      <h3>How the list is made (S4, experimental)</h3>
      <p>{SANDBAG_NOTE}</p>
      <ol>
        <li>Candidates: buildings whose walls touch squares wet in at least 20% of runs by 48 h.</li>
        <li>
          Left out: water deeper than 0.5 m (sandbags only work to about 0.3 m), wet before bags could be in place (
          {DEPLOY_HOURS} h), or already on a recorded flood defence.
        </li>
        <li>Bags = exposed wall length × 10 per metre (an assumption).</li>
        <li>Score = chance wet by 48 h, halved if the water is deeper than 0.3 m. {SCORE_LABEL}</li>
        <li>
          The budget slider re-runs the pick in your browser: most score per bag first, skipping buildings that no
          longer fit, then the {TOP_N} highest scores are shown.
        </li>
      </ol>
      <p>
        <strong>Bags in place by:</strong> the map only has frames at fixed hours, so "first wet at +12 h" means the
        water could arrive any time after the frame before it (+6 h). We count from that earlier time and subtract{" "}
        {DEPLOY_HOURS} h to get the bags there.
      </p>
      <p>{SANDBAG_SOURCES}</p>

      {sandbags.excluded.length > 0 && (
        <details>
          <summary>
            {sandbags.excluded.length} {sandbags.excluded.length === 1 ? "building" : "buildings"} screened out, and why
          </summary>
          <ul className="protect-excluded">
            {sandbags.excluded.map((e) => (
              <li key={e.id}>
                {e.id}: {e.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  return <Screen headline={head} stats={stats} hero={hero} aside={aside} working={working} />;
}

/** Shown when the spread or screening file for a context is missing. */
export function ProtectMissing({ context, onContext }: { context: Context; onContext: (c: Context) => void }) {
  return (
    <Screen
      headline={<Headline sub={<span className="protect-badge">Experimental</span>}>No flood-spread run for this forecast yet.</Headline>}
      hero={
        <div className="ui-placeholder">
          {context === "live" ? (
            <button type="button" className="protect-play" onClick={() => onContext("e2014")}>
              See it for January 2014
            </button>
          ) : (
            "The January 2014 spread files are missing from this build."
          )}
        </div>
      }
    />
  );
}
