import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// API key bootstrap: read from localStorage or prompt once, then auto-inject
// into every fetch/EventSource/WebSocket so the dashboard stays usable now that
// the backend requires auth on /api/* and /ws/*.
const API_KEY_STORAGE = "kvmhub.apiKey";
let apiKey = localStorage.getItem(API_KEY_STORAGE) || "";

// Allow setting via URL hash: #apikey=... — convenient for first-load setup
const hashMatch = window.location.hash.match(/[#&]apikey=([^&]+)/);
if (hashMatch) {
  apiKey = decodeURIComponent(hashMatch[1]);
  localStorage.setItem(API_KEY_STORAGE, apiKey);
  // Strip apikey from the URL so it isn't visible in browser history
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

if (!apiKey) {
  const prompted = window.prompt(
    "KVM Hub API key required. Paste the value from .api_key in your KVM Hub directory:",
  );
  if (prompted) {
    apiKey = prompted.trim();
    localStorage.setItem(API_KEY_STORAGE, apiKey);
  }
}

// Patch global fetch to inject the Bearer token on every request
const originalFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (apiKey && !headers.has("Authorization") && !headers.has("x-api-key")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return originalFetch(input, { ...init, headers });
};

// Patch EventSource and WebSocket to append ?api_key=… (browsers can't set
// custom headers on these, so the backend middleware accepts a query param)
const appendKey = (url: string | URL): string => {
  const u = typeof url === "string" ? new URL(url, window.location.origin) : new URL(url.toString());
  if (apiKey && !u.searchParams.has("api_key")) {
    u.searchParams.set("api_key", apiKey);
  }
  return u.toString();
};

const OriginalEventSource = window.EventSource;
window.EventSource = class PatchedEventSource extends OriginalEventSource {
  constructor(url: string | URL, init?: EventSourceInit) {
    super(appendKey(url), init);
  }
} as typeof EventSource;

const OriginalWebSocket = window.WebSocket;
window.WebSocket = class PatchedWebSocket extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(appendKey(url), protocols);
  }
} as typeof WebSocket;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
