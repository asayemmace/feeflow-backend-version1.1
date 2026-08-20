import React, { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useFeeStructure } from "../hooks/useFeeStructure";
import useAppStore from "../store/useAppStore";
import Topbar from "../components/TopBar";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clampPct = value => Math.max(0, Math.min(100, safeNumber(value)));
const fmt = n => `KES ${safeNumber(n).toLocaleString()}`;
function weeksBetween(s, e) { return Math.max(1, Math.round((new Date(e) - new Date(s)) / (7 * 24 * 60 * 60 * 1000))); }
function currentWeek(s)     { return Math.max(1, Math.ceil((Date.now() - new Date(s)) / (7 * 24 * 60 * 60 * 1000))); }
function pct(a, b)           { return safeNumber(b) > 0 ? Math.round(clampPct((safeNumber(a) / safeNumber(b)) * 100)) : 0; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ item, index }) {
  const barColor = item.progressClass === "bad" ? "var(--red)" : item.progressClass === "warn" ? "var(--amber)" : "var(--green)";
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "20px 20px 16px", transition: "border-color .18s, box-shadow .18s", animation: "fadeUp .3s ease both", animationDelay: `${index * 0.06}s` }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border2)"; e.currentTarget.style.boxShadow = "var(--shadow)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)";  e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: item.iconBg, border: `1px solid ${item.iconBorder}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke={item.iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={item.iconPath}/></svg>
        </div>
        {item.badge && <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 20, background: item.badgeBg, color: item.badgeColor }}>{item.badge}</span>}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-1.2px", lineHeight: 1, marginBottom: 5, fontVariantNumeric: "tabular-nums", color: item.valueColor || "var(--text)" }}>{item.value}</div>
      <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: ".6px" }}>{item.label}</div>
      <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>{item.sub}</div>
      <div style={{ height: 4, background: "var(--surface3)", borderRadius: 2, overflow: "hidden", marginTop: 8 }}>
        <div style={{ width: `${item.progress || 0}%`, height: "100%", borderRadius: 2, background: barColor, transition: "width .4s ease" }} />
      </div>
    </div>
  );
}

function StatSkeleton({ index }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 20, animation: "fadeUp .3s ease both", animationDelay: `${index * 0.06}s` }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--surface2)", marginBottom: 14 }} />
      <div style={{ width: "65%", height: 26, borderRadius: 6, background: "var(--surface2)", marginBottom: 8 }} />
      <div style={{ width: "45%", height: 11, borderRadius: 4, background: "var(--surface2)", marginBottom: 14 }} />
      <div style={{ width: "100%", height: 4, borderRadius: 2, background: "var(--surface2)" }} />
    </div>
  );
}

// ─── New Term Modal — 4 steps including fee update ────────────────────────────
function NewTermModal({ onClose, onCreated, existingTerm }) {
  const { token } = useAuth();
  const { classes, feeTypes, addClass, removeClass, addFeeType, removeFeeType, setFee, getFee } = useFeeStructure();
  const students = useAppStore(s => s.students);

  const [step, setStep]     = useState(1);
  const [form, setForm]     = useState({ name: "", startDate: "", endDate: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");
  const [newClass, setNewClass]     = useState("");
  const [newFeeType, setNewFeeType] = useState("");

  const classCounts = students.reduce((acc, s) => {
    if (s.cls) acc[s.cls] = (acc[s.cls] || 0) + 1;
    return acc;
  }, {});
  const allTermClasses = [...new Set([...classes, ...students.map(s => s.cls)])].filter(Boolean).sort();
  const feeTotalForClass = cls => feeTypes.reduce((sum, ft) => sum + safeNumber(getFee(cls, ft.id)), 0);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.startDate || !form.endDate) { setError("All fields are required."); return; }
    if (new Date(form.endDate) <= new Date(form.startDate)) { setError("End date must be after start date."); return; }
    setSaving(true); setError("");
    try {
      const feeUpdates = {};
      allTermClasses.forEach(cls => { feeUpdates[cls] = feeTotalForClass(cls); });

      // Snapshot current ledger totals BEFORE the server starts the new term, so PastTermsPanel
      // can use the closed term's ledger values when generating the PDF report.
      const studentSnapshot = students.reduce((acc, s) => {
        acc[s.id] = {
          totalCharges: s.currentTermCharges ?? s.totalCharges ?? s.lifetimeCharges ?? 0,
          totalPaid: s.currentTermPaid ?? s.totalPaid ?? s.lifetimePaid ?? 0,
          outstanding: s.currentTermOutstanding ?? s.outstanding ?? s.lifetimeOutstanding ?? 0,
          cls: s.cls, name: s.name, adm: s.adm, parentName: s.parentName, parentPhone: s.parentPhone,
        };
        return acc;
      }, {});

      const res = await axios.post(`${API}/api/terms`,
        { name: form.name.trim(), startDate: form.startDate, endDate: form.endDate, feeUpdates, confirmReset: true },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await onCreated(res.data, feeUpdates, studentSnapshot);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to create term.");
    } finally { setSaving(false); }
  };

  const STEPS = ["Term Info", "Classes", "Fee Structure", "Confirm Fees"];

  const inp = { width: "100%", padding: "9px 12px", background: "#212f48", border: "1px solid #1e2d47", borderRadius: 8, color: "#e8edf5", fontSize: 13.5, fontFamily: "'DM Sans',sans-serif", outline: "none", boxSizing: "border-box" };
  const lbl = { fontSize: 11.5, fontWeight: 600, color: "#8a9dbf", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, display: "block" };
  const addBtn = { padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, background: "rgba(34,211,164,0.1)", border: "1px solid rgba(34,211,164,0.25)", color: "#22d3a4", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", whiteSpace: "nowrap" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)" }} />
      <div className="responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", zIndex: 50, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 580, background: "#111827", border: "1px solid #1e2d47", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>

        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #1e2d47", display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>{existingTerm ? "Start new term" : "Create your first term"}</div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>Set dates, classes, fees — then apply to all students</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "transparent", border: "1px solid #1e2d47", color: "#8a9dbf", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>

        {/* Step tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1e2d47", flexShrink: 0 }}>
          {STEPS.map((s, i) => (
            <div key={i} onClick={() => i + 1 < step && setStep(i + 1)} style={{ flex: 1, textAlign: "center", padding: "10px 4px", fontSize: 11.5, fontWeight: 500, color: step === i + 1 ? "#22d3a4" : "#4a5f80", borderBottom: `2px solid ${step === i + 1 ? "#22d3a4" : "transparent"}`, cursor: i + 1 < step ? "pointer" : "default", transition: "all .15s" }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 17, height: 17, borderRadius: "50%", fontSize: 9, fontWeight: 700, marginRight: 5, background: step === i + 1 ? "#22d3a4" : i + 1 < step ? "rgba(34,211,164,0.2)" : "#1e2d47", color: step === i + 1 ? "#0b1a14" : i + 1 < step ? "#22d3a4" : "#4a5f80" }}>{i + 1}</span>
              {s}
            </div>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", flex: 1 }}>

          {/* Step 1 */}
          {step === 1 && (
            <>
              {existingTerm && (
                <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#f59e0b" }}>
                  ⚠ Closing <strong>{existingTerm.name}</strong> will archive its term report. New charges are created from Step 3 fees.
                </div>
              )}
              <div><label style={lbl}>Term name</label><input style={inp} placeholder="e.g. Term 2 — 2025" value={form.name} onChange={set("name")} /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div><label style={lbl}>Start date</label><input type="date" style={inp} value={form.startDate} onChange={set("startDate")} /></div>
                <div><label style={lbl}>End date</label><input type="date" style={inp} value={form.endDate} onChange={set("endDate")} /></div>
              </div>
              {error && <div style={{ fontSize: 12, color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 8, padding: "10px 12px" }}>✕ {error}</div>}
            </>
          )}

          {/* Step 2 */}
          {step === 2 && (
            <>
              <div style={{ fontSize: 13, color: "#8a9dbf" }}>Define the classes in your school.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...inp, flex: 1 }} placeholder="e.g. Form 1A or Grade 7" value={newClass} onChange={e => setNewClass(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { addClass(newClass); setNewClass(""); } }} />
                <button style={addBtn} onClick={() => { addClass(newClass); setNewClass(""); }}>+ Add</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
                {classes.length === 0 && <div style={{ fontSize: 13, color: "#4a5f80", textAlign: "center", padding: "20px 0" }}>No classes added yet.</div>}
                {classes.map(cls => (
                  <div key={cls} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#1a2540", border: "1px solid #1e2d47", borderRadius: 8, padding: "9px 14px" }}>
                    <span style={{ fontSize: 13.5, color: "#e8edf5", fontWeight: 500 }}>{cls}</span>
                    <button onClick={() => removeClass(cls)} style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #2a3f62", background: "transparent", color: "#4a5f80", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Step 3 */}
          {step === 3 && (
            <>
              <div style={{ fontSize: 13, color: "#8a9dbf" }}>Set per-class, per-type fee defaults.</div>
              <div style={{ background: "#1a2540", border: "1px solid #1e2d47", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "#8a9dbf", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10 }}>Fee Types</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {feeTypes.map(ft => (
                    <div key={ft.id} style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(34,211,164,0.06)", border: "1px solid rgba(34,211,164,0.18)", borderRadius: 20, padding: "4px 10px 4px 12px" }}>
                      <span style={{ fontSize: 12, color: "#22d3a4", fontWeight: 500 }}>{ft.name}</span>
                      {ft.isCustom && <button onClick={() => removeFeeType(ft.id)} style={{ width: 16, height: 16, borderRadius: "50%", border: "none", background: "rgba(34,211,164,0.15)", color: "#22d3a4", cursor: "pointer", fontSize: 11 }}>×</button>}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...inp, flex: 1, padding: "7px 10px", fontSize: 12.5 }} placeholder="Add custom fee type…" value={newFeeType} onChange={e => setNewFeeType(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { addFeeType(newFeeType); setNewFeeType(""); } }} />
                  <button style={{ ...addBtn, fontSize: 11.5 }} onClick={() => { addFeeType(newFeeType); setNewFeeType(""); }}>+ Add type</button>
                </div>
              </div>
              {allTermClasses.length === 0 ? <div style={{ fontSize: 13, color: "#4a5f80", textAlign: "center" }}>No classes yet — go back to Step 2.</div> : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead><tr>
                      <th style={{ textAlign: "left", padding: "8px 10px", color: "#4a5f80", fontWeight: 600, fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #1e2d47" }}>Class</th>
                      {feeTypes.map(ft => <th key={ft.id} style={{ textAlign: "right", padding: "8px 10px", color: "#4a5f80", fontWeight: 600, fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #1e2d47", whiteSpace: "nowrap" }}>{ft.name}</th>)}
                      <th style={{ textAlign: "right", padding: "8px 10px", color: "#22d3a4", fontWeight: 700, fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #1e2d47" }}>Total</th>
                    </tr></thead>
                    <tbody>
                      {allTermClasses.map(cls => {
                        const total = feeTotalForClass(cls);
                        return (
                          <tr key={cls}>
                            <td style={{ padding: "8px 10px", color: "#e8edf5", fontWeight: 500, borderBottom: "1px solid rgba(30,45,71,0.5)", whiteSpace: "nowrap" }}>{cls}</td>
                            {feeTypes.map(ft => (
                              <td key={ft.id} style={{ padding: "4px 6px", borderBottom: "1px solid rgba(30,45,71,0.5)" }}>
                                <input type="number" min="0" value={getFee(cls, ft.id) || ""} onChange={e => setFee(cls, ft.id, e.target.value)} placeholder="0"
                                  style={{ width: 90, padding: "6px 8px", textAlign: "right", background: "#212f48", border: "1px solid #1e2d47", borderRadius: 6, color: "#e8edf5", fontSize: 12.5, fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
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

          {/* Step 4 - Confirm fees for every class */}
          {step === 4 && (
            <>
              <div style={{ fontSize: 13, color: "#8a9dbf" }}>
                Confirm the new term fees from Step 3 before starting the term.
              </div>

              {allTermClasses.length === 0 ? (
                <div style={{ fontSize: 13, color: "#4a5f80", textAlign: "center", padding: "20px 0" }}>No classes added yet - go back to Step 2.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {allTermClasses.map(cls => {
                    const newTermFee = feeTotalForClass(cls);
                    const count = classCounts[cls] || 0;
                    const breakdown = feeTypes
                      .map(ft => ({ name: ft.name, amount: safeNumber(getFee(cls, ft.id)) }))
                      .filter(ft => ft.amount > 0);
                    return (
                      <div key={cls} style={{ background: "#1a2540", border: "1px solid #1e2d47", borderRadius: 9, padding: "11px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13.5, color: "#e8edf5", fontWeight: 500 }}>{cls}</div>
                            <div style={{ fontSize: 11.5, color: "#4a5f80", marginTop: 2 }}>
                              {count} student{count !== 1 ? "s" : ""}
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 11.5, color: "#4a5f80", marginBottom: 2 }}>New term fee</div>
                            <div style={{ fontSize: 14, color: newTermFee > 0 ? "#22d3a4" : "#f87171", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>KES {newTermFee.toLocaleString()}</div>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}>
                          {breakdown.length === 0
                            ? <span style={{ fontSize: 11.5, color: "#f87171" }}>No fee breakdown set</span>
                            : breakdown.map(ft => (
                              <span key={ft.name} style={{ fontSize: 11.5, color: "#8a9dbf", background: "#111827", border: "1px solid #1e2d47", borderRadius: 999, padding: "3px 8px" }}>
                                {ft.name}: KES {ft.amount.toLocaleString()}
                              </span>
                            ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ background: "rgba(34,211,164,0.04)", border: "1px solid rgba(34,211,164,0.15)", borderRadius: 9, padding: "11px 14px", fontSize: 12.5, color: "#8a9dbf" }}>
                These fees create fresh charges for the new term only. Past term charges and payments stay archived.
              </div>
              {error && <div style={{ fontSize: 12, color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 8, padding: "10px 12px" }}>x {error}</div>}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid #1e2d47", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <button onClick={() => step > 1 ? setStep(s => s - 1) : onClose()} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid #1e2d47", color: "#8a9dbf", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            {step > 1 ? "← Back" : "Cancel"}
          </button>
          {step < 4
            ? <button onClick={() => {
                if (step === 1) {
                  if (!form.name.trim() || !form.startDate || !form.endDate) { setError("All fields are required."); return; }
                  if (new Date(form.endDate) <= new Date(form.startDate)) { setError("End date must be after start date."); return; }
                  setError("");
                }
                setStep(s => s + 1);
              }} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#22d3a4", border: "none", color: "#0b1a14", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Next →</button>
            : <button onClick={handleSubmit} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: saving ? "#212f48" : "#22d3a4", border: "none", color: saving ? "#4a5f80" : "#0b1a14", cursor: saving ? "not-allowed" : "pointer", fontFamily: "'DM Sans',sans-serif" }}>
                {saving ? "Creating…" : existingTerm ? "Close & start new term" : "Create term"}
              </button>
          }
        </div>
      </div>
      <style>{`input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5)} input[type=number]::-webkit-inner-spin-button{opacity:0.3}`}</style>
    </>
  );
}

// ─── Past Terms Panel — frontend PDF generation ───────────────────────────────
function EditTermModal({ term, onClose, onSaved }) {
  const { token } = useAuth();
  const students = useAppStore(s => s.students);
  const [form, setForm] = useState({
    name: term?.name || "",
    startDate: term?.startDate ? new Date(term.startDate).toISOString().slice(0, 10) : "",
    endDate: term?.endDate ? new Date(term.endDate).toISOString().slice(0, 10) : "",
  });
  const [classFees, setClassFees] = useState(() => ({ ...(term?.classFees || {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const classes = [...new Set([...Object.keys(term?.classFees || {}), ...students.map(s => s.cls).filter(Boolean)])].sort();

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setFee = (cls, value) => setClassFees(f => ({ ...f, [cls]: value === "" ? "" : Number(value) || 0 }));

  const handleSave = async () => {
    const termId = term?.id;
    if (!termId) return setError("Cannot save: active term ID is missing. Refresh the page and try again.");
    if (!form.name.trim() || !form.startDate || !form.endDate) return setError("All fields are required.");
    if (new Date(form.endDate) <= new Date(form.startDate)) return setError("End date must be after start date.");
    for (const [cls, amount] of Object.entries(classFees)) {
      if (safeNumber(amount) < 0) return setError(`Fee for ${cls} cannot be negative.`);
    }
    setSaving(true); setError("");
    try {
      const res = await axios.patch(`${API}/api/terms/${encodeURIComponent(termId)}`, {
        name: form.name.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        feeUpdates: classFees,
      }, { headers: { Authorization: `Bearer ${token}` } });
      await onSaved(res.data);
      onClose();
    } catch (e) {
      setError(e.response?.data?.message || "Failed to update term.");
    } finally { setSaving(false); }
  };

  const inp = { width: "100%", padding: "9px 12px", background: "#212f48", border: "1px solid #1e2d47", borderRadius: 8, color: "#e8edf5", fontSize: 13.5, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };
  const lbl = { fontSize: 11.5, fontWeight: 600, color: "#8a9dbf", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, display: "block" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)" }} />
      <div className="responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", zIndex: 50, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 540, background: "#111827", border: "1px solid #1e2d47", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #1e2d47", display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#e8edf5" }}>Edit Term</div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>Update the active term without closing it.</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "transparent", border: "1px solid #1e2d47", color: "#8a9dbf", cursor: "pointer", fontSize: 16 }}>x</button>
        </div>
        <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto" }}>
          <div><label style={lbl}>Term name</label><input style={inp} value={form.name} onChange={set("name")} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={lbl}>Start date</label><input type="date" style={inp} value={form.startDate} onChange={set("startDate")} /></div>
            <div><label style={lbl}>End date</label><input type="date" style={inp} value={form.endDate} onChange={set("endDate")} /></div>
          </div>
          <div>
            <div style={{ ...lbl, marginBottom: 8 }}>Class fees</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {classes.map(cls => (
                <div key={cls} style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, alignItems: "center", background: "#1a2540", border: "1px solid #1e2d47", borderRadius: 9, padding: "10px 12px" }}>
                  <div style={{ fontSize: 13.5, color: "#e8edf5", fontWeight: 600 }}>{cls}</div>
                  <input type="number" min="0" style={{ ...inp, textAlign: "right" }} value={classFees[cls] ?? ""} onChange={e => setFee(cls, e.target.value)} />
                </div>
              ))}
            </div>
          </div>
          {error && <div style={{ fontSize: 12, color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 8, padding: "10px 12px" }}>{error}</div>}
        </div>
        <div style={{ padding: "14px 24px", borderTop: "1px solid #1e2d47", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid #1e2d47", color: "#8a9dbf", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: saving ? "#212f48" : "#22d3a4", border: "none", color: saving ? "#4a5f80" : "#0b1a14", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving..." : "Save term"}
          </button>
        </div>
      </div>
    </>
  );
}

function PastTermsPanel({ onClose }) {
  const { token, user } = useAuth();
  const allTerms        = useAppStore(s => s.terms);
  const [downloading, setDownloading] = useState(null);

  const schoolName = user?.schoolName || "School";

  const fetchTermData = async (term) => {
    const h = { Authorization: `Bearer ${token}` };
    const res = await axios.get(`${API}/api/terms/${term.id}/report`, { headers: h });
    return res.data;
  };

  const generatePDF = (term, data) => {
    const summary = data.summary || {};
    const students = Array.isArray(data.students) ? data.students : [];
    const totalCollected = safeNumber(summary.totalCollected);
    const totalExpected = safeNumber(summary.totalExpected);
    const totalRemaining = safeNumber(summary.totalRemaining);
    const paid = students.filter(s => s.status === "fully_paid");
    const partial = students.filter(s => s.status === "partial");
    const unpaid = students.filter(s => s.status === "unpaid");
    const noCharges = students.filter(s => s.status === "no_charges");
    const pct = Math.round(clampPct(summary.collectionRate));
    const fmtD = d => d ? new Date(d).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : "—";
    const barColor = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

    const tableRows = (list, showPaid = false) => list.map(s => `
      <tr>
        <td>${s.name}</td>
        <td>${s.adm || "—"}</td>
        <td>${s.cls}</td>
        <td>${s.parentName || "—"}</td>
        <td>${s.parentPhone || "—"}</td>
        <td>${fmt(s.termCharges)}</td>
        <td>${fmt(s.termPaid)}</td>
        <td>${fmt(s.termBalance)}</td>
        <td>${s.status === "fully_paid" ? "Fully paid" : s.status === "partial" ? "Partial" : s.status === "no_charges" ? "No charges" : "Unpaid"}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${term.name} — Term Report</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;color:#1a1a2e;padding:40px;font-size:13px}
    .hdr{background:#003366;color:#fff;padding:24px 28px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .hdr h1{font-size:22px;margin-bottom:4px}.hdr .sub{font-size:12px;opacity:.75}
    .hdr .badge{font-size:11px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:4px 12px;border-radius:20px;margin-top:6px;display:inline-block}
    .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}
    .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:28px}
    .box{background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 18px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .box .val{font-size:22px;font-weight:700;color:#003366}.box .lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.8px;margin-top:4px}
    .progress-wrap{margin-bottom:28px}.progress-lbl{font-size:12px;color:#555;margin-bottom:6px}
    .progress-bar{height:10px;background:#e2e8f0;border-radius:4px;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .progress-fill{height:100%;background:${barColor};border-radius:4px;width:${pct}%;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sec{font-size:13px;font-weight:700;color:#003366;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #003366}
    table{width:100%;border-collapse:collapse;margin-bottom:28px;font-size:12.5px}
    thead tr{background:#003366;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    thead th{padding:10px 12px;text-align:left;font-weight:600;font-size:11px;letter-spacing:.5px}
    tbody tr:nth-child(even){background:#f7f9fc;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    tbody td{padding:9px 12px;border-bottom:1px solid #e8ecf0;color:#333}
    .footer{margin-top:36px;font-size:11px;color:#aaa;text-align:center;border-top:1px solid #eee;padding-top:14px}
    @media print{
      *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
      body{padding:20px}
    }
  </style>
</head>
<body>
  <div class="hdr">
    <div>
      <h1>${schoolName}</h1>
      <div class="sub">End of Term Report — ${term.name}</div>
      <div class="badge">${fmtD(term.startDate)} → ${fmtD(term.endDate)}</div>
    </div>
    <div style="text-align:right;font-size:12px;opacity:.85">
      Generated: ${new Date().toLocaleDateString("en-KE", { day:"numeric", month:"long", year:"numeric" })}
    </div>
  </div>

  <div class="grid4">
    <div class="box"><div class="val">${fmt(totalExpected)}</div><div class="lbl">Total Expected</div></div>
    <div class="box"><div class="val">${fmt(totalCollected)}</div><div class="lbl">Total Collected</div></div>
    <div class="box"><div class="val">${fmt(totalRemaining)}</div><div class="lbl">Total Remaining</div></div>
    <div class="box"><div class="val">${pct}%</div><div class="lbl">Collection Rate</div></div>
  </div>

  <div class="progress-wrap">
    <div class="progress-lbl">Collection progress — ${pct}% of expected fees collected</div>
    <div class="progress-bar"><div class="progress-fill"></div></div>
  </div>

  <div class="grid4">
    <div class="box" style="-webkit-print-color-adjust:exact;print-color-adjust:exact"><div class="val" style="color:#22c55e">${paid.length}</div><div class="lbl">Fully Paid</div></div>
    <div class="box" style="-webkit-print-color-adjust:exact;print-color-adjust:exact"><div class="val" style="color:#f59e0b">${partial.length}</div><div class="lbl">Partial Payment</div></div>
    <div class="box" style="-webkit-print-color-adjust:exact;print-color-adjust:exact"><div class="val" style="color:#ef4444">${unpaid.length}</div><div class="lbl">No Payment</div></div>
    <div class="box" style="-webkit-print-color-adjust:exact;print-color-adjust:exact"><div class="val" style="color:#64748b">${noCharges.length}</div><div class="lbl">No Charges</div></div>
  </div>

  ${paid.length > 0 ? `
  <div class="sec">Fully Paid Students (${paid.length})</div>
  <table>
    <thead><tr><th>Student Name</th><th>Adm No.</th><th>Class</th><th>Parent Name</th><th>Parent Phone</th><th>Term Fee</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
    <tbody>${tableRows(paid, true)}</tbody>
  </table>` : ""}

  ${unpaid.length > 0 ? `
  <div class="sec">Unpaid Students (${unpaid.length})</div>
  <table>
    <thead><tr><th>Student Name</th><th>Adm No.</th><th>Class</th><th>Parent Name</th><th>Parent Phone</th><th>Term Fee</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
    <tbody>${tableRows(unpaid, false)}</tbody>
  </table>` : `<p style="color:#22c55e;margin-bottom:24px;font-size:14px">🎉 All students have paid their fees this term!</p>`}

  ${partial.length > 0 ? `
  <div class="sec">Partial Payments (${partial.length})</div>
  <table>
    <thead><tr><th>Student Name</th><th>Adm No.</th><th>Class</th><th>Parent Name</th><th>Parent Phone</th><th>Term Fee</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
    <tbody>${tableRows(partial, true)}</tbody>
  </table>` : ""}

  ${noCharges.length > 0 ? `
  <div class="sec">No Charges / Missing Fee Setup (${noCharges.length})</div>
  <table>
    <thead><tr><th>Student Name</th><th>Adm No.</th><th>Class</th><th>Parent Name</th><th>Parent Phone</th><th>Term Fee</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
    <tbody>${tableRows(noCharges, false)}</tbody>
  </table>` : ""}

  <div class="footer">${schoolName} · ${term.name} · Generated by FeeFlow · All rights reserved</div>
</body>
</html>`;

    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    win.onload = () => setTimeout(() => win.print(), 500);
  };

  const handleDownload = async (term) => {
    setDownloading(term.id);
    try {
      const res = await axios.get(`${API}/api/terms/${term.id}/report/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "blob",
      });
      downloadBlob(res.data, `${term.name || "Term"}-Report.pdf`);
    } catch (e) { console.error(e); alert("Failed to generate report."); }
    finally { setDownloading(null); }
  };

  const closed = allTerms.filter(t => t.status === "closed");

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)" }} />
      <div className="responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", zIndex: 50, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 520, background: "#111827", border: "1px solid #1e2d47", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", overflow: "hidden", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #1e2d47", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>Past Terms</div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 2 }}>Download end-of-term PDF report per term</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "transparent", border: "1px solid #1e2d47", color: "#8a9dbf", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>
          {closed.length === 0
            ? <div style={{ textAlign: "center", padding: "32px 0", fontSize: 13, color: "#4a5f80" }}>No past terms yet.</div>
            : closed.map(term => (
              <div key={term.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid #1e2d47" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#e8edf5" }}>{term.name}</div>
                  <div style={{ fontSize: 11.5, color: "#4a5f80", marginTop: 2 }}>
                    {new Date(term.startDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })} → {new Date(term.endDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}
                  </div>
                </div>
                <button onClick={() => handleDownload(term)} disabled={downloading === term.id}
                  style={{ padding: "7px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, background: downloading === term.id ? "rgba(74,95,128,0.1)" : "rgba(59,130,246,0.08)", border: `1px solid ${downloading === term.id ? "#2a3f62" : "rgba(59,130,246,0.2)"}`, color: downloading === term.id ? "#4a5f80" : "#3b82f6", cursor: downloading === term.id ? "not-allowed" : "pointer", fontFamily: "'DM Sans',sans-serif", display: "flex", alignItems: "center", gap: 6 }}>
                  {downloading === term.id ? "⏳ Generating…" : "📄 Download PDF Report"}
                </button>
              </div>
            ))
          }
        </div>
        <div style={{ padding: "12px 24px", borderTop: "1px solid #1e2d47", fontSize: 11.5, color: "#4a5f80", lineHeight: 1.5 }}>
          💡 Opens in a new tab. Use <strong style={{ color: "#8a9dbf" }}>Ctrl+P / Cmd+P</strong> → Save as PDF.
        </div>
      </div>
    </>
  );
}
// ─── Dashboard Page ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { openSidebar } = useOutletContext();
  const { token, user } = useAuth();

  const activeTerm     = useAppStore(s => s.activeTerm);
  const stats          = useAppStore(s => s.stats);
  const statsLoaded    = useAppStore(s => s.statsLoaded);
  const recentPayments = useAppStore(s => s.recentPayments);
  const topUnpaid      = useAppStore(s => s.topUnpaid);
  const setNewTerm     = useAppStore(s => s.setNewTerm);
  const updateTerm     = useAppStore(s => s.updateTerm);
  const bootstrap      = useAppStore(s => s.bootstrap);
  const students       = useAppStore(s => s.students);

  const [showNewTerm,   setShowNewTerm]   = useState(false);
  const [showPastTerms, setShowPastTerms] = useState(false);
  const [showEditTerm,  setShowEditTerm]  = useState(false);
  const [toast,         setToast]         = useState(null);

  const handleTermCreated = async (newTerm, feeUpdates, studentSnapshot) => {
    // Save snapshot of student fees for the term that just closed (the previous activeTerm)
    // This lets PastTermsPanel generate correct PDFs with old fee data, not new term fees.
    if (activeTerm && studentSnapshot) {
      useAppStore.getState().saveTermSnapshot(activeTerm.id, studentSnapshot);
    }
    // Update store locally — students reset to paid=0, fees updated per class
    setNewTerm(newTerm);
    // Apply fee updates to students in the store
    await bootstrap(token);
  };

  const handleTermEdited = async ({ term }) => {
    updateTerm(term);
    await bootstrap(token);
    setToast({ type: "success", msg: "Term updated successfully" });
    setTimeout(() => setToast(null), 3000);
  };

  if (!activeTerm) {
    return (
      <div className="content">
        <Topbar title={user?.schoolName || "Dashboard"} onMenuClick={openSidebar} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 20 }}>
          <div style={{ fontSize: 48 }}>🏫</div>
          <div style={{ fontSize: 20, fontFamily: "'DM Serif Display',serif", color: "var(--text)" }}>Welcome to FeeFlow</div>
          <div style={{ fontSize: 14, color: "var(--text3)", textAlign: "center", maxWidth: 340 }}>Create your first term to start tracking student fees, classes, and payments.</div>
          <button className="btn btn-primary" onClick={() => setShowNewTerm(true)}>Create First Term →</button>
        </div>
        {showNewTerm && <NewTermModal onClose={() => setShowNewTerm(false)} onCreated={handleTermCreated} existingTerm={null} />}
      </div>
    );
  }

  const totalWeeks = weeksBetween(activeTerm.startDate, activeTerm.endDate);
  const curWeek    = currentWeek(activeTerm.startDate);
  const termPct    = pct(curWeek, totalWeeks);
  const daysLeft   = Math.max(0, Math.round((new Date(activeTerm.endDate) - Date.now()) / (24 * 60 * 60 * 1000)));

  return (
    <div className="content">
      <Topbar title={user?.schoolName || "Dashboard"} sub={`${activeTerm.name} - Week ${curWeek} of ${totalWeeks}`} onMenuClick={openSidebar}>
        <button className="btn btn-outline" onClick={() => setShowPastTerms(true)}>Past Terms</button>
        <button className="btn btn-outline" onClick={() => setShowEditTerm(true)}>Edit Term</button>
        <button className="btn btn-outline" onClick={() => setShowNewTerm(true)}>New Term</button>
      </Topbar>
      {/* Term banner */}
      <div className="term-banner" style={{ background: "linear-gradient(135deg,var(--green-bg),var(--blue-bg))", border: "1px solid var(--green-border)", borderRadius: 14, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="pulse-dot" />
          <div>
            <div style={{ fontSize: 13, color: "var(--text2)" }}><strong style={{ color: "var(--text)" }}>{activeTerm.name}</strong> &nbsp;is active</div>
            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>
              {new Date(activeTerm.startDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })} → {new Date(activeTerm.endDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })} &nbsp;·&nbsp; {daysLeft} days remaining
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "var(--text3)" }}>{termPct}% complete</span>
          <div style={{ width: 120, height: 4, background: "var(--surface3)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${termPct}%`, height: "100%", background: "var(--green)", borderRadius: 2, transition: "width .4s ease" }} />
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "var(--surface)", border: "1px solid var(--green-border)", borderLeft: "3px solid var(--green)", borderRadius: 10, padding: "12px 20px", fontSize: 13, color: "var(--text)", boxShadow: "var(--shadow)" }}>
          {toast.msg}
        </div>
      )}

      {/* Today callout */}
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

      {/* 4 stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 28 }} className="stats-grid-r">
        {stats?.items?.length > 0
          ? stats.items.map((item, i) => <StatCard key={i} item={item} index={i} />)
          : [0,1,2,3].map(i => <StatSkeleton key={i} index={i} />)
        }
      </div>

      {/* Two col */}
      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <div><div className="card-title">Recent Payments</div><div className="card-sub">Latest recorded</div></div>
            <button className="btn btn-outline btn-sm" onClick={() => navigate("/payments")}>See all</button>
          </div>
          <div className="card-body-flush">
            {recentPayments.length === 0
              ? <div style={{ padding: "36px 20px", textAlign: "center" }}><div style={{ fontSize: 28, marginBottom: 10 }}>💳</div><div style={{ fontSize: 13, color: "var(--text3)" }}>No payments recorded yet.</div></div>
              : recentPayments.map((p, i) => (
                <div key={p.id || i} className="feed-item">
                  <div className="feed-avatar">{p.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="feed-name">{p.name}</div>
                    <div className="feed-meta">{p.meta}</div>
                    {p.txn && p.txn !== "—" && <span className="feed-txn">{p.txn}</span>}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div className="feed-amount">{p.amount}</div>
                    <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                  </div>
                </div>
              ))
            }
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><div className="card-title">Top Unpaid</div><div className="card-sub">Highest outstanding balances</div></div></div>
          {topUnpaid.length === 0
            ? <div style={{ padding: "36px 20px", textAlign: "center" }}><div style={{ fontSize: 28, marginBottom: 10 }}>🎉</div><div style={{ fontSize: 13, color: "var(--text3)" }}>All students are paid up!</div></div>
            : topUnpaid.map((u, i) => (
              <div key={i} className="unpaid-item" onClick={() => navigate("/students")}>
                <div className="unpaid-rank">{u.rank}</div>
                <div className="unpaid-info"><div className="unpaid-name">{u.name}</div><div className="unpaid-class">{u.cls}</div></div>
                <div style={{ textAlign: "right" }}><div className="unpaid-bal">{u.bal}</div><span className="unpaid-days">{u.days}</span></div>
              </div>
            ))
          }
        </div>
      </div>

      {showNewTerm   && <NewTermModal   onClose={() => setShowNewTerm(false)}   onCreated={handleTermCreated} existingTerm={activeTerm} />}
      {showEditTerm  && <EditTermModal  term={activeTerm} onClose={() => setShowEditTerm(false)} onSaved={handleTermEdited} />}
      {showPastTerms && <PastTermsPanel onClose={() => setShowPastTerms(false)} />}

      <style>{`
        @keyframes pulseAnim{0%,100%{box-shadow:0 0 0 3px var(--green-bg)}50%{box-shadow:0 0 0 7px transparent}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .stats-grid-r{grid-template-columns:repeat(4,1fr)}
        @media(max-width:900px){.stats-grid-r{grid-template-columns:1fr 1fr !important}}
        @media(max-width:600px){.stats-grid-r{grid-template-columns:1fr !important}}
      `}</style>
    </div>
  );
}


