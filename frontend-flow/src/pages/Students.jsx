import { useState, useMemo } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import { useFeeStructure } from "../hooks/useFeeStructure";
import useAppStore from "../store/useAppStore";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

function computeStatus(fee, paid) {
  if (paid <= 0)   return "overdue";
  if (paid >= fee) return "paid";
  return "partial";
}

function Badge({ status }) {
  const map = { paid: { cls: "badge-paid", label: "Paid" }, partial: { cls: "badge-partial", label: "Partial" }, overdue: { cls: "badge-overdue", label: "Overdue" } };
  const { cls, label } = map[status] || map.overdue;
  return <span className={cls}>{label}</span>;
}

function Avatar({ name, size = 32 }) {
  const initials = name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const hue      = (name.charCodeAt(0) * 37 + name.charCodeAt(name.length - 1) * 13) % 360;
  return (
    <div style={{ width: size, height: size, borderRadius: size > 40 ? 12 : 8, flexShrink: 0, background: `hsl(${hue},55%,28%)`, border: `1px solid hsl(${hue},55%,38%)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, fontWeight: 600, color: `hsl(${hue},80%,78%)`, letterSpacing: 0.5 }}>
      {initials}
    </div>
  );
}

function ProgressBar({ fee, paid, height = 4 }) {
  const p = fee > 0 ? Math.min(100, (paid / fee) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height, background: "var(--surface3)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${p}%`, height: "100%", borderRadius: 2, transition: "width .4s ease", background: p >= 100 ? "var(--green)" : p > 0 ? "var(--amber)" : "var(--red)" }} />
      </div>
      <span style={{ fontSize: 11, color: "var(--text3)", minWidth: 32, textAlign: "right" }}>{Math.round(p)}%</span>
    </div>
  );
}

// ─── Edit Student Modal ───────────────────────────────────────────────────────
function EditStudentModal({ student, onClose, token }) {
  const { classes } = useFeeStructure();
  const updateStudent = useAppStore(s => s.updateStudent);

  const [form, setForm] = useState({
    name:  student.name  || "",
    cls:   student.cls   || "",
    phone: student.phone || "",
    fee:   student.fee   || "",
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState("");

  const setFv = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.cls)          { setError("Select a class."); return; }
    const fee = parseFloat(form.fee);
    if (isNaN(fee) || fee <= 0) { setError("Enter a valid fee."); return; }

    setSaving(true); setError("");
    try {
      const res = await axios.patch(`${API}/api/students/${student.id}`,
        { name: form.name.trim(), cls: form.cls, phone: form.phone.trim() || null, fee },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      updateStudent(res.data);
      onClose();
    } catch (e) {
      setError(e.response?.data?.message || "Failed to update student.");
    } finally { setSaving(false); }
  };

  const inp = { width: "100%", padding: "10px 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 440, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", animation: "modalIn .18s ease" }}>
        <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Edit Student</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>{student.adm}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 14 }}>×</button>
        </div>

        <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field-group">
            <label className="settings-label">Full name *</label>
            <input style={inp} value={form.name} onChange={setFv("name")} placeholder="Student name" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field-group">
              <label className="settings-label">Class *</label>
              <select style={{ ...inp, cursor: "pointer" }} value={form.cls} onChange={setFv("cls")}>
                <option value="">Select…</option>
                {classes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label className="settings-label">Phone</label>
              <input style={inp} value={form.phone} onChange={setFv("phone")} placeholder="07XX XXX XXX" />
            </div>
          </div>
          <div className="field-group">
            <label className="settings-label">Term fee (KES) *</label>
            <input type="number" min="0" style={inp} value={form.fee} onChange={setFv("fee")} placeholder="e.g. 22000" />
          </div>
          {error && <div style={{ fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "10px 12px" }}>✕ {error}</div>}
        </div>

        <div style={{ padding: "14px 20px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ padding: "9px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: saving ? "var(--surface2)" : "var(--green)", border: "none", color: saving ? "var(--text3)" : "#0b1a14", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Student Profile Modal ─────────────────────────────────────────────────────
function StudentProfileModal({ studentId, onClose, onEdit, token }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");

  // Fetch on open
  useState(() => {
    axios.get(`${API}/api/students/${studentId}/payments`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setData(r.data))
      .catch(() => setError("Failed to load profile."))
      .finally(() => setLoading(false));
  });

  // Re-fetch on mount
  const [fetched, setFetched] = useState(false);
  if (!fetched) {
    setFetched(true);
    axios.get(`${API}/api/students/${studentId}/payments`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setData(r.data))
      .catch(() => setError("Failed to load profile."))
      .finally(() => setLoading(false));
  }

  const methodColor = { mpesa: "var(--green)", bank: "var(--blue)", cash: "var(--amber)", manual: "var(--text3)" };
  const methodLabel = { mpesa: "M-Pesa", bank: "Bank", cash: "Cash", manual: "Manual" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", zIndex: 50, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 520, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", maxHeight: "90vh", animation: "modalIn .2s ease" }}>
        <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Student Profile</div>
          <div style={{ display: "flex", gap: 8 }}>
            {data && <button onClick={() => onEdit(data.student)} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12.5, fontWeight: 600, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>✏ Edit</button>}
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text2)", fontSize: 14 }}
              onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; e.currentTarget.style.borderColor = "var(--red-border)"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--text2)"; e.currentTarget.style.borderColor = "var(--border)"; }}>×</button>
          </div>
        </div>

        <div style={{ overflowY: "auto", flex: 1, WebkitOverflowScrolling: "touch" }}>
          {loading ? (
            <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--text3)", fontSize: 13 }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid var(--border)", borderTop: "2px solid var(--green)", animation: "spin .7s linear infinite", margin: "0 auto 12px" }} />
              Loading profile…
            </div>
          ) : error ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--red)", fontSize: 13 }}>{error}</div>
          ) : data && (
            <div style={{ padding: 20 }}>
              {/* Summary card */}
              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <Avatar name={data.student.name} size={48} />
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>{data.student.name}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text3)" }}>
                      {data.student.cls} &nbsp;·&nbsp; {data.student.adm}
                      {data.student.phone && <> &nbsp;·&nbsp; {data.student.phone}</>}
                    </div>
                  </div>
                </div>

                {data.allTermsCleared ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
                    <span>✅</span>
                    <span style={{ fontSize: 12.5, color: "var(--green)", fontWeight: 600 }}>All terms paid — no outstanding balance</span>
                  </div>
                ) : data.hasUnpaidPastTerm ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
                    <span>⚠️</span>
                    <span style={{ fontSize: 12.5, color: "var(--red)", fontWeight: 600 }}>Has unpaid balance from a previous term</span>
                  </div>
                ) : null}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                  {[
                    { label: "Term Fee",  value: `KES ${Number(data.student.fee).toLocaleString()}`,  color: "var(--text)" },
                    { label: "Paid",      value: `KES ${Number(data.student.paid).toLocaleString()}`, color: "var(--green)" },
                    { label: "Balance",   value: data.student.paid >= data.student.fee ? "Cleared" : `KES ${(data.student.fee - data.student.paid).toLocaleString()}`, color: data.student.paid >= data.student.fee ? "var(--green)" : "var(--red)" },
                  ].map(s => (
                    <div key={s.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: s.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.5px" }}>{s.value}</div>
                      <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 3, textTransform: "uppercase", letterSpacing: ".6px" }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                <ProgressBar fee={data.student.fee} paid={data.student.paid} height={6} />
                <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 5 }}>
                  {Math.round(Math.min(100, data.student.fee > 0 ? (data.student.paid / data.student.fee) * 100 : 0))}% of this term's fee paid
                  {data.student.daysOverdue > 0 && <span style={{ marginLeft: 10, color: "var(--red)" }}>· {data.student.daysOverdue} days overdue</span>}
                </div>
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 10 }}>Payment History</div>

              {data.termSummaries.length === 0 ? (
                <div style={{ textAlign: "center", padding: "24px 0", color: "var(--text3)", fontSize: 13 }}>No payments recorded yet.</div>
              ) : data.termSummaries.map(term => (
                <div key={term.termId} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{term.termName}</span>
                      {term.status === "active" && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "var(--green-bg)", color: "var(--green)", border: "1px solid var(--green-border)" }}>ACTIVE</span>}
                    </div>
                    {term.cleared
                      ? <span style={{ fontSize: 11, fontWeight: 600, color: "var(--green)", background: "var(--green-bg)", border: "1px solid var(--green-border)", padding: "2px 8px", borderRadius: 20 }}>✓ Cleared</span>
                      : <span style={{ fontSize: 11, fontWeight: 600, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", padding: "2px 8px", borderRadius: 20 }}>Balance owed</span>
                    }
                  </div>
                  <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    {term.payments.length === 0
                      ? <div style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--text3)" }}>No payments this term.</div>
                      : term.payments.map((p, i) => (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: i < term.payments.length - 1 ? "1px solid var(--border)" : "none" }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)", flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>{p.time}</div>
                            <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ color: methodColor[p.method] || "var(--text3)" }}>{methodLabel[p.method] || p.method}</span>
                              {p.txnRef && <span style={{ fontFamily: "monospace", fontSize: 10.5, background: "var(--surface3)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", color: "var(--text3)" }}>{p.txnRef}</span>}
                              {p.feeBreakdown?.map((fb, fi) => <span key={fi} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--surface3)", border: "1px solid var(--border)", color: "var(--text3)" }}>{fb.typeName}</span>)}
                            </div>
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--green)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>+KES {Number(p.amount).toLocaleString()}</div>
                        </div>
                      ))
                    }
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 16px", background: "rgba(0,0,0,0.15)", borderTop: "1px solid var(--border)" }}>
                      <span style={{ fontSize: 12, color: "var(--text3)" }}>Total paid this term</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>KES {Number(term.paid).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </>
  );
}

// ─── Fee Type Selector ────────────────────────────────────────────────────────
function FeeTypeSelector({ feeTypes, selectedIds, onToggle, className, feeMatrix, onFeeChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {feeTypes.map(ft => {
        const isSelected = selectedIds.includes(ft.id);
        const amount     = feeMatrix?.[className]?.[ft.id] || 0;
        return (
          <div key={ft.id} style={{ display: "flex", alignItems: "center", gap: 10, background: isSelected ? "var(--green-bg)" : "var(--surface2)", border: `1px solid ${isSelected ? "var(--green-border)" : "var(--border)"}`, borderRadius: 9, padding: "10px 14px", transition: "all .15s" }}>
            <div onClick={() => onToggle(ft.id)} style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, border: `2px solid ${isSelected ? "var(--green)" : "var(--text3)"}`, background: isSelected ? "var(--green)" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}>
              {isSelected && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#0b1a14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            <span onClick={() => onToggle(ft.id)} style={{ flex: 1, fontSize: 13.5, color: isSelected ? "var(--text)" : "var(--text2)", fontWeight: isSelected ? 500 : 400, cursor: "pointer" }}>{ft.name}</span>
            {isSelected
              ? <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 11.5, color: "var(--text3)" }}>KES</span><input type="number" min="0" value={amount || ""} onChange={e => onFeeChange(ft.id, e.target.value)} placeholder="0" style={{ width: 90, padding: "5px 8px", textAlign: "right", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 6, color: "var(--text)", fontSize: 13, fontFamily: "inherit", outline: "none" }} /></div>
              : amount > 0 && <span style={{ fontSize: 12, color: "var(--text3)", fontVariantNumeric: "tabular-nums" }}>KES {amount.toLocaleString()}</span>
            }
          </div>
        );
      })}
    </div>
  );
}

// ─── Add Student Modal ─────────────────────────────────────────────────────────
function AddStudentModal({ onClose }) {
  const { token } = useAuth();
  const { classes, feeTypes, feeMatrix } = useFeeStructure();
  const addStudent = useAppStore(s => s.addStudent);
  const refreshStats = useAppStore(s => s.refreshStats);

  const [step, setStep]     = useState(1);
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState("");
  const [errors, setErrors] = useState({});
  const [form, setForm]     = useState({ name: "", adm: "", cls: "", phone: "", selectedFeeTypes: [], paidAmount: "", othersLabel: "" });
  const [localFees, setLocalFees] = useState({});

  const setFv = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setF  = k => v => setForm(f => ({ ...f, [k]: v }));

  // Auto-populate fees when class changes
  const [lastCls, setLastCls] = useState("");
  if (form.cls !== lastCls) {
    setLastCls(form.cls);
    if (form.cls) {
      const fees = {};
      feeTypes.forEach(ft => { fees[ft.id] = feeMatrix?.[form.cls]?.[ft.id] || 0; });
      setLocalFees(fees);
      const preselect = feeTypes.filter(ft => fees[ft.id] > 0).map(ft => ft.id);
      setForm(f => ({ ...f, selectedFeeTypes: preselect }));
    }
  }

  const handleFeeChange     = (id, val) => setLocalFees(prev => ({ ...prev, [id]: Number(val) || 0 }));
  const handleToggleFeeType = id => setForm(f => ({ ...f, selectedFeeTypes: f.selectedFeeTypes.includes(id) ? f.selectedFeeTypes.filter(x => x !== id) : [...f.selectedFeeTypes, id] }));

  const totalDue       = form.selectedFeeTypes.reduce((s, id) => s + (localFees[id] || 0), 0);
  const paidNum        = parseFloat(form.paidAmount) || 0;
  const balance        = totalDue - paidNum;
  const status         = computeStatus(totalDue, paidNum);
  const selectedOthers = form.selectedFeeTypes.includes("others");

  const inp = { width: "100%", height: 42, padding: "0 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };
  const statusColors = { paid: "var(--green)", partial: "var(--amber)", overdue: "var(--red)" };
  const statusLabels = { paid: "Paid in full", partial: "Partial payment", overdue: "No payment" };

  const validate = () => {
    const e = {};
    if (!form.name.trim())                           e.name   = "Required";
    if (!form.adm.trim())                            e.adm    = "Required";
    if (!form.cls)                                   e.cls    = "Select a class";
    if (form.selectedFeeTypes.length === 0)          e.fees   = "Select at least one fee type";
    if (totalDue <= 0)                               e.fees   = "Total fee must be > 0";
    if (paidNum < 0)                                 e.paid   = "Cannot be negative";
    if (paidNum > totalDue)                          e.paid   = "Exceeds total fee";
    if (selectedOthers && !form.othersLabel.trim())  e.others = "Specify the 'Others' description";
    return e;
  };

  const handleNext = () => { const e = validate(); if (Object.keys(e).length) { setErrors(e); return; } setErrors({}); setStep(2); };

  const handleSubmit = async () => {
    setSaving(true); setApiError("");
    try {
      const feeBreakdown = form.selectedFeeTypes.map(id => ({ typeId: id, typeName: id === "others" ? form.othersLabel : feeTypes.find(ft => ft.id === id)?.name || id, amount: localFees[id] || 0 }));
      const res = await axios.post(`${API}/api/students`,
        { name: form.name.trim(), adm: form.adm.trim(), cls: form.cls, phone: form.phone.trim(), fee: totalDue, paid: paidNum, feeBreakdown, status },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      addStudent(res.data);
      refreshStats(token);
      onClose();
    } catch (e) {
      setApiError(e.response?.data?.message || "Failed to save student.");
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-box" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{step === 1 ? "Add new student" : "Confirm & save"}</div>
            <div className="modal-sub">{step === 1 ? "Enter student info and fee details" : "Review before saving"}</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 22px", flexShrink: 0 }}>
          {["Student Info & Fees", "Review & Save"].map((label, i) => (
            <div key={i} onClick={() => i + 1 < step && setStep(i + 1)} style={{ padding: "10px 0", marginRight: 20, fontSize: 12, fontWeight: 500, color: step === i + 1 ? "var(--accent)" : "var(--text3)", borderBottom: `2px solid ${step === i + 1 ? "var(--accent)" : "transparent"}`, cursor: i + 1 < step ? "pointer" : "default", transition: "all .15s", minHeight: 40, display: "flex", alignItems: "center" }}>
              {label}
            </div>
          ))}
        </div>

        <div style={{ padding: "20px 22px", overflowY: "auto", maxHeight: "60vh", WebkitOverflowScrolling: "touch" }}>
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="field-group">
                <label className="settings-label">Student full name *</label>
                <input style={inp} value={form.name} onChange={setFv("name")} placeholder="e.g. Amina Wanjiru" autoComplete="off" />
                {errors.name && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.name}</div>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field-group">
                  <label className="settings-label">Admission number *</label>
                  <input style={inp} value={form.adm} onChange={setFv("adm")} placeholder="ADM/2025/001" autoComplete="off" />
                  {errors.adm && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.adm}</div>}
                </div>
                <div className="field-group">
                  <label className="settings-label">Phone (optional)</label>
                  <input style={inp} value={form.phone} onChange={setFv("phone")} placeholder="07XX XXX XXX" />
                </div>
              </div>
              <div className="field-group">
                <label className="settings-label">Class *</label>
                <select style={{ ...inp, cursor: "pointer" }} value={form.cls} onChange={e => setF("cls")(e.target.value)}>
                  <option value="">Select class…</option>
                  {classes.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {errors.cls && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.cls}</div>}
              </div>

              {form.cls && (
                <>
                  <div>
                    <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>Fee types * <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 400, textTransform: "none" }}>auto-filled from fee structure</span></label>
                    <FeeTypeSelector feeTypes={feeTypes} selectedIds={form.selectedFeeTypes} onToggle={handleToggleFeeType} className={form.cls} feeMatrix={{ [form.cls]: localFees }} onFeeChange={handleFeeChange} />
                    {errors.fees && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 6 }}>{errors.fees}</div>}
                  </div>
                  {selectedOthers && (
                    <div className="field-group" style={{ background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 9, padding: "12px 14px" }}>
                      <label className="settings-label">Specify "Others" fee description *</label>
                      <input style={inp} value={form.othersLabel} onChange={setFv("othersLabel")} placeholder="e.g. Exam registration…" />
                      {errors.others && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.others}</div>}
                    </div>
                  )}
                  {form.selectedFeeTypes.length > 0 && (
                    <div style={{ background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 11.5, color: "var(--text3)", marginBottom: 2 }}>Total fee due</div>
                        <div style={{ fontSize: 20, fontFamily: "'DM Serif Display',serif", color: "var(--green)", lineHeight: 1 }}>KES {totalDue.toLocaleString()}</div>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text3)" }}>{form.selectedFeeTypes.length} fee type{form.selectedFeeTypes.length !== 1 ? "s" : ""}</div>
                    </div>
                  )}
                  <div className="field-group">
                    <label className="settings-label">Amount already paid <span style={{ fontWeight: 400, textTransform: "none" }}>(leave 0 if none)</span></label>
                    <div style={{ position: "relative" }}>
                      <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text3)", pointerEvents: "none" }}>KES</span>
                      <input type="number" min="0" max={totalDue} style={{ ...inp, paddingLeft: 44 }} value={form.paidAmount} onChange={setFv("paidAmount")} placeholder="0" />
                    </div>
                    {errors.paid && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.paid}</div>}
                    {totalDue > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColors[status] }} />
                        <span style={{ fontSize: 12, color: statusColors[status], fontWeight: 500 }}>{statusLabels[status]}</span>
                        {balance > 0 && <span style={{ fontSize: 12, color: "var(--text3)" }}>· KES {balance.toLocaleString()} balance</span>}
                      </div>
                    )}
                  </div>
                </>
              )}
              {!form.cls && <div style={{ fontSize: 13, color: "var(--text3)", textAlign: "center", padding: "16px 0", borderTop: "1px solid var(--border)" }}>Select a class to configure fees</div>}
            </div>
          )}

          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--surface2)", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
                {[["Name", form.name], ["Adm No.", form.adm], ["Class", form.cls], form.phone ? ["Phone", form.phone] : null].filter(Boolean).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 12.5, color: "var(--text3)" }}>{k}</span>
                    <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ background: "var(--surface2)", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
                <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: 11.5, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8 }}>Fee Breakdown</div>
                {form.selectedFeeTypes.map(id => {
                  const ft = feeTypes.find(f => f.id === id);
                  const name = id === "others" ? form.othersLabel : ft?.name || id;
                  return (
                    <div key={id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 14px", borderBottom: "1px solid var(--border)" }}>
                      <span style={{ fontSize: 13, color: "var(--text2)" }}>{name}</span>
                      <span style={{ fontSize: 13, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>KES {(localFees[id] || 0).toLocaleString()}</span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "var(--green-bg)" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Total Due</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>KES {totalDue.toLocaleString()}</span>
                </div>
              </div>
              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 3 }}>Paid / Balance</div>
                  <div style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                    <span style={{ color: "var(--green)", fontWeight: 600 }}>KES {paidNum.toLocaleString()}</span>
                    <span style={{ color: "var(--text3)" }}> / KES {Math.max(0, balance).toLocaleString()}</span>
                  </div>
                </div>
                <div style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: status === "paid" ? "var(--green-bg)" : status === "partial" ? "var(--amber-bg)" : "var(--red-bg)", color: statusColors[status], border: `1px solid ${status === "paid" ? "var(--green-border)" : status === "partial" ? "var(--amber-border)" : "var(--red-border)"}` }}>
                  {statusLabels[status]}
                </div>
              </div>
              {apiError && <div style={{ fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "10px 14px" }}>✕ {apiError}</div>}
            </div>
          )}
        </div>

        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10 }}>
          <button onClick={() => step > 1 ? setStep(1) : onClose()} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
            {step > 1 ? "← Back" : "Cancel"}
          </button>
          {step === 1
            ? <button onClick={handleNext} disabled={!form.cls} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: form.cls ? "var(--accent)" : "var(--surface2)", border: "none", color: form.cls ? "#0b1a14" : "var(--text3)", cursor: form.cls ? "pointer" : "not-allowed", fontFamily: "inherit" }}>Review →</button>
            : <button onClick={handleSubmit} disabled={saving} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: saving ? "var(--surface2)" : "var(--accent)", border: "none", color: saving ? "var(--text3)" : "#0b1a14", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit" }}>{saving ? "Saving…" : "Save Student ✓"}</button>
          }
        </div>
      </div>
    </>
  );
}

// ─── Student Card (mobile) ─────────────────────────────────────────────────────
function StudentCard({ s, onClick }) {
  const status  = computeStatus(s.fee, s.paid);
  const balance = s.fee - s.paid;
  return (
    <div onClick={onClick} style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", cursor: "pointer", transition: "background .1s" }}
      onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <Avatar name={s.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{s.name}</span>
            <Badge status={status} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{s.cls} · {s.adm || "—"}</div>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <ProgressBar fee={s.fee} paid={s.paid} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
          <span style={{ color: "var(--text3)" }}>Paid: <span style={{ color: "var(--green)", fontWeight: 600 }}>KES {s.paid.toLocaleString()}</span></span>
          {balance > 0 && <span style={{ color: "var(--amber)" }}>Bal: KES {balance.toLocaleString()}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Students Page ─────────────────────────────────────────────────────────────
export default function Students() {
  const { token }       = useAuth();
  const { openSidebar } = useOutletContext();
  const { classes }     = useFeeStructure();

  const students        = useAppStore(s => s.students);
  const studentsLoaded  = useAppStore(s => s.studentsLoaded);

  const [showModal,  setShowModal]  = useState(false);
  const [profileId,  setProfileId]  = useState(null);
  const [editTarget, setEditTarget] = useState(null); // student object to edit
  const [search,     setSearch]     = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterClass,  setFilterClass]  = useState("all");
  const [mobileView, setMobileView] = useState(window.innerWidth < 700);
  const [toast, setToast]           = useState(null);

  // resize listener only — no data fetch
  useState(() => {
    const onResize = () => setMobileView(window.innerWidth < 700);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const studentsWithStatus = useMemo(() => students.map(s => ({ ...s, _status: computeStatus(s.fee, s.paid) })), [students]);
  const filtered = useMemo(() => studentsWithStatus.filter(s =>
    (search === "" || s.name.toLowerCase().includes(search.toLowerCase()) || s.cls.toLowerCase().includes(search.toLowerCase()) || (s.adm || "").toLowerCase().includes(search.toLowerCase())) &&
    (filterStatus === "all" || s._status === filterStatus) &&
    (filterClass  === "all" || s.cls === filterClass)
  ), [studentsWithStatus, search, filterStatus, filterClass]);

  const counts = useMemo(() => ({
    total:   studentsWithStatus.length,
    paid:    studentsWithStatus.filter(s => s._status === "paid").length,
    partial: studentsWithStatus.filter(s => s._status === "partial").length,
    overdue: studentsWithStatus.filter(s => s._status === "overdue").length,
  }), [studentsWithStatus]);

  const allClasses = useMemo(() => [...new Set([...classes, ...students.map(s => s.cls)])].filter(Boolean).sort(), [students, classes]);

  const openProfile = (s) => setProfileId(s.id);
  const openEdit    = (s) => { setProfileId(null); setEditTarget(s); };

  return (
    <>
      <Topbar title="Students" sub={`${students.length} enrolled`} onMenuClick={openSidebar}>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Student</button>
      </Topbar>

      <div className="page-content">
        {/* Stat pills */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          {[
            { label: "All",     value: counts.total,   key: "all",     color: "var(--text)" },
            { label: "Paid",    value: counts.paid,    key: "paid",    color: "var(--green)" },
            { label: "Partial", value: counts.partial, key: "partial", color: "var(--amber)" },
            { label: "Overdue", value: counts.overdue, key: "overdue", color: "var(--red)" },
          ].map(s => (
            <div key={s.key} onClick={() => setFilterStatus(s.key)} style={{ background: filterStatus === s.key ? "var(--surface2)" : "var(--surface)", border: `1px solid ${filterStatus === s.key ? "var(--surface3)" : "var(--border)"}`, borderTop: `${filterStatus === s.key ? "2px" : "1px"} solid ${filterStatus === s.key ? s.color : "var(--border)"}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", minWidth: 80, flex: "1 1 80px", maxWidth: 140 }}>
              <div style={{ fontSize: 20, fontFamily: "'DM Serif Display',serif", color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 4, textTransform: "uppercase", letterSpacing: .8 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
            <svg style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="var(--text3)" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            <input style={{ width: "100%", paddingLeft: 36, paddingRight: 12, height: 40, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} placeholder="Search by name, class or adm…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select value={filterClass} onChange={e => setFilterClass(e.target.value)} style={{ height: 40, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 9, padding: "0 12px", fontSize: 14, minWidth: 130, fontFamily: "inherit" }}>
            <option value="all">All classes</option>
            {allClasses.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div style={{ fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>{filtered.length} of {students.length}</div>
        </div>

        {/* Table / Cards */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          {!studentsLoaded ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading students…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500, marginBottom: 6 }}>No students match your filters</div>
              <div style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer" }} onClick={() => { setSearch(""); setFilterStatus("all"); setFilterClass("all"); }}>Clear filters</div>
            </div>
          ) : mobileView ? (
            filtered.map(s => <StudentCard key={s.id} s={s} onClick={() => openProfile(s)} />)
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>{["Student", "Adm No.", "Class", "Term Fee", "Paid", "Balance", "Progress", "Status"].map(h => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const balance = s.fee - s.paid;
                    return (
                      <tr key={s.id} onClick={() => openProfile(s)} style={{ cursor: "pointer" }}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Avatar name={s.name} />
                            <span style={{ fontWeight: 500, color: "var(--text)" }}>{s.name}</span>
                          </div>
                        </td>
                        <td>{s.adm || "—"}</td>
                        <td>{s.cls}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{s.fee.toLocaleString()}</td>
                        <td style={{ color: "var(--green)", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{s.paid.toLocaleString()}</td>
                        <td style={{ color: balance === 0 ? "var(--text3)" : "var(--amber)", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{balance === 0 ? "—" : balance.toLocaleString()}</td>
                        <td style={{ minWidth: 120 }}><ProgressBar fee={s.fee} paid={s.paid} /></td>
                        <td><Badge status={s._status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showModal && <AddStudentModal onClose={() => setShowModal(false)} />}

      {profileId && (
        <StudentProfileModal studentId={profileId} token={token} onClose={() => setProfileId(null)} onEdit={openEdit} />
      )}

      {editTarget && (
        <EditStudentModal student={editTarget} token={token} onClose={() => setEditTarget(null)} />
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `3px solid ${toast.type === "error" ? "var(--red)" : "var(--green)"}`, borderRadius: 10, padding: "12px 20px", fontSize: 13, color: "var(--text)", boxShadow: "var(--shadow)", display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap", maxWidth: "calc(100vw - 32px)", animation: "fadeUp .2s ease" }}>
          <span style={{ color: toast.type === "error" ? "var(--red)" : "var(--green)" }}>{toast.type === "error" ? "✕" : "✓"}</span>
          {toast.msg}
        </div>
      )}
    </>
  );
}