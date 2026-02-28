import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/i18n";
import { FluentProvider, tokens, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import App from "./App";
import "./index.css";
import { useSystemTheme } from "./hooks/useSystemTheme";

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
