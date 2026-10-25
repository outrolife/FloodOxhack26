// Address search (#118 Explore): an accessible combobox for UK postcodes and
// addresses. Typing waits 300 ms before asking the geocoder, and every new
// request aborts the one before, so a slow answer can never overwrite a newer
// one. Arrow keys move through the suggestions, Enter picks, Esc closes (and a
// second Esc clears). A failed lookup shows a friendly line, never a crash.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MIN_QUERY, geocoder as defaultGeocoder } from "./logic";
import { GeocodeError, type Geocoder, type Place } from "./types";

export const DEBOUNCE_MS = 300;
/** The geocoder answers [] below this, so don't ask. */
export const MIN_CHARS = MIN_QUERY;

export const NOT_FOUND_TEXT = "We couldn't find that address. Try a postcode like OX2 0HA.";
export const OFFLINE_TEXT = "You seem to be offline, so we can't look up addresses right now.";

type Status = "idle" | "loading" | "ready" | "error";

/** The friendly words for a failed lookup, and whether a retry could help. */
export function lookupFailure(e: unknown): { text: string; retry: boolean } {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (e instanceof GeocodeError) {
    if (e.reason === "not_found") return { text: e.message || NOT_FOUND_TEXT, retry: false };
    if (e.reason === "offline") return { text: OFFLINE_TEXT, retry: true };
    if (e.reason === "rate_limited") return { text: "Too many lookups at once. Wait a moment and try again.", retry: true };
    return { text: e.message || "The address service didn't answer.", retry: true };
  }
  return { text: offline ? OFFLINE_TEXT : "The address service didn't answer.", retry: true };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

const KIND_WORD: Record<Place["kind"], string> = { postcode: "Postcode", address: "Address", place: "Place", point: "Point" };

export function SearchBox({
  onPick,
  geocoder = defaultGeocoder,
  placeholder = "Search a postcode or address",
}: {
  onPick: (place: Place) => void;
  geocoder?: Geocoder;
  placeholder?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Place[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [failure, setFailure] = useState<{ text: string; retry: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The label of the place just picked: shown in the box, not looked up again.
  const picked = useRef<string | null>(null);

  // Debounced, abortable lookup: each keystroke cancels the timer and the request before it.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS || q === picked.current) {
      setItems([]);
      setStatus("idle");
      setFailure(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setStatus("loading");
      geocoder.suggest(q, ctrl.signal).then(
        (found) => {
          if (ctrl.signal.aborted) return;
          setItems(found);
          setActive(found.length ? 0 : -1);
          if (found.length) {
            setStatus("ready");
            setFailure(null);
          } else {
            setStatus("error");
            setFailure({ text: NOT_FOUND_TEXT, retry: false });
          }
        },
        (e: unknown) => {
          if (ctrl.signal.aborted || isAbort(e)) return;
          setItems([]);
          setActive(-1);
          setStatus("error");
          setFailure(lookupFailure(e));
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, geocoder, attempt]);

  const pick = (p: Place) => {
    picked.current = p.label.trim();
    setQuery(p.label);
    setOpen(false);
    setItems([]);
    setStatus("idle");
    onPick(p);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (items.length) setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (items.length) setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      if (open && items.length) {
        e.preventDefault();
        pick(items[Math.max(active, 0)]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open) setOpen(false);
      else setQuery("");
    }
  };

  const showList = open && query.trim().length >= MIN_CHARS && status !== "idle";
  const activeId = showList && status === "ready" && active >= 0 ? `${id}-opt-${active}` : undefined;

  return (
    <div className="fc-x-search" role="search">
      <div className={`fc-x-search-field${status === "loading" ? " is-loading" : ""}`}>
        <svg className="fc-x-search-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="fc-x-search-input"
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          role="combobox"
          aria-label="Search a UK postcode or address"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeId}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {status === "loading" && <span className="fc-x-spinner" aria-hidden="true" />}
        {query && (
          <button
            type="button"
            className="fc-x-search-clear"
            aria-label="Clear search"
            // Keep focus in the input (no blur, so the list doesn't flicker).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>

      <ul id={listId} role="listbox" aria-label="Suggestions" className={`fc-x-search-list${showList ? " is-open" : ""}`} hidden={!showList}>
        {status === "loading" &&
          items.length === 0 &&
          [0, 1, 2].map((i) => (
            <li key={`sk${i}`} className="fc-x-search-skel" aria-hidden="true">
              <span className="fc-x-skel" style={{ width: `${70 - i * 12}%` }} />
            </li>
          ))}
        {(status === "ready" || (status === "loading" && items.length > 0)) &&
          items.map((p, i) => (
            <li
              key={`${p.label}|${p.lat}|${p.lon}`}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className="fc-x-search-opt"
              // mousedown, not click: it fires before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="fc-x-search-opt-main">{p.label}</span>
              <span className="fc-x-search-opt-kind">{KIND_WORD[p.kind]}</span>
            </li>
          ))}
      </ul>
      {showList && status === "error" && failure && (
        <div className="fc-x-search-msg" role="status">
          <span>{failure.text}</span>
          {failure.retry && (
            <button type="button" className="fc-x-btn-link" onMouseDown={(e) => e.preventDefault()} onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      <span className="fc-x-sr" aria-live="polite">
        {status === "ready" && open ? `${items.length} suggestion${items.length === 1 ? "" : "s"}` : ""}
      </span>
    </div>
  );
}
