/** App entry point: mount the React root. */
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/fraunces/latin-700.css";
import "@fontsource/zcool-kuaile";
import App from "./App.js";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
