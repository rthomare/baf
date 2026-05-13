import { useCallback, useEffect } from "react";
import { SessionProvider } from "./SessionContext";
import { useTransport } from "./useTransport";
import { useStreamRouter } from "./useStreamRouter";
import { useVisualViewport } from "./useVisualViewport";
import { useVoice } from "./useVoice";
import { BottomPanel } from "./components/BottomPanel";
import { StatusOverlay } from "./components/StatusOverlay";
import { RawTerminal } from "./components/RawTerminal";
import { ScrollBottomButton } from "./components/ScrollBottomButton";

function Shell() {
  const { status } = useTransport();

  useVisualViewport();
  useStreamRouter();
  useVoice();

  const updateHeightCallback = useCallback(() => {
    const vv = window.visualViewport;
    // Subtract safe area if needed, though visualViewport usually accounts for the keyboard
    const viewHeight = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty(
      "--visible-height",
      `${viewHeight}px`,
    );
  }, []);

  const stopScrolling = useCallback(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    window.visualViewport?.addEventListener("resize", updateHeightCallback);
    window.visualViewport?.addEventListener("scroll", updateHeightCallback);
    window.onscroll = stopScrolling;
  }, [updateHeightCallback]);

  useEffect(() => {
    document.title = status === "open" ? "baf" : `baf (${status})`;
  }, [status]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "var(--visible-height, 100dvh)",
      }}
    >
      <div id="view" style={{ flex: 1, position: "relative" }}>
        <span
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <RawTerminal />
        </span>
        <ScrollBottomButton />
      </div>
      <span
        style={{
          flex: 0,
        }}
      >
        <BottomPanel />
      </span>
      <StatusOverlay />
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
