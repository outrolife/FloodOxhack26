// The one-line keyboard hint under a screen's controls (#118), so every screen
// says what Space and the arrows do there in the same words and style.
// Hidden in presenter mode (ui.css), where the presenter already knows.
export function KeyHint({ keys }: { keys: [key: string, what: string][] }) {
  return (
    <p className="ui-keyhint">
      {keys.map(([k, what], i) => (
        <span key={k}>
          {i > 0 && " · "}
          <kbd className="ui-key">{k}</kbd> {what}
        </span>
      ))}
    </p>
  );
}
