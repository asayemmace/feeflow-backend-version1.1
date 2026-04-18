import { useState, useMemo, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/Topbar";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

const CLASSES = [
  "Form 1A","Form 1B","Form 1C",
  "Form 2A","Form 2B","Form 2C",
  "Form 3A","Form 3B","Form 3C",
  "Form 4A","Form 4B","Form 4C",
];
const FEE_STRUCTURES = {
  "Form 1A":22000,"Form 1B":22000,"Form 1C":22000,
  "Form 2A":24000,"Form 2B":24000,"Form 2C":24000,
  "Form 3A":26000,"Form 3B":26000,"Form 3C":26000,
  "Form 4A":28000,"Form 4B":28000,"Form 4C":28000,
};

function getStatus(fee, paid) {
  if (paid >= fee) return "paid";
  if (paid > 0)   return "partial";
  return "overdue";
}

function Badge({ status }) {
  const cls = { paid: "badge-paid", partial: "badge-partial", overdue: "badge-overdue" };
  const lbl = { paid: "Paid", partial: "Partial", overdue: "Overdue" };
  return <span className={cls[status]}>{lbl[status]}</span>;
}

function Avatar({ name, size = 32 }) {
  const initials = name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const hue = (name.charCodeAt(0) * 37 + name.charCodeAt(name.length - 1) * 13) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: 8,
      background: `hsl(${hue},55%,28%)`, border: `1px solid hsl(${hue},55%,38%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 600, color: `hsl(${hue},80%,78%)`,
      flexShrink: 0, letterSpacing: 0.5,
    }}>
      {initials}
    </div>
  );
}

function ProgressBar({ fee, paid }) {
  const pct = fee > 0 ? Math.min(100, (paid / fee) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: "var(--surface3)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", borderRadius: 2, transition: "width .3s",
          background: pct >= 100 ? "var(--accent)" : pct > 0 ? "var(--accent3)" : "var(--danger)",
        }} />
      </div>
      <span style={{ fontSize: 11, color: "var(--text3)", minWidth: 32, textAlign: "right" }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

// ─── Add Student Modal ─────────────────────────────────────────────────────────
function AddStudentModal({ onClose, onAdd }) {
  const { token } = useAuth();
  const [form, setForm]     = useState({ name: "", adm: "", cls: "", phone: "", fee: "", paid: "" });
  const [errors, setErrors] = useState({});
  const [step, setStep]     = useState(1);
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState("");

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const inp = {
    width: "100%", height: 42, padding: "0 12px",
    background: "var(--input-bg)", border: "1px solid var(--input-border)",
    borderRadius: 8, color: "var(--text)", fontSize: 14,
    outline: "none", boxSizing: "border-box", fontFamily: "inherit",
  };

  const handleClassChange = val => {
    setForm(f => ({ ...f, cls: val, ...(FEE_STRUCTURES[val] ? { fee: FEE_STRUCTURES[val].toString() } : {}) }));
  };

  const feeNum  = parseFloat(form.fee)  || 0;
  const paidNum = parseFloat(form.paid) || 0;
  const balance = feeNum - paidNum;
  const status  = getStatus(feeNum, paidNum);

  const validate = () => {
    const e = {};
    if (!form.name.trim())        e.name = "Student name is required";
    if (!form.adm.trim())         e.adm  = "Admission number is required";
    if (!form.cls)                e.cls  = "Select a class";
    if (!form.fee || feeNum <= 0) e.fee  = "Enter a valid fee amount";
    if (paidNum < 0)              e.paid = "Cannot be negative";
    if (paidNum > feeNum)         e.paid = "Exceeds total fee";
    return e;
  };

  const handleNext = () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setErrors({}); setStep(2);
  };

  const handleSubmit = async () => {
    setSaving(true); setApiError("");
    try {
      const res = await axios.post(`${API}/api/students`, {
        name: form.name.trim(), adm: form.adm.trim(),
        cls: form.cls, fee: feeNum, paid: paidNum,
        phone: form.phone.trim(),
      }, { headers: { Authorization: `Bearer ${token}` } });
      onAdd(res.data);
      onClose();
    } catch (e) {
      setApiError(e.response?.data?.message || "Failed to save student.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-box">
        <div className="modal-header">
          <div>
            <div className="modal-title">{step === 1 ? "Add new student" : "Confirm student details"}</div>
            <div className="modal-sub">{step === 1 ? "Fill in student information" : "Review before saving"}</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 22px", flexShrink: 0 }}>
          {["Student info", "Review & save"].map((label, i) => (
            <div
              key={i}
              onClick={() => i + 1 < step && setStep(i + 1)}
              style={{
                padding: "10px 0", marginRight: 20, fontSize: 12, fontWeight: 500,
                color: step === i + 1 ? "var(--accent)" : "var(--text3)",
                borderBottom: `2px solid ${step === i + 1 ? "var(--accent)" : "transparent"}`,
                cursor: i + 1 < step ? "pointer" : "default",
                transition: "all .15s", minHeight: 40, display: "flex", alignItems: "center",
              }}
            >
              {label}
            </div>
          ))}
        </div>

        <div style={{ padding: "20px 22px", overflowY: "auto", maxHeight: "55vh", WebkitOverflowScrolling: "touch" }}>
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="field-group">
                <label className="settings-label">Student name *</label>
                <input style={inp} value={form.name} onChange={set("name")} placeholder="e.g. Amina Wanjiru" autoComplete="off" />
                {errors.name && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.name}</div>}
              </div>
              <div className="field-group">
                <label className="settings-label">Admission number *</label>
                <input style={inp} value={form.adm} onChange={set("adm")} placeholder="e.g. ADM/2025/001" autoComplete="off" />
                {errors.adm && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.adm}</div>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field-group">
                  <label className="settings-label">Class *</label>
                  <select style={inp} value={form.cls} onChange={e => handleClassChange(e.target.value)}>
                    <option value="" disabled>Select class…</option>
                    {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {errors.cls && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.cls}</div>}
                </div>
                <div className="field-group">
                  <label className="settings-label">Parent phone</label>
                  <input style={inp} type="tel" inputMode="tel" value={form.phone} onChange={set("phone")} placeholder="07XX XXX XXX" />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field-group">
                  <label className="settings-label">Term fee (KES) *</label>
                  <input style={inp} type="number" inputMode="numeric" value={form.fee} onChange={set("fee")} placeholder="e.g. 24000" />
                  {errors.fee && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.fee}</div>}
                  {form.cls && FEE_STRUCTURES[form.cls] && (
                    <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>Auto-filled from {form.cls}</div>
                  )}
                </div>
                <div className="field-group">
                  <label className="settings-label">Amount paid (KES)</label>
                  <input style={inp} type="number" inputMode="numeric" value={form.paid} onChange={set("paid")} placeholder="0 if unpaid" />
                  {errors.paid && <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 4 }}>{errors.paid}</div>}
                </div>
              </div>
              {feeNum > 0 && (
                <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "11px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text3)" }}>Balance outstanding</div>
                    <div style={{ fontSize: 18, fontWeight: 600, fontFamily: "'DM Serif Display',serif", color: balance === 0 ? "var(--accent)" : balance < feeNum ? "var(--accent3)" : "var(--danger)" }}>
                      KES {balance.toLocaleString()}
                    </div>
                  </div>
                  <Badge status={status} />
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14 }}>
                <Avatar name={form.name} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{form.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {form.cls}{form.adm && ` · ${form.adm}`}{form.phone && ` · ${form.phone}`}
                  </div>
                </div>
                <Badge status={status} />
              </div>
              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {[["Term fee", `KES ${feeNum.toLocaleString()}`], ["Amount paid", `KES ${paidNum.toLocaleString()}`], ["Balance", `KES ${balance.toLocaleString()}`]].map(([k, v], i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: i < 2 ? "1px solid var(--border)" : "none" }}>
                    <span style={{ fontSize: 13, color: "var(--text2)" }}>{k}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: k === "Balance" && balance > 0 ? "var(--accent3)" : "var(--text)" }}>{v}</span>
                  </div>
                ))}
                <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
                  <ProgressBar fee={feeNum} paid={paidNum} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text3)", background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 8, padding: "10px 12px" }}>
                ✓ Student will be saved to the database immediately.
              </div>
              {apiError && <div className="settings-error">✕ {apiError}</div>}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {step === 2 && <button className="btn btn-outline" onClick={() => setStep(1)}>Back</button>}
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          {step === 1
            ? <button className="btn btn-primary" onClick={handleNext}>Continue →</button>
            : <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>{saving ? "Saving…" : "Save student"}</button>
          }
        </div>
      </div>
    </>
  );
}

// ─── Mobile student card (replaces table row on small screens) ─────────────────
function StudentCard({ s }) {
  const status  = getStatus(s.fee, s.paid);
  const balance = s.fee - s.paid;
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 12 }}>
      <Avatar name={s.name} size={38} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
          <Badge status={status} />
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text3)", marginBottom: 8 }}>{s.cls} · {s.adm || "—"}</div>
        <ProgressBar fee={s.fee} paid={s.paid} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
          <span style={{ color: "var(--text3)" }}>Paid: <span style={{ color: "var(--accent)", fontWeight: 600 }}>KES {s.paid.toLocaleString()}</span></span>
          {balance > 0 && <span style={{ color: "var(--accent3)", fontWeight: 600 }}>Bal: KES {balance.toLocaleString()}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Students Page ─────────────────────────────────────────────────────────────
export default function StudentsPage() {
  const { token } = useAuth();
  const { openSidebar } = useOutletContext();

  const [students, setStudents]           = useState([]);
  const [loading, setLoading]             = useState(true);
  const [loadErr, setLoadErr]             = useState("");
  const [showModal, setShowModal]         = useState(false);
  const [search, setSearch]               = useState("");
  const [filterStatus, setFilterStatus]   = useState("all");
  const [filterClass, setFilterClass]     = useState("all");
  const [toast, setToast]                 = useState(null);
  const [mobileView, setMobileView]       = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setMobileView(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    axios.get(`${API}/api/students`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setStudents(r.data))
      .catch(e => setLoadErr(e.response?.data?.message || "Failed to load students"))
      .finally(() => setLoading(false));
  }, [token]);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleAdd = student => {
    setStudents(prev => [student, ...prev]);
    showToast(`${student.name} added successfully`);
  };

  const filtered = useMemo(() => students.filter(s => {
    const st = getStatus(s.fee, s.paid);
    return (
      (search === "" ||
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.cls.toLowerCase().includes(search.toLowerCase()) ||
        (s.adm || "").toLowerCase().includes(search.toLowerCase())
      ) &&
      (filterStatus === "all" || st === filterStatus) &&
      (filterClass  === "all" || s.cls === filterClass)
    );
  }), [students, search, filterStatus, filterClass]);

  const stats = useMemo(() => ({
    total:   students.length,
    paid:    students.filter(s => getStatus(s.fee, s.paid) === "paid").length,
    partial: students.filter(s => getStatus(s.fee, s.paid) === "partial").length,
    overdue: students.filter(s => getStatus(s.fee, s.paid) === "overdue").length,
  }), [students]);

  return (
    <>
      <Topbar
        title="Students"
        sub={`${students.length} enrolled`}
        onMenuClick={openSidebar}
      >
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Student</button>
      </Topbar>

      <div className="page-content">
        {/* Stat pills */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          {[
            { label: "All",     value: stats.total,   key: "all",     color: "var(--text)" },
            { label: "Paid",    value: stats.paid,    key: "paid",    color: "var(--accent)" },
            { label: "Partial", value: stats.partial, key: "partial", color: "var(--accent3)" },
            { label: "Overdue", value: stats.overdue, key: "overdue", color: "var(--danger)" },
          ].map(s => (
            <div
              key={s.key}
              onClick={() => setFilterStatus(s.key)}
              style={{
                background: filterStatus === s.key ? "var(--surface2)" : "var(--surface)",
                border: `1px solid ${filterStatus === s.key ? "var(--surface3)" : "var(--border)"}`,
                borderTop: `${filterStatus === s.key ? "2px" : "1px"} solid ${filterStatus === s.key ? s.color : "var(--border)"}`,
                borderRadius: 10, padding: "10px 14px", cursor: "pointer",
                minWidth: 80, flex: "1 1 80px", maxWidth: 140,
              }}
            >
              <div style={{ fontSize: 20, fontFamily: "'DM Serif Display',serif", color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 4, textTransform: "uppercase", letterSpacing: .8 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
            <svg style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
              width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="var(--text3)" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
            <input
              style={{ width: "100%", paddingLeft: 36, paddingRight: 12, height: 40, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
              placeholder="Search by name, class or adm…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            value={filterClass}
            onChange={e => setFilterClass(e.target.value)}
            style={{ height: 40, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 9, padding: "0 12px", fontSize: 14, minWidth: 130, fontFamily: "inherit" }}
          >
            <option value="all">All classes</option>
            {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div style={{ fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>
            {filtered.length} of {students.length}
          </div>
        </div>

        {/* Table (desktop) / Card list (mobile) */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading students…</div>
          ) : loadErr ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--danger)", fontSize: 13 }}>{loadErr}</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500, marginBottom: 6 }}>No students match your filters</div>
              <div style={{ fontSize: 13, color: "var(--text3)", cursor: "pointer", color: "var(--accent)" }}
                onClick={() => { setSearch(""); setFilterStatus("all"); setFilterClass("all"); }}>
                Clear filters
              </div>
            </div>
          ) : mobileView ? (
            // Mobile: card list
            filtered.map(s => <StudentCard key={s.id} s={s} />)
          ) : (
            // Desktop: table
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    {["Student","Adm No.","Class","Term Fee","Paid","Balance","Progress","Status"].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const status  = getStatus(s.fee, s.paid);
                    const balance = s.fee - s.paid;
                    return (
                      <tr key={s.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Avatar name={s.name} />
                            <span style={{ fontWeight: 500, color: "var(--text)" }}>{s.name}</span>
                          </div>
                        </td>
                        <td>{s.adm || "—"}</td>
                        <td>{s.cls}</td>
                        <td style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{s.fee.toLocaleString()}</td>
                        <td style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{s.paid.toLocaleString()}</td>
                        <td style={{ color: balance === 0 ? "var(--text3)" : "var(--accent3)", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                          {balance === 0 ? "—" : balance.toLocaleString()}
                        </td>
                        <td style={{ minWidth: 120 }}><ProgressBar fee={s.fee} paid={s.paid} /></td>
                        <td><Badge status={status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showModal && <AddStudentModal onClose={() => setShowModal(false)} onAdd={handleAdd} />}

      {/* Toast notification */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          zIndex: 100, background: "var(--surface)", border: "1px solid var(--border)",
          borderLeft: `3px solid ${toast.type === "error" ? "var(--danger)" : "var(--accent)"}`,
          borderRadius: 10, padding: "12px 20px", fontSize: 13, color: "var(--text)",
          boxShadow: "var(--shadow)", display: "flex", alignItems: "center", gap: 10,
          whiteSpace: "nowrap", maxWidth: "calc(100vw - 32px)",
          animation: "fadeUp .2s ease",
        }}>
          <span style={{ color: toast.type === "error" ? "var(--danger)" : "var(--accent)" }}>
            {toast.type === "error" ? "✕" : "✓"}
          </span>
          {toast.msg}
        </div>
      )}
    </>
  );
}
