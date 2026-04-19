import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useFeeStructure } from "../hooks/useFeeStructure";

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

// ─── New Term Modal (enhanced with fee structure) ─────────────────────────────
function NewTermModal({ onClose, onCreated, existingTerm }) {
  const { token } = useAuth();
  const {
    classes, feeTypes, feeMatrix,
    addClass, removeClass, addFeeType, removeFeeType,
    setFee, getFee,
  } = useFeeStructure();

  const [step, setStep]   = useState(1); // 1=term info, 2=classes, 3=fee matrix
  const [form, setForm]   = useState({ name: "", startDate: "", endDate: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  // local state for adding new items
  const [newClass, setNewClass]       = useState("");
  const [newFeeType, setNewFeeType]   = useState("");
  const [othersLabel, setOthersLabel] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.startDate || !form.endDate) {
      setError("All fields are required."); return;
    }
    if (new Date(form.endDate) <= new Date(form.startDate)) {
      setError("End date must be after start date."); return;
    }
    setSaving(true); setError("");
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

  const STEPS = ["Term Info", "Classes", "Fee Structure"];

  const inp = {
    width: "100%", padding: "9px 12px",
    background: "#212f48", border: "1px solid #1e2d47",
    borderRadius: 8, color: "#e8edf5", fontSize: 13.5,
    fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box",
  };
  const lbl = {
    fontSize: 11.5, fontWeight: 600, color: "#8a9dbf",
    textTransform: "uppercase", letterSpacing: 0.8,
    marginBottom: 6, display: "block",
  };
  const addBtn = {
    padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600,
    background: "rgba(34,211,164,0.1)", border: "1px solid rgba(34,211,164,0.25)",
    color: "#22d3a4", cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
    whiteSpace: "nowrap",
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
        width: "100%", maxWidth: 560,
        background: "#111827", border: "1px solid #1e2d47",
        borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid #1e2d47",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>
              {existingTerm ? "Start new term" : "Create your first term"}
            </div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>
              Configure term details, classes, and fee structure
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 7,
            background: "transparent", border: "1px solid #1e2d47",
            color: "#8a9dbf", cursor: "pointer", fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>×</button>
        </div>

        {/* Step tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1e2d47", flexShrink: 0 }}>
          {STEPS.map((s, i) => (
            <div
              key={i}
              onClick={() => i < step && setStep(i + 1)}
              style={{
                flex: 1, textAlign: "center", padding: "11px 8px",
                fontSize: 12, fontWeight: 500,
                color: step === i + 1 ? "#22d3a4" : "#4a5f80",
                borderBottom: `2px solid ${step === i + 1 ? "#22d3a4" : "transparent"}`,
                cursor: i + 1 < step ? "pointer" : "default",
                transition: "all .15s",
              }}
            >
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, borderRadius: "50%", fontSize: 10, fontWeight: 700,
                marginRight: 6, flexShrink: 0,
                background: step === i + 1 ? "#22d3a4" : i + 1 < step ? "rgba(34,211,164,0.2)" : "#1e2d47",
                color: step === i + 1 ? "#0b1a14" : i + 1 < step ? "#22d3a4" : "#4a5f80",
              }}>{i + 1}</span>
              {s}
            </div>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", flex: 1 }}>

          {/* ── Step 1: Term Info ── */}
          {step === 1 && (
            <>
              {existingTerm && (
                <div style={{
                  background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)",
                  borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#f59e0b",
                }}>
                  ⚠ Closing <strong>{existingTerm.name}</strong> will lock its records. All data is saved.
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
                <div style={{ fontSize: 12, color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 8, padding: "10px 12px" }}>
                  ✕ {error}
                </div>
              )}
            </>
          )}

          {/* ── Step 2: Classes ── */}
          {step === 2 && (
            <>
              <div style={{ fontSize: 13, color: "#8a9dbf", marginBottom: 4 }}>
                Define the classes in your school. These will be available when adding students.
              </div>

              {/* Add new class */}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={{ ...inp, flex: 1 }}
                  placeholder="e.g. Form 1A or Grade 7"
                  value={newClass}
                  onChange={e => setNewClass(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { addClass(newClass); setNewClass(""); }
                  }}
                />
                <button style={addBtn} onClick={() => { addClass(newClass); setNewClass(""); }}>
                  + Add
                </button>
              </div>

              {/* Classes list */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
                {classes.length === 0 && (
                  <div style={{ fontSize: 13, color: "#4a5f80", textAlign: "center", padding: "20px 0" }}>
                    No classes added yet. Add your first class above.
                  </div>
                )}
                {classes.map(cls => (
                  <div key={cls} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    background: "#1a2540", border: "1px solid #1e2d47",
                    borderRadius: 8, padding: "9px 14px",
                  }}>
                    <span style={{ fontSize: 13.5, color: "#e8edf5", fontWeight: 500 }}>{cls}</span>
                    <button
                      onClick={() => removeClass(cls)}
                      style={{
                        width: 24, height: 24, borderRadius: 6, border: "1px solid #2a3f62",
                        background: "transparent", color: "#4a5f80", cursor: "pointer", fontSize: 14,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Step 3: Fee Matrix ── */}
          {step === 3 && (
            <>
              <div style={{ fontSize: 13, color: "#8a9dbf", marginBottom: 4 }}>
                Set the fee for each class and fee type. Leave blank for 0.
              </div>

              {/* Fee type manager */}
              <div style={{ background: "#1a2540", border: "1px solid #1e2d47", borderRadius: 10, padding: "14px 16px", marginBottom: 4 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "#8a9dbf", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10 }}>
                  Fee Types
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {feeTypes.map(ft => (
                    <div key={ft.id} style={{
                      display: "flex", alignItems: "center", gap: 5,
                      background: "rgba(34,211,164,0.06)", border: "1px solid rgba(34,211,164,0.18)",
                      borderRadius: 20, padding: "4px 10px 4px 12px",
                    }}>
                      <span style={{ fontSize: 12, color: "#22d3a4", fontWeight: 500 }}>{ft.name}</span>
                      {ft.isCustom && (
                        <button onClick={() => removeFeeType(ft.id)} style={{
                          width: 16, height: 16, borderRadius: "50%", border: "none",
                          background: "rgba(34,211,164,0.15)", color: "#22d3a4",
                          cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center",
                        }}>×</button>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={{ ...inp, flex: 1, padding: "7px 10px", fontSize: 12.5 }}
                    placeholder="Add custom fee type…"
                    value={newFeeType}
                    onChange={e => setNewFeeType(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { addFeeType(newFeeType); setNewFeeType(""); }
                    }}
                  />
                  <button style={{ ...addBtn, fontSize: 11.5 }} onClick={() => { addFeeType(newFeeType); setNewFeeType(""); }}>
                    + Add type
                  </button>
                </div>
              </div>

              {/* Fee matrix table */}
              {classes.length === 0 ? (
                <div style={{ fontSize: 13, color: "#4a5f80", textAlign: "center", padding: "20px 0" }}>
                  No classes configured. Go back to Step 2 to add classes.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px 10px", color: "#4a5f80", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #1e2d47" }}>Class</th>
                        {feeTypes.map(ft => (
                          <th key={ft.id} style={{ textAlign: "right", padding: "8px 10px", color: "#4a5f80", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #1e2d47", whiteSpace: "nowrap" }}>
                            {ft.name}
                          </th>
                        ))}
                        <th style={{ textAlign: "right", padding: "8px 10px", color: "#22d3a4", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #1e2d47" }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {classes.map(cls => {
                        const total = feeTypes.reduce((sum, ft) => sum + getFee(cls, ft.id), 0);
                        return (
                          <tr key={cls}>
                            <td style={{ padding: "8px 10px", color: "#e8edf5", fontWeight: 500, borderBottom: "1px solid rgba(30,45,71,0.5)", whiteSpace: "nowrap" }}>
                              {cls}
                            </td>
                            {feeTypes.map(ft => (
                              <td key={ft.id} style={{ padding: "4px 6px", borderBottom: "1px solid rgba(30,45,71,0.5)" }}>
                                <input
                                  type="number"
                                  min="0"
                                  value={getFee(cls, ft.id) || ""}
                                  onChange={e => setFee(cls, ft.id, e.target.value)}
                                  placeholder="0"
                                  style={{
                                    width: 90, padding: "6px 8px", textAlign: "right",
                                    background: "#212f48", border: "1px solid #1e2d47",
                                    borderRadius: 6, color: "#e8edf5", fontSize: 12.5,
                                    fontFamily: "'DM Sans', sans-serif", outline: "none",
                                  }}
                                />
                              </td>
                            ))}
                            <td style={{ padding: "8px 10px", textAlign: "right", color: "#22d3a4", fontWeight: 600, borderBottom: "1px solid rgba(30,45,71,0.5)", whiteSpace: "nowrap" }}>
                              {total > 0 ? `KES ${total.toLocaleString()}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 24px", borderTop: "1px solid #1e2d47",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexShrink: 0,
        }}>
          <button
            onClick={() => step > 1 ? setStep(s => s - 1) : onClose()}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13,
              background: "transparent", border: "1px solid #1e2d47",
              color: "#8a9dbf", cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
            }}
          >
            {step > 1 ? "← Back" : "Cancel"}
          </button>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {step < 3 ? (
              <button
                onClick={() => {
                  if (step === 1) {
                    if (!form.name.trim() || !form.startDate || !form.endDate) { setError("All fields are required."); return; }
                    if (new Date(form.endDate) <= new Date(form.startDate)) { setError("End date must be after start date."); return; }
                    setError("");
                  }
                  setStep(s => s + 1);
                }}
                style={{
                  padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: "#22d3a4", border: "none", color: "#0b1a14",
                  cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                }}
              >
                Next →
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={saving}
                style={{
                  padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: saving ? "#212f48" : "#22d3a4",
                  border: "none", color: saving ? "#4a5f80" : "#0b1a14",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontFamily: "'DM Sans',sans-serif",
                }}
              >
                {saving ? "Creating…" : existingTerm ? "Close & start new term" : "Create term"}
              </button>
            )}
          </div>
        </div>
      </div>
      <style>{`input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5)} input[type=number]::-webkit-inner-spin-button{opacity:0.3}`}</style>
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
      a.href = url; a.download = `${term.name.replace(/\s+/g, "_")}.${ext}`; a.click();
      URL.revokeObjectURL(url);
    } catch { alert("Export failed. Please try again."); }
    finally { setDownloading(null); }
  };

  const closed = terms.filter((t) => t.status === "closed");

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", zIndex: 50,
        transform: "translate(-50%,-50%)", width: "100%", maxWidth: 520,
        background: "#111827", border: "1px solid #1e2d47",
        borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        overflow: "hidden", maxHeight: "80vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #1e2d47", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>Past Terms</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "transparent", border: "1px solid #1e2d47", color: "#8a9dbf", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>
          {closed.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 0", fontSize: 13, color: "#4a5f80" }}>No past terms yet.</div>
          ) : closed.map(term => (
            <div key={term.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid #1e2d47" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#e8edf5" }}>{term.name}</div>
                <div style={{ fontSize: 11.5, color: "#4a5f80", marginTop: 2 }}>
                  {new Date(term.startDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })} →{" "}
                  {new Date(term.endDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {["excel", "pdf"].map(fmt => (
                  <button
                    key={fmt}
                    onClick={() => download(term, fmt)}
                    disabled={downloading === `${term.id}-${fmt}`}
                    style={{
                      padding: "6px 12px", borderRadius: 7, fontSize: 11.5, fontWeight: 600,
                      background: fmt === "excel" ? "rgba(34,211,164,0.08)" : "rgba(59,130,246,0.08)",
                      border: `1px solid ${fmt === "excel" ? "rgba(34,211,164,0.2)" : "rgba(59,130,246,0.2)"}`,
                      color: fmt === "excel" ? "#22d3a4" : "#3b82f6",
                      cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                    }}
                  >
                    {downloading === `${term.id}-${fmt}` ? "…" : fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { token } = useAuth();
  const navigate  = useNavigate();

  const [activeTerm,     setActiveTerm]     = useState(null);
  const [allTerms,       setAllTerms]       = useState([]);
  const [stats,          setStats]          = useState(null);
  const [recentPayments, setRecentPayments] = useState([]);
  const [topUnpaid,      setTopUnpaid]      = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [showNewTerm,    setShowNewTerm]    = useState(false);
  const [showPastTerms,  setShowPastTerms]  = useState(false);

  useEffect(() => {
    Promise.all([
      axios.get(`${API}/api/terms`,          { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${API}/api/dashboard/stats`,{ headers: { Authorization: `Bearer ${token}` } }),
    ]).then(([termsRes, statsRes]) => {
      const terms = termsRes.data;
      setAllTerms(terms);
      setActiveTerm(terms.find(t => t.status === "active") || null);
      setStats(statsRes.data?.summary || null);
      setRecentPayments(statsRes.data?.recentPayments || []);
      setTopUnpaid(statsRes.data?.topUnpaid || []);
    }).catch(console.error)
    .finally(() => setLoading(false));
  }, [token]);

  const handleTermCreated = (newTerm) => {
    setAllTerms(prev => [...prev.map(t => ({ ...t, status: "closed" })), newTerm]);
    setActiveTerm(newTerm);
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid #1e2d47", borderTop: "2px solid #22d3a4", animation: "spin 0.8s linear infinite" }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!activeTerm) {
    return (
      <div className="content">
        <div className="topbar">
          <div><div className="topbar-title">Dashboard</div></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 20 }}>
          <div style={{ fontSize: 48 }}>🏫</div>
          <div style={{ fontSize: 20, fontFamily: "'DM Serif Display',serif", color: "#e8edf5" }}>Welcome to FeeFlow</div>
          <div style={{ fontSize: 14, color: "#4a5f80", textAlign: "center", maxWidth: 340 }}>
            Create your first term to start tracking student fees, classes, and payments.
          </div>
          <button className="btn btn-primary" onClick={() => setShowNewTerm(true)}>
            Create First Term →
          </button>
        </div>
        {showNewTerm && (
          <NewTermModal onClose={() => setShowNewTerm(false)} onCreated={handleTermCreated} existingTerm={null} />
        )}
      </div>
    );
  }

  const totalWeeks = weeksBetween(activeTerm.startDate, activeTerm.endDate);
  const curWeek    = currentWeek(activeTerm.startDate);
  const termPct    = pct(curWeek, totalWeeks);
  const daysLeft   = Math.max(0, Math.round((new Date(activeTerm.endDate) - Date.now()) / (24 * 60 * 60 * 1000)));

  return (
    <div className="content">
      <div className="topbar">
        <div>
          <div className="topbar-title">Dashboard</div>
          <div className="topbar-sub">{activeTerm.name} &nbsp;·&nbsp; Week {curWeek} of {totalWeeks}</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-outline" onClick={() => setShowPastTerms(true)}>Past Terms</button>
          <button className="btn btn-outline" onClick={() => setShowNewTerm(true)}>New Term</button>
        </div>
      </div>

      {/* Term progress banner */}
      <div style={{
        background: "linear-gradient(135deg,rgba(34,211,164,0.06),rgba(59,130,246,0.06))",
        border: "1px solid rgba(34,211,164,0.12)", borderRadius: 12, padding: "14px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 8, height: 8, background: "#22d3a4", borderRadius: "50%", boxShadow: "0 0 0 3px rgba(34,211,164,0.2)", animation: "pulseDot 2s infinite" }} />
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
            <div style={{ width: `${termPct}%`, height: "100%", background: "linear-gradient(90deg,#22d3a4,#3b82f6)", borderRadius: 2 }} />
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
              <div className="stat-icon" style={{ background: s.iconBg, border: `1px solid ${s.iconBorder}` }}>{s.icon}</div>
              {s.badge && <div className="stat-badge" style={{ background: s.badgeBg, color: s.badgeColor }}>{s.badge}</div>}
            </div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
            <div className="stat-sub">{s.sub}</div>
            <div className="prog-bar">
              <div className={`prog-fill${s.progressClass ? " " + s.progressClass : ""}`} style={{ width: `${s.progress}%` }} />
            </div>
          </div>
        ))}
        {(!stats?.items || stats.items.length === 0) && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "32px", color: "#4a5f80", fontSize: 13 }}>
            No data yet. Add students and record payments to see stats.
          </div>
        )}
      </div>

      {/* Two col */}
      <div className="two-col">
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
              <div style={{ padding: "32px 20px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>No payments recorded yet this term.</div>
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

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Top Unpaid</div>
              <div className="card-sub">Highest balances overdue</div>
            </div>
          </div>
          {topUnpaid.length === 0 ? (
            <div style={{ padding: "32px 20px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>🎉 All students are paid up!</div>
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

      {showNewTerm && (
        <NewTermModal onClose={() => setShowNewTerm(false)} onCreated={handleTermCreated} existingTerm={activeTerm} />
      )}
      {showPastTerms && (
        <PastTermsPanel terms={allTerms} onClose={() => setShowPastTerms(false)} />
      )}

      <style>{`
        @keyframes pulseDot{0%,100%{box-shadow:0 0 0 3px rgba(34,211,164,0.2)}50%{box-shadow:0 0 0 6px rgba(34,211,164,0.06)}}
      `}</style>
    </div>
  );
}
