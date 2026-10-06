import { createRoot } from "react-dom/client";
import App, { ClerkInitializationError } from "./App";
import "./index.css";

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);

function isClerkInitializationFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return /Clerk|failed_to_load_clerk_js|dev_browser/i.test(message);
}

function renderClerkInitializationFailure() {
  root.render(<ClerkInitializationError />);
}

window.addEventListener("error", event => {
  if (isClerkInitializationFailure(event.error ?? event.message)) {
    renderClerkInitializationFailure();
  }
});
window.addEventListener("unhandledrejection", event => {
  if (isClerkInitializationFailure(event.reason)) {
    renderClerkInitializationFailure();
  }
});

root.render(<App />);
