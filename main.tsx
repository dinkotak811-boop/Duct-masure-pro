import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Remove splash screen after React mounts
const hideSplash = () => {
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("hide");
    setTimeout(() => splash.remove(), 500);
  }
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Hide splash after a short delay to ensure first paint
requestAnimationFrame(() => {
  requestAnimationFrame(hideSplash);
});
