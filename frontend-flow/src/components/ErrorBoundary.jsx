import { Component } from "react";

/**
 * ErrorBoundary — catches uncaught React render errors and shows a
 * friendly recovery screen instead of a blank black page.
 *
 * Usage — wrap your routes in App.jsx:
 *   import ErrorBoundary from "./components/ErrorBoundary";
 *   <ErrorBoundary>
 *     <RouterProvider ... />
 *   </ErrorBoundary>
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("[ErrorBoundary] Uncaught error:", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg, #0b1220)", padding: 24, fontFamily: "system-ui, sans-serif",
      }}>
        <div style={{
          maxWidth: 480, width: "100%", background: "var(--surface, #111827)",
          border: "1px solid var(--border, #1e2d47)", borderRadius: 16,
          padding: 32, textAlign: "center",
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text, #e8edf5)", marginBottom: 8 }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 13.5, color: "var(--text3, #4a5f80)", marginBottom: 24, lineHeight: 1.6 }}>
            An unexpected error occurred. Your data is safe — this is a display issue only.
            Refreshing the page usually fixes it.
          </div>

          {this.state.error?.message && (
            <div style={{
              background: "var(--red-bg, rgba(239,68,68,0.08))",
              border: "1px solid var(--red-border, rgba(239,68,68,0.2))",
              borderRadius: 9, padding: "10px 14px", marginBottom: 20,
              fontSize: 12, color: "var(--red, #ef4444)", fontFamily: "monospace",
              textAlign: "left", wordBreak: "break-word",
            }}>
              {this.state.error.message}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "10px 22px", borderRadius: 9, fontSize: 13.5, fontWeight: 600,
                background: "var(--accent, #22d3a4)", border: "none", color: "#0b1a14",
                cursor: "pointer", fontFamily: "inherit",
              }}>
              Refresh page
            </button>
            <button
              onClick={() => { this.setState({ hasError: false, error: null, info: null }); }}
              style={{
                padding: "10px 22px", borderRadius: 9, fontSize: 13.5, fontWeight: 600,
                background: "transparent", border: "1px solid var(--border, #1e2d47)",
                color: "var(--text2, #8a9dbf)", cursor: "pointer", fontFamily: "inherit",
              }}>
              Try again
            </button>
          </div>

          <div style={{ marginTop: 24, fontSize: 11.5, color: "var(--text3, #4a5f80)" }}>
            If this keeps happening, contact{" "}
            <a href="mailto:yahiawarsame@gmail.com" style={{ color: "var(--accent, #22d3a4)" }}>
              FeeFlow support
            </a>
          </div>
        </div>
      </div>
    );
  }
}