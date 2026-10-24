/** Shown on every tab (SPEC §10.2, §15.7). */
export function Disclaimer() {
  return (
    <div className="disclaimer" role="note">
      <strong>Decision-support prototype, not an official warning.</strong>
      Check{" "}
      <a href="https://www.gov.uk/check-flooding" target="_blank" rel="noreferrer">
        gov.uk/check-flooding
      </a>
      .
    </div>
  );
}
