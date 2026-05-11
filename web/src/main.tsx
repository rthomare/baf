import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/dm-mono/400.css";
import { App } from "./App";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
