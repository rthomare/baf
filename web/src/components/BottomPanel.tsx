import { useState } from "react";
import { Overflow } from "./Overflow";
import { ActionTray } from "./ActionTray";

export function BottomPanel() {
  const [overflowOpen, setOverflowOpen] = useState(false);

  return (
    <div id="bottom-panel">
      <Overflow open={overflowOpen} onClose={() => setOverflowOpen(false)} />
      <ActionTray
        overflowOpen={overflowOpen}
        onToggleOverflow={() => setOverflowOpen((v) => !v)}
      />
    </div>
  );
}
