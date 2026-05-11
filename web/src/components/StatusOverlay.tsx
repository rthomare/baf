import { useTransport } from "../useTransport";

// "Disconnected" overlay. Shown whenever the WS is not open. The hint
// text adapts to whether the user pressed leave or the link dropped on
// its own.
export function StatusOverlay() {
  const { status, userInitiated, rejoin } = useTransport();
  const hidden = status === "open" || status === "connecting";

  const hint = userInitiated
    ? "The baf session is still running on your computer. Tap to come back."
    : "The connection dropped. Tap to retry.";

  return (
    <div id="status-overlay" hidden={hidden} role="dialog" aria-modal="true">
      <div className="status-card">
        <div id="status-title">Disconnected</div>
        <div id="status-hint">{hint}</div>
        <button id="reconnect" type="button" onClick={rejoin}>
          Reconnect
        </button>
      </div>
    </div>
  );
}
