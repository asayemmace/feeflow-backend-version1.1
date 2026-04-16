import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

// ─── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) => (typeof n === "number" ? `KES ${n.toLocaleString()}` : n || "KES 0");

function weeksBetween(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.max(1, Math.round(ms / (7 * 24 * 60 * 60 * 1000)));
}
function currentWeek(start) {
  const ms = Date.now() - new Date(start);
  return Math.max(1, Math.ceil(ms / (7 * 24 * 60 * 60 * 1000)));
}
function pct(a, b) { return b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0; }

// ─── New Term Modal ────────────────────────────────────────────────────────────
function NewTermModal({ onClose, onCreated, existingTerm }) {
  const { token } = useAuth();
  const [form, setForm] = useState({
    name: "",
    startDate: "",
    endDate: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.startDate || !form.endDate) {
      setError("All fields are required.");
      return;
    }
    if (new Date(form.endDate) <= new Date(form.startDate)) {
      setError("End date must be after start date.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await axios.post(
        `${API}/api/terms`,
        { name: form.name.trim(), startDate: form.startDate, endDate: form.endDate },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      onCreated(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to create term.");
    } finally {
      setSaving(false);
    }
  };

  const inp = {
    width: "100%", padding: "9px 12px",
    background: "#212f48", border: "1px solid #1e2d47",
    borderRadius: 8, color: "#e8edf5", fontSize: 13.5,
    fontFamily: "'DM Sans', sans-serif", outline: "none",
  };
  const lbl = {
    fontSize: 11.5, fontWeight: 600, color: "#8a9dbf",
    textTransform: "uppercase", letterSpacing: 0.8,
    marginBottom: 6, display: "block",
  };

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 40,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)",
      }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", zIndex: 50,
        transform: "translate(-50%,-50%)",
        width: "100%", maxWidth: 480,
        background: "#111827", border: "1px solid #1e2d47",
        borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid #1e2d47",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>
              {existingTerm ? "Start new term" : "Create your first term"}
            </div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>
              {existingTerm
                ? `This will close "${existingTerm.name}" and archive its data`
                : "Set up your first academic term to start tracking"}
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 7,
            background: "transparent", border: "1px solid #1e2d47",
            color: "#8a9dbf", cursor: "pointer", fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>×</button>
        </div>

        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {existingTerm && (
            <div style={{
              background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)",
              borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#f59e0b",
            }}>
              ⚠ Closing <strong>{existingTerm.name}</strong> will lock its records. All data is saved and downloadable from Past Terms.
            </div>
          )}

          <div>
            <label style={lbl}>Term name</label>
            <input style={inp} placeholder="e.g. Term 2 — 2025" value={form.name} onChange={set("name")} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Start date</label>
              <input type="date" style={inp} value={form.startDate} onChange={set("startDate")} />
            </div>
            <div>
              <label style={lbl}>End date</label>
              <input type="date" style={inp} value={form.endDate} onChange={set("endDate")} />
            </div>
          </div>

          {error && (
            <div style={{
              fontSize: 12, color: "#f87171",
              background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
              borderRadius: 8, padding: "10px 12px",
            }}>✕ {error}</div>
          )}
        </div>

        <div style={{
          padding: "14px 24px", borderTop: "1px solid #1e2d47",
          display: "flex", justifyContent: "flex-end", gap: 10,
        }}>
          <button onClick={onClose} style={{
            padding: "8px 16px", borderRadius: 8, fontSize: 13,
            background: "transparent", border: "1px solid #1e2d47",
            color: "#8a9dbf", cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
          }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{
            padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: saving ? "#212f48" : "#22d3a4",
            border: "none", color: saving ? "#4a5f80" : "#0b1a14",
            cursor: saving ? "not-allowed" : "pointer",
            fontFamily: "'DM Sans',sans-serif",
          }}>{saving ? "Creating…" : existingTerm ? "Close & start new term" : "Create term"}</button>
        </div>
      </div>
      <style>{`input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5)}`}</style>
    </>
  );
}

// ─── Past Terms Panel ──────────────────────────────────────────────────────────
function PastTermsPanel({ terms, onClose }) {
  const { token } = useAuth();
  const [downloading, setDownloading] = useState(null);

  const download = async (term, format) => {
    setDownloading(`${term.id}-${format}`);
    try {
      const res = await axios.get(`${API}/api/terms/${term.id}/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "blob",
      });
      const ext = format === "excel" ? "xlsx" : "pdf";
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${term.name.replace(/\s+/g, "_")}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed. Please try again.");
    } finally {
      setDownloading(null);
    }
  };

  const closed = terms.filter((t) => t.status === "closed");

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 40,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)",
      }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", zIndex: 50,
        transform: "translate(-50%,-50%)",
        width: "100%", maxWidth: 560,
        background: "#111827", border: "1px solid #1e2d47",
        borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        maxHeight: "80vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "20px 24px 16px", borderBottom: "1px solid #1e2d47",
          display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>Past Terms</div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>Download archived term data as PDF or Excel</div>
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 7,
            background: "transparent", border: "1px solid #1e2d47",
            color: "#8a9dbf", cursor: "pointer", fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>×</button>
        </div>

        <div style={{ overflowY: "auto", padding: "16px 24px", flex: 1 }}>
          {closed.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#4a5f80", fontSize: 13 }}>
              No closed terms yet. Past terms will appear here once a new term is started.
            </div>
          ) : closed.map((term) => (
            <div key={term.id} style={{
              background: "#1a2236", border: "1px solid #1e2d47",
              borderRadius: 12, padding: "16px", marginBottom: 12,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#e8edf5" }}>{term.name}</div>
                  <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>
                    {new Date(term.startDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}
                    {" → "}
                    {new Date(term.endDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}
                  </div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
                  background: "rgba(74,95,128,0.15)", color: "#4a5f80",
                  border: "1px solid #1e2d47", textTransform: "uppercase", letterSpacing: 0.8,
                }}>Closed</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => download(term, "excel")}
                  disabled={!!downloading}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12.5, fontWeight: 500,
                    background: downloading === `${term.id}-excel` ? "#212f48" : "rgba(59,130,246,0.1)",
                    border: "1px solid rgba(59,130,246,0.2)", color: "#3b82f6",
                    cursor: downloading ? "not-allowed" : "pointer",
                    fontFamily: "'DM Sans',sans-serif",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}
                >
                  <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/>
                  </svg>
                  {downloading === `${term.id}-excel` ? "Downloading…" : "Excel (.xlsx)"}
                </button>
                <button
                  onClick={() => download(term, "pdf")}
                  disabled={!!downloading}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12.5, fontWeight: 500,
                    background: downloading === `${term.id}-pdf` ? "#212f48" : "rgba(245,158,11,0.08)",
                    border: "1px solid rgba(245,158,11,0.15)", color: "#f59e0b",
                    cursor: downloading ? "not-allowed" : "pointer",
                    fontFamily: "'DM Sans',sans-serif",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}
                >
                  <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/>
                  </svg>
                  {downloading === `${term.id}-pdf` ? "Downloading…" : "PDF Report"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Empty / No-term state ─────────────────────────────────────────────────────
function EmptyState({ onStartTerm }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      minHeight: "70vh", textAlign: "center", padding: "0 24px",
    }}>
      {/* Illustration */}
      <div style={{
        width: 80, height: 80, borderRadius: 20,
        background: "linear-gradient(135deg,rgba(34,211,164,0.12),rgba(59,130,246,0.12))",
        border: "1px solid rgba(34,211,164,0.15)",
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 24,
      }}>
        <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="var(--accent,#22d3a4)" strokeWidth="1.4">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
        </svg>
      </div>

      <h2 style={{
        fontFamily: "'DM Serif Display',serif",
        fontSize: 28, fontWeight: 400, color: "#e8edf5",
        letterSpacing: -0.5, margin: "0 0 10px",
      }}>Ready to start tracking?</h2>
      <p style={{ color: "#8a9dbf", fontSize: 14, maxWidth: 380, lineHeight: 1.7, margin: "0 0 32px" }}>
        Create your first academic term to begin tracking fees, students, and payments.
        All data is organised by term so you always know where things stand.
      </p>

      <button
        onClick={onStartTerm}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "12px 28px", borderRadius: 10, fontSize: 14, fontWeight: 600,
          background: "#22d3a4", border: "none", color: "#0b1a14",
          cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
          boxShadow: "0 0 0 0 rgba(34,211,164,0.4)",
          animation: "pulseBtn 2.5s infinite",
        }}
      >
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        Start a new term
      </button>

      <div style={{ marginTop: 48, display: "flex", gap: 32, flexWrap: "wrap", justifyContent: "center" }}>
        {[
          { icon: "📊", label: "Track fee balances" },
          { icon: "💳", label: "Record M-Pesa payments" },
          { icon: "📄", label: "Auto-generate invoices" },
          { icon: "🔔", label: "Send payment reminders" },
        ].map((f) => (
          <div key={f.label} style={{ display: "flex", alignItems: "center", gap: 8, color: "#4a5f80", fontSize: 13 }}>
            <span>{f.icon}</span> {f.label}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes pulseBtn {
          0%,100%{box-shadow:0 0 0 0 rgba(34,211,164,0.4)}
          50%{box-shadow:0 0 0 10px rgba(34,211,164,0)}
        }
      `}</style>
    </div>
  );
}

// ─── Main Dashboard ────────────────────────────────────────────────────────────
const Dashboard = () => {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [activeTerm, setActiveTerm]       = useState(null);   // null = no term yet
  const [allTerms, setAllTerms]           = useState([]);
  const [stats, setStats]                 = useState(null);
  const [recentPayments, setRecentPayments] = useState([]);
  const [topUnpaid, setTopUnpaid]         = useState([]);
  const [loading, setLoading]             = useState(true);
  const [showNewTerm, setShowNewTerm]     = useState(false);
  const [showPastTerms, setShowPastTerms] = useState(false);

  // Load terms on mount
  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get(`${API}/api/terms`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setAllTerms(res.data);
        const active = res.data.find((t) => t.status === "active");
        setActiveTerm(active || null);

        if (active) {
          const [statsRes, paymentsRes, unpaidRes] = await Promise.all([
            axios.get(`${API}/api/stats?termId=${active.id}`, { headers: { Authorization: `Bearer ${token}` } }),
            axios.get(`${API}/api/payments/recent?termId=${active.id}`, { headers: { Authorization: `Bearer ${token}` } }),
            axios.get(`${API}/api/students/unpaid`, { headers: { Authorization: `Bearer ${token}` } }),
          ]);
          setStats(statsRes.data);
          setRecentPayments(paymentsRes.data);
          setTopUnpaid(unpaidRes.data);
        }
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  const handleTermCreated = (term) => {
    setAllTerms((prev) => [...prev.map((t) => ({ ...t, status: "closed" })), term]);
    setActiveTerm(term);
    setStats(null);
    setRecentPayments([]);
    setTopUnpaid([]);
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ color: "#4a5f80", fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  // ── No term yet ──────────────────────────────────────────────────────────────
  if (!activeTerm) {
    return (
      <div className="content">
        <div className="topbar">
          <div>
            <div className="topbar-title">Dashboard</div>
            <div className="topbar-sub">No active term</div>
          </div>
          {allTerms.some((t) => t.status === "closed") && (
            <button className="btn btn-outline" onClick={() => setShowPastTerms(true)}>
              Past Terms
            </button>
          )}
        </div>
        <EmptyState onStartTerm={() => setShowNewTerm(true)} />
        {showNewTerm && (
          <NewTermModal onClose={() => setShowNewTerm(false)} onCreated={handleTermCreated} existingTerm={null} />
        )}
        {showPastTerms && (
          <PastTermsPanel terms={allTerms} onClose={() => setShowPastTerms(false)} />
        )}
      </div>
    );
  }

  // ── Active term ──────────────────────────────────────────────────────────────
  const totalWeeks = weeksBetween(activeTerm.startDate, activeTerm.endDate);
  const curWeek    = currentWeek(activeTerm.startDate);
  const termPct    = pct(curWeek, totalWeeks);

  const daysLeft   = Math.max(0, Math.round(
    (new Date(activeTerm.endDate) - Date.now()) / (24 * 60 * 60 * 1000)
  ));

  return (
    <div className="content">
      {/* Topbar */}
      <div className="topbar">
        <div>
          <div className="topbar-title">Dashboard</div>
          <div className="topbar-sub">
            {activeTerm.name} &nbsp;·&nbsp; Week {curWeek} of {totalWeeks}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-outline" onClick={() => setShowPastTerms(true)}>
            Past Terms
          </button>
          <button className="btn btn-outline" onClick={() => setShowNewTerm(true)}>
            New Term
          </button>
        </div>
      </div>

      {/* Term progress banner */}
      <div style={{
        background: "linear-gradient(135deg,rgba(34,211,164,0.06),rgba(59,130,246,0.06))",
        border: "1px solid rgba(34,211,164,0.12)",
        borderRadius: 12, padding: "14px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 8, height: 8, background: "#22d3a4", borderRadius: "50%",
            boxShadow: "0 0 0 3px rgba(34,211,164,0.2)", animation: "pulseDot 2s infinite",
          }} />
          <div>
            <div style={{ fontSize: 13, color: "#8a9dbf" }}>
              <strong style={{ color: "#e8edf5" }}>{activeTerm.name}</strong> &nbsp;is active
            </div>
            <div style={{ fontSize: 11.5, color: "#4a5f80", marginTop: 2 }}>
              {new Date(activeTerm.startDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}
              {" → "}
              {new Date(activeTerm.endDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}
              &nbsp;·&nbsp; {daysLeft} days remaining
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "#8a9dbf" }}>{termPct}% complete</span>
          <div style={{ width: 120, height: 4, background: "#212f48", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              width: `${termPct}%`, height: "100%",
              background: "linear-gradient(90deg,#22d3a4,#3b82f6)", borderRadius: 2,
            }} />
          </div>
        </div>
      </div>

      {/* Today bar */}
      <div className="today-bar">
        <div className="today-left">
          <div className="pulse-dot" />
          <div>
            <div className="today-label"><strong>Today's collections</strong> are live</div>
            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>Updating in real time</div>
          </div>
        </div>
        <div className="today-right">
          <div className="today-stat">
            <div className="today-stat-val">{fmt(stats?.collectedToday)}</div>
            <div className="today-stat-lbl">Collected today</div>
          </div>
          <div className="today-stat">
            <div className="today-stat-val" style={{ color: "var(--text2)" }}>{stats?.paymentsToday ?? 0}</div>
            <div className="today-stat-lbl">Payments today</div>
          </div>
        </div>
      </div>

      {/* KPI stats */}
      <div className="stats-grid">
        {stats?.items?.map((s, i) => (
          <div className="stat" key={i}>
            <div className="stat-header">
              <div className="stat-icon" style={{ background: s.iconBg, border: `1px solid ${s.iconBorder}` }}>
                {s.icon}
              </div>
              {s.badge && (
                <div className="stat-badge" style={{ background: s.badgeBg, color: s.badgeColor }}>
                  {s.badge}
                </div>
              )}
            </div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
            <div className="stat-sub">{s.sub}</div>
            <div className="prog-bar">
              <div className={`prog-fill${s.progressClass ? " " + s.progressClass : ""}`}
                style={{ width: `${s.progress}%` }} />
            </div>
          </div>
        ))}
        {(!stats?.items || stats.items.length === 0) && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "32px", color: "#4a5f80", fontSize: 13 }}>
            No data yet for this term. Add students and record payments to see stats.
          </div>
        )}
      </div>

      {/* Two col */}
      <div className="two-col">
        {/* Recent payments */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Recent Payments</div>
              <div className="card-sub">Live feed · Today</div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => navigate("/payments")}>See all</button>
          </div>
          <div className="feed card-body-flush">
            {recentPayments.length === 0 ? (
              <div style={{ padding: "32px 20px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>
                No payments recorded yet this term.
              </div>
            ) : recentPayments.map((p, i) => (
              <div className="feed-item" key={i}>
                <div className="feed-avatar">{p.initials}</div>
                <div>
                  <div className="feed-name">{p.name}</div>
                  <div className="feed-meta">{p.meta}</div>
                  <span className="feed-txn">{p.txn}</span>
                </div>
                <div className="feed-amount">{p.amount}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Top unpaid */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Top Unpaid</div>
              <div className="card-sub">Highest balances overdue</div>
            </div>
          </div>
          {topUnpaid.length === 0 ? (
            <div style={{ padding: "32px 20px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>
              🎉 All students are paid up!
            </div>
          ) : topUnpaid.map((u, i) => (
            <div className="unpaid-item" key={i} onClick={() => navigate("/students")}>
              <div className="unpaid-rank">{u.rank}</div>
              <div className="unpaid-info">
                <div className="unpaid-name">{u.name}</div>
                <div className="unpaid-class">{u.cls}</div>
              </div>
              <div>
                <div className="unpaid-bal">{u.bal}</div>
                <span className="unpaid-days">{u.days}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modals */}
      {showNewTerm && (
        <NewTermModal
          onClose={() => setShowNewTerm(false)}
          onCreated={handleTermCreated}
          existingTerm={activeTerm}
        />
      )}
      {showPastTerms && (
        <PastTermsPanel terms={allTerms} onClose={() => setShowPastTerms(false)} />
      )}

      <style>{`
        @keyframes pulseDot{0%,100%{box-shadow:0 0 0 3px rgba(34,211,164,0.2)}50%{box-shadow:0 0 0 6px rgba(34,211,164,0.06)}}
      `}</style>
    </div>
  );
};

export default Dashboard;
