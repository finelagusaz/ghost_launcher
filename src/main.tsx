import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/i18n";
import { FluentProvider, tokens, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import App from "./App";
import "./index.css";
import { useSystemTheme } from "./hooks/useSystemTheme";
import { warmUpSettingsStore } from "./lib/settingsStore";

// LazyStore の初期化を React レンダリング前にキックオフする
warmUpSettingsStore();

// localStorage に残った旧 fingerprint キーの掃除（v0.x → v1.0 移行）
if (!localStorage.getItem("__migrated_fp_v1")) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith("fingerprint_")) localStorage.removeItem(key);
  }
  localStorage.setItem("__migrated_fp_v1", "1");
}

function Root() {
  const theme = useSystemTheme();

  return (
    <FluentProvider
      theme={theme === "dark" ? webDarkTheme : webLightTheme}
      style={{ backgroundColor: tokens.colorNeutralBackground3, minHeight: "100vh" }}
    >
      <App />
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
