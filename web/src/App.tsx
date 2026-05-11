import { useEffect } from "react";
import { SessionProvider } from "./SessionContext";
import { useTransport } from "./useTransport";
import { useStreamRouter } from "./useStreamRouter";
import { useVisualViewport } from "./useVisualViewport";
import { useVoice } from "./useVoice";
import { BottomPanel } from "./components/BottomPanel";
import { StatusOverlay } from "./components/StatusOverlay";
import { RawTerminal } from "./components/RawTerminal";
import { ScrollBottomButton } from "./components/ScrollBottomButton";
import { BlockTranscript } from "./components/BlockTranscript";

function Shell() {
  const { status } = useTransport();

  useVisualViewport();
  useStreamRouter();
  useVoice();

  useEffect(() => {
    document.title = status === "open" ? "baf" : `baf (${status})`;
  }, [status]);

  return (
    <main id="app">
      <div id="view">
        <BlockTranscript />
        <RawTerminal />
        <ScrollBottomButton />
      </div>
      <BottomPanel />
      <StatusOverlay />
    </main>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
