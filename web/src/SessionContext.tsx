import { createContext, useContext, type ReactNode } from "react";
import { useSession, type SessionActions, type SessionState } from "./session";

interface Ctx {
  state: SessionState;
  actions: SessionActions;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const value = useSession();
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSessionState(): SessionState {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error("useSessionState outside SessionProvider");
  return ctx.state;
}

export function useSessionActions(): SessionActions {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error("useSessionActions outside SessionProvider");
  return ctx.actions;
}
