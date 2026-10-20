import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import RuleWindow from "./RuleWindow";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.hash === "#rule-editor" ? <RuleWindow /> : <App />}
  </React.StrictMode>,
);
