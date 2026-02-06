import React from "react";
import ReactDOM from "react-dom/client";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import App from "./App";
import "./index.css";
import { useSystemTheme } from "./hooks/useSystemTheme";

function Root() {
  const theme = useSystemTheme();

  return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme}>
      <App />
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
