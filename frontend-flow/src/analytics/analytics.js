import posthog from "posthog-js";

const SENSITIVE_KEY_RE = /password|token|secret|passkey|consumer|credential|authorization|api[_-]?key|pin/i;
const DEFAULT_HOST = "https://app.posthog.com";

let initialized = false;
let globalErrorListenersAttached = false;

function hasWindow() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function cleanProperties(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(item => cleanProperties(item, depth + 1));
  if (typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY_RE.test(key))
      .map(([key, val]) => [key, cleanProperties(val, depth + 1)])
      .filter(([, val]) => val !== undefined)
  );
}

function userId(user) {
  return user?.id || user?.userId || user?.ownerUserId || user?._id || null;
}

function userProperties(user) {
  return cleanProperties({
    email: user?.email || null,
    schoolName: user?.schoolName || user?.school || null,
    role: user?.userType || user?.role || "owner",
    plan: user?.plan || user?.subscription || "free",
  });
}

function eventWithCleanProperties(event) {
  if (!event?.properties) return event;
  return {
    ...event,
    properties: cleanProperties(event.properties),
  };
}

function attachGlobalErrorListeners() {
  if (globalErrorListenersAttached || !hasWindow()) return;
  globalErrorListenersAttached = true;

  window.addEventListener("error", event => {
    analytics.error(event.error || event.message, {
      source: "window_error",
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null,
    });
  });

  window.addEventListener("unhandledrejection", event => {
    analytics.error(event.reason, {
      source: "unhandled_rejection",
    });
  });
}

export const analytics = {
  init() {
    if (initialized || !hasWindow()) return;
    const key = import.meta.env.VITE_POSTHOG_KEY;
    if (!key) return;

    posthog.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST || DEFAULT_HOST,
      capture_pageview: false,
      autocapture: true,
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "[data-ph-mask]",
        blockSelector: "[data-ph-block]",
      },
      before_send: event => eventWithCleanProperties(event),
      loaded: () => {
        initialized = true;
      },
    });
    initialized = true;
    attachGlobalErrorListeners();
  },

  track(eventName, properties = {}) {
    if (!initialized || !eventName) return;
    posthog.capture(eventName, cleanProperties(properties));
  },

  identify(user) {
    if (!initialized) return;
    const id = userId(user);
    if (!id) return;
    posthog.identify(String(id), userProperties(user));
  },

  reset() {
    if (!initialized) return;
    posthog.reset();
  },

  page(path, title) {
    if (!initialized || !hasWindow()) return;
    posthog.capture("$pageview", {
      $current_url: window.location.href,
      path,
      title: title || document.title,
    });
  },

  error(error, properties = {}) {
    const message = error?.message || String(error || "Unknown error");
    this.track("frontend_error", {
      message,
      name: error?.name || null,
      stack: error?.stack || null,
      ...properties,
    });
  },
};

export default analytics;
