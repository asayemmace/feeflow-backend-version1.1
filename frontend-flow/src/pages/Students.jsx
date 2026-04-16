import { useState, useMemo, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

const CLASSES = [
  "Form 1A","Form 1B","Form 1C",
  "Form 2A","Form 2B","Form 2C",
  "Form 3A","Form 3B","Form 3C",
  "Form 4A","Form 4B","Form 4C",
];

const FEE_STRUCTURES = {
  "Form 1A": 22000, "Form 1B": 22000, "Form 1C": 22000,
  "Form 2A": 24000, "Form 2B": 24000, "Form 2C": 24000,
  "Form 3A": 26000, "Form 3B": 26000, "Form 3C": 26000,
  "Form 4A": 28000, "Form 4B": 28000, "Form 4C": 28000,
};

function getStatus(fee, paid) {
  if (paid >= fee) return "paid";
  if (paid > 0)    return "partial";
  return "overdue";
}

const STATUS_CONFIG = {
  paid:    { label: "Paid",    bg: "rgba(34,211,164,0.1)",  color: "#22d3a4", border: "rgba(34,211,164,0.2)"  },
  partial: { label: "Partial", bg: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "rgba(245,158,11,0.2)"  },
  overdue: { label: "Overdue", bg: "rgba(248,113,113,0.1)",color: "#f87171", border: "rgba(248,113,113,0.2)" },
};

const css = {
  bg:       "#0b0f1a",
  surface:  "#111827",
  surface2: "#1a2236",
  surface3: "#212f48",
  border:   "#1e2d47",
  accent:   "#22d3a4",
  accent2:  "#3b82f6",
  accent3:  "#f59e0b",
  text:     "#e8edf5",
  text2:    "#8a9dbf",
  text3:    "#4a5f80",
  danger:   "#f87171",
};

// ---------- sub-components ----------

function Badge({ status }) {
  const c = STATUS_CONFIG[status];
  return (
    <span style={{
      display:"inline-flex", alignItems:"center",
      padding:"3px 10px", borderRadius:20,
      fontSize:11, fontWeight:600,
      background:c.bg, color:c.color,
      border:`1px solid ${c.border}`,
    }}>{c.label}</span>
  );
}

function Avatar({ name, size=34 }) {
  const initials = name.split(" ").slice(0,2).map(w=>w[0]).join("").toUpperCase();
  const hue = (name.charCodeAt(0) * 37 + name.charCodeAt(name.length-1) * 13) % 360;
  return (
    <div style={{
      width:size, height:size, borderRadius:9,
      background:`hsl(${hue},55%,28%)`,
      border:`1px solid hsl(${hue},55%,38%)`,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:size*0.35, fontWeight:600, color:`hsl(${hue},80%,78%)`,
      flexShrink:0, letterSpacing:0.5,
    }}>{initials}</div>
  );
}

function ProgressBar({ fee, paid }) {
  const pct = fee > 0 ? Math.min(100, (paid / fee) * 100) : 0;
  const color = pct >= 100 ? css.accent : pct > 0 ? css.accent3 : css.danger;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      <div style={{
        flex:1, height:4, background:css.surface3,
        borderRadius:2, overflow:"hidden",
      }}>
        <div style={{
          width:`${pct}%`, height:"100%",
          background:color, borderRadius:2,
          transition:"width .3s ease",
        }}/>
      </div>
      <span style={{ fontSize:11, color:css.text3, minWidth:32, textAlign:"right" }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

// ---------- Add Student Modal ----------

function AddStudentModal({ onClose, onAdd }) {
  const [form, setForm] = useState({ name: "", cls: "", fee: "", paid: "", phone: "" });
  const [errors, setErrors] = useState({});
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleClassChange = (val) => {
    set("cls", val);
    if (FEE_STRUCTURES[val]) set("fee", FEE_STRUCTURES[val]);
  };

  const feeNum  = parseFloat(form.fee)  || 0;
  const paidNum = parseFloat(form.paid) || 0;
  const balance = feeNum - paidNum;
  const status  = getStatus(feeNum, paidNum);

  const validate = () => {
    const e = {};
    if (!form.name.trim())        e.name = "Student name is required";
    if (!form.cls)                e.cls  = "Please select a class";
    if (!form.fee || feeNum <= 0) e.fee  = "Enter a valid fee amount";
    if (paidNum < 0)              e.paid = "Amount paid cannot be negative";
    if (paidNum > feeNum)         e.paid = "Amount paid exceeds total fee";
    return e;
  };

  const handleNext = () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setErrors({});
    setStep(2);
  };

  const handleSubmit = async () => {
    setSaving(true);
    setApiError(null);
    try {
      const res = await axios.post(`${API}/api/students`, {
        name:  form.name.trim(),
        cls:   form.cls,
        fee:   feeNum,
        paid:  paidNum,
        phone: form.phone.trim(),
      });
      onAdd(res.data);   // res.data is the Prisma record with real DB id
      onClose();
    } catch (err) {
      setApiError(err.response?.data?.message || "Failed to save student. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = (err) => ({
    width:"100%", padding:"9px 12px",
    background: css.surface3,
    border: `1px solid ${err ? css.danger : css.border}`,
    borderRadius:8, color:css.text, fontSize:13.5,
    fontFamily:"'DM Sans', sans-serif",
    outline:"none", transition:"border-color .15s",
  });

  const labelStyle = {
    fontSize:12, fontWeight:500, color:css.text2,
    textTransform:"uppercase", letterSpacing:.8,
    marginBottom:6, display:"block",
  };

  const errorStyle = { fontSize:11.5, color:css.danger, marginTop:4 };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position:"fixed", inset:0, zIndex:40,
          background:"rgba(0,0,0,0.6)",
          backdropFilter:"blur(2px)",
          animation:"fadeIn .15s ease",
        }}
      />

      {/* Modal */}
      <div style={{
        position:"fixed", top:"50%", left:"50%", zIndex:50,
        transform:"translate(-50%,-50%)",
        width:"100%", maxWidth:520,
        background:css.surface,
        border:`1px solid ${css.border}`,
        borderRadius:16,
        boxShadow:"0 24px 60px rgba(0,0,0,0.5)",
        animation:"slideUp .2s ease",
        overflow:"hidden",
      }}>
        {/* Modal header */}
        <div style={{
          padding:"20px 24px 16px",
          borderBottom:`1px solid ${css.border}`,
          display:"flex", alignItems:"flex-start", justifyContent:"space-between",
        }}>
          <div>
            <div style={{
              fontSize:16, fontWeight:600, color:css.text,
              fontFamily:"'DM Serif Display', serif", letterSpacing:-.3,
            }}>
              {step === 1 ? "Add new student" : "Confirm student details"}
            </div>
            <div style={{ fontSize:12, color:css.text3, marginTop:3 }}>
              {step === 1 ? "Fill in student information below" : "Review before saving"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width:30, height:30, borderRadius:7,
              background:"transparent", border:`1px solid ${css.border}`,
              color:css.text2, cursor:"pointer", fontSize:16,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}
          >×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display:"flex", borderBottom:`1px solid ${css.border}`, padding:"0 24px" }}>
          {["Student info","Review & save"].map((label, i) => (
            <div key={i} style={{
              padding:"10px 0", marginRight:20,
              fontSize:12, fontWeight:500,
              color: step === i+1 ? css.accent : css.text3,
              borderBottom: step === i+1 ? `2px solid ${css.accent}` : "2px solid transparent",
              cursor: i+1 < step ? "pointer" : "default",
              transition:"all .15s",
            }} onClick={() => i+1 < step && setStep(i+1)}>
              {label}
            </div>
          ))}
        </div>

        <div style={{ padding:"22px 24px" }}>

          {step === 1 && (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

              {/* Name */}
              <div>
                <label style={labelStyle}>Student name *</label>
                <input
                  style={inputStyle(errors.name)}
                  placeholder="e.g. Amina Wanjiru"
                  value={form.name}
                  onChange={e => set("name", e.target.value)}
                  onFocus={e => e.target.style.borderColor = css.accent}
                  onBlur={e => e.target.style.borderColor = errors.name ? css.danger : css.border}
                />
                {errors.name && <div style={errorStyle}>{errors.name}</div>}
              </div>

              {/* Admission number */}
              <div>
                <label style={labelStyle}>Admission No. *</label>
                <input
                  style={inputStyle(errors.adm)}
                  placeholder="e.g. ADM/2025/001"
                  value={form.adm || ""}
                  onChange={e => set("adm", e.target.value)}
                  onFocus={e => e.target.style.borderColor = css.accent}
                  onBlur={e => e.target.style.borderColor = errors.adm ? css.danger : css.border}
                />
                {errors.adm && <div style={errorStyle}>{errors.adm}</div>}
              </div>

              {/* Class + Phone row */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <div>
                  <label style={labelStyle}>Class *</label>
                  <select
                    style={{ ...inputStyle(errors.cls), cursor:"pointer" }}
                    value={form.cls}
                    onChange={e => handleClassChange(e.target.value)}
                    onFocus={e => e.target.style.borderColor = css.accent}
                    onBlur={e => e.target.style.borderColor = errors.cls ? css.danger : css.border}
                  >
                    <option value="" disabled>Select class…</option>
                    {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {errors.cls && <div style={errorStyle}>{errors.cls}</div>}
                </div>

                <div>
                  <label style={labelStyle}>Parent phone</label>
                  <input
                    style={inputStyle(false)}
                    placeholder="0712 345 678"
                    value={form.phone}
                    onChange={e => set("phone", e.target.value)}
                    onFocus={e => e.target.style.borderColor = css.accent}
                    onBlur={e => e.target.style.borderColor = css.border}
                  />
                </div>
              </div>

              {/* Fee + Paid row */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <div>
                  <label style={labelStyle}>Term fee (KES) *</label>
                  <input
                    type="number"
                    style={inputStyle(errors.fee)}
                    placeholder="e.g. 24000"
                    value={form.fee}
                    onChange={e => set("fee", e.target.value)}
                    onFocus={e => e.target.style.borderColor = css.accent}
                    onBlur={e => e.target.style.borderColor = errors.fee ? css.danger : css.border}
                  />
                  {errors.fee && <div style={errorStyle}>{errors.fee}</div>}
                  {form.cls && FEE_STRUCTURES[form.cls] && (
                    <div style={{ fontSize:11, color:css.text3, marginTop:4 }}>
                      Auto-filled from {form.cls} fee structure
                    </div>
                  )}
                </div>

                <div>
                  <label style={labelStyle}>Amount paid (KES)</label>
                  <input
                    type="number"
                    style={inputStyle(errors.paid)}
                    placeholder="0 if not yet paid"
                    value={form.paid}
                    onChange={e => set("paid", e.target.value)}
                    onFocus={e => e.target.style.borderColor = css.accent}
                    onBlur={e => e.target.style.borderColor = errors.paid ? css.danger : css.border}
                  />
                  {errors.paid && <div style={errorStyle}>{errors.paid}</div>}
                </div>
              </div>

              {/* Live status preview */}
              {feeNum > 0 && (
                <div style={{
                  background:css.surface2, border:`1px solid ${css.border}`,
                  borderRadius:10, padding:"12px 14px",
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                }}>
                  <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                    <div style={{ fontSize:12, color:css.text3 }}>Balance outstanding</div>
                    <div style={{
                      fontSize:18, fontWeight:600,
                      fontFamily:"'DM Serif Display', serif",
                      color: balance === 0 ? css.accent : balance < feeNum ? css.accent3 : css.danger,
                    }}>
                      KES {balance.toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
                    <div style={{ fontSize:11, color:css.text3 }}>Status</div>
                    <Badge status={status} />
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              {/* Student preview card */}
              <div style={{
                background:css.surface2, border:`1px solid ${css.border}`,
                borderRadius:10, padding:"14px 16px",
                display:"flex", alignItems:"center", gap:14,
              }}>
                <Avatar name={form.name} size={44} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:15, fontWeight:600, color:css.text }}>{form.name}</div>
                  <div style={{ fontSize:12, color:css.text3, marginTop:2 }}>
                    {form.cls}
                    {form.adm  && ` · ${form.adm}`}
                    {form.phone && ` · ${form.phone}`}
                  </div>
                </div>
                <Badge status={status} />
              </div>

              {/* Fee summary */}
              <div style={{
                background:css.surface2, border:`1px solid ${css.border}`,
                borderRadius:10, overflow:"hidden",
              }}>
                {[
                  ["Term fee",    `KES ${feeNum.toLocaleString()}`],
                  ["Amount paid", `KES ${paidNum.toLocaleString()}`],
                  ["Balance",     `KES ${balance.toLocaleString()}`],
                ].map(([k,v], i) => (
                  <div key={i} style={{
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                    padding:"10px 14px",
                    borderBottom: i < 2 ? `1px solid ${css.border}` : "none",
                  }}>
                    <span style={{ fontSize:13, color:css.text2 }}>{k}</span>
                    <span style={{
                      fontSize:13, fontWeight:600,
                      color: k === "Balance" && balance > 0 ? css.accent3 : css.text,
                    }}>{v}</span>
                  </div>
                ))}
                <div style={{ padding:"10px 14px", borderTop:`1px solid ${css.border}` }}>
                  <ProgressBar fee={feeNum} paid={paidNum} />
                </div>
              </div>

              <div style={{
                fontSize:12, color:css.text3,
                background:"rgba(34,211,164,0.05)",
                border:"1px solid rgba(34,211,164,0.1)",
                borderRadius:8, padding:"10px 12px",
              }}>
                ✓ Student will be saved to the database immediately.
              </div>

              {apiError && (
                <div style={{
                  fontSize:12, color:css.danger,
                  background:"rgba(248,113,113,0.08)",
                  border:"1px solid rgba(248,113,113,0.2)",
                  borderRadius:8, padding:"10px 12px",
                }}>
                  ✕ {apiError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding:"14px 24px",
          borderTop:`1px solid ${css.border}`,
          display:"flex", alignItems:"center", justifyContent:"flex-end", gap:10,
        }}>
          {step === 2 && (
            <button onClick={() => setStep(1)} style={{
              padding:"8px 16px", borderRadius:8, fontSize:13, fontWeight:500,
              background:"transparent", border:`1px solid ${css.border}`,
              color:css.text2, cursor:"pointer", fontFamily:"'DM Sans', sans-serif",
            }}>Back</button>
          )}
          <button onClick={onClose} style={{
            padding:"8px 16px", borderRadius:8, fontSize:13, fontWeight:500,
            background:"transparent", border:`1px solid ${css.border}`,
            color:css.text2, cursor:"pointer", fontFamily:"'DM Sans', sans-serif",
          }}>Cancel</button>
          {step === 1 ? (
            <button onClick={handleNext} style={{
              padding:"8px 18px", borderRadius:8, fontSize:13, fontWeight:600,
              background:css.accent, border:"none",
              color:"#0b1a14", cursor:"pointer", fontFamily:"'DM Sans', sans-serif",
            }}>Continue →</button>
          ) : (
            <button onClick={handleSubmit} disabled={saving} style={{
              padding:"8px 18px", borderRadius:8, fontSize:13, fontWeight:600,
              background: saving ? css.surface3 : css.accent, border:"none",
              color: saving ? css.text3 : "#0b1a14",
              cursor: saving ? "not-allowed" : "pointer",
              fontFamily:"'DM Sans', sans-serif", transition:"all .15s",
            }}>{saving ? "Saving…" : "Save student"}</button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes slideUp { from{opacity:0;transform:translate(-50%,-46%)} to{opacity:1;transform:translate(-50%,-50%)} }
        select option { background: #1a2236; color: #e8edf5; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; }
      `}</style>
    </>
  );
}

// ---------- Students Page ----------

export default function StudentsPage() {
  const { token } = useAuth();
  const [students, setStudents] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [loadErr, setLoadErr]   = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [search, setSearch]       = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterClass, setFilterClass]   = useState("all");
  const [toast, setToast] = useState(null);

  // ── Load students from DB on mount ──────────────────────────────────────────
  useEffect(() => {
    const fetchStudents = async () => {
      try {
        const res = await axios.get(`${API}/api/students`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setStudents(res.data);
      } catch (err) {
        setLoadErr(err.response?.data?.message || "Failed to load students");
      } finally {
        setLoading(false);
      }
    };
    fetchStudents();
  }, [token]);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // After a student is saved, prepend to local list (no need to refetch)
  const handleAdd = (student) => {
    setStudents(prev => [student, ...prev]);
    showToast(`${student.name} added successfully`);
  };

  const filtered = useMemo(() => {
    return students.filter(s => {
      const status = getStatus(s.fee, s.paid);
      const matchSearch = s.name.toLowerCase().includes(search.toLowerCase()) ||
                          s.cls.toLowerCase().includes(search.toLowerCase());
      const matchStatus = filterStatus === "all" || status === filterStatus;
      const matchClass  = filterClass  === "all" || s.cls === filterClass;
      return matchSearch && matchStatus && matchClass;
    });
  }, [students, search, filterStatus, filterClass]);

  const stats = useMemo(() => ({
    total:   students.length,
    paid:    students.filter(s => getStatus(s.fee, s.paid) === "paid").length,
    partial: students.filter(s => getStatus(s.fee, s.paid) === "partial").length,
    overdue: students.filter(s => getStatus(s.fee, s.paid) === "overdue").length,
  }), [students]);

  const btnBase = {
    display:"inline-flex", alignItems:"center", gap:7,
    padding:"8px 14px", borderRadius:8,
    fontSize:13, fontWeight:500, cursor:"pointer",
    border:"none", fontFamily:"'DM Sans', sans-serif",
    transition:"all .15s",
  };

  return (
    <div style={{
      background:css.bg, minHeight:"100vh",
      fontFamily:"'DM Sans', sans-serif",
      padding:"0 32px 48px",
    }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
        * { box-sizing: border-box; }
        ::placeholder { color: #4a5f80; }
        input, select { color-scheme: dark; }
      `}</style>

      {/* Topbar */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"20px 0 24px",
        borderBottom:`1px solid ${css.border}`,
        marginBottom:28,
        position:"sticky", top:0, background:css.bg, zIndex:10,
      }}>
        <div>
          <h1 style={{
            fontFamily:"'DM Serif Display', serif",
            fontSize:26, fontWeight:400, color:css.text, letterSpacing:-.5, margin:0,
          }}>Students</h1>
          <p style={{ color:css.text2, fontSize:13, marginTop:2 }}>
            {students.length} enrolled &nbsp;·&nbsp; Term 2, 2025
          </p>
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <button style={{ ...btnBase, background:"transparent", border:`1px solid ${css.border}`, color:css.text2 }}>
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
            Export
          </button>
          <button
            onClick={() => setShowModal(true)}
            style={{ ...btnBase, background:css.accent, color:"#0b1a14", fontWeight:600 }}
          >
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            Add Student
          </button>
        </div>
      </div>

      {/* Stat pills */}
      <div style={{ display:"flex", gap:12, marginBottom:24, flexWrap:"wrap" }}>
        {[
          { label:"All students", value:stats.total,   key:"all",     color:css.text   },
          { label:"Fully paid",   value:stats.paid,    key:"paid",    color:css.accent  },
          { label:"Partial",      value:stats.partial, key:"partial", color:css.accent3 },
          { label:"Overdue",      value:stats.overdue, key:"overdue", color:css.danger  },
        ].map(s => (
          <div
            key={s.key}
            onClick={() => setFilterStatus(s.key)}
            style={{
              background: filterStatus === s.key ? css.surface2 : css.surface,
              border:`1px solid ${filterStatus === s.key ? css.surface3 : css.border}`,
              borderRadius:10, padding:"10px 16px", cursor:"pointer",
              transition:"all .15s", minWidth:110,
              borderTop: filterStatus === s.key ? `2px solid ${s.color}` : `1px solid ${css.border}`,
            }}
          >
            <div style={{ fontSize:20, fontFamily:"'DM Serif Display', serif", color:s.color, lineHeight:1 }}>
              {s.value}
            </div>
            <div style={{ fontSize:11, color:css.text3, marginTop:4, textTransform:"uppercase", letterSpacing:.8 }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Filters row */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <div style={{ position:"relative", flex:"1 1 200px", maxWidth:280 }}>
          <svg style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", pointerEvents:"none" }}
            width="14" height="14" fill="none" viewBox="0 0 24 24" stroke={css.text3} strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input
            style={{
              width:"100%", paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
              background:css.surface, border:`1px solid ${css.border}`,
              borderRadius:8, color:css.text, fontSize:13, outline:"none",
            }}
            placeholder="Search students…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <select
          style={{
            padding:"8px 12px", background:css.surface, border:`1px solid ${css.border}`,
            borderRadius:8, color: filterClass === "all" ? css.text2 : css.text,
            fontSize:13, outline:"none", cursor:"pointer",
          }}
          value={filterClass}
          onChange={e => setFilterClass(e.target.value)}
        >
          <option value="all">All classes</option>
          {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <div style={{ marginLeft:"auto", fontSize:12, color:css.text3 }}>
          Showing {filtered.length} of {students.length}
        </div>
      </div>

      {/* Table */}
      <div style={{
        background:css.surface, border:`1px solid ${css.border}`,
        borderRadius:12, overflow:"hidden",
      }}>
        {loading ? (
          <div style={{ padding:"48px 16px", textAlign:"center", color:css.text3, fontSize:13 }}>
            Loading students…
          </div>
        ) : loadErr ? (
          <div style={{ padding:"48px 16px", textAlign:"center", color:css.danger, fontSize:13 }}>
            {loadErr}
          </div>
        ) : (
          <table style={{ width:"100%", borderCollapse:"collapse" }}>
            <thead>
              <tr style={{ background:css.surface2, borderBottom:`1px solid ${css.border}` }}>
                {["Student","Adm No.","Class","Term Fee","Paid","Balance","Progress","Status"].map(h => (
                  <th key={h} style={{
                    padding:"10px 16px", textAlign:"left",
                    fontSize:11, textTransform:"uppercase", letterSpacing:.8,
                    color:css.text3, fontWeight:600,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding:"48px 16px", textAlign:"center", color:css.text3, fontSize:13 }}>
                    No students match your filters
                  </td>
                </tr>
              ) : filtered.map((s, i) => {
                const status  = getStatus(s.fee, s.paid);
                const balance = s.fee - s.paid;
                return (
                  <tr
                    key={s.id}
                    style={{
                      borderBottom: i < filtered.length - 1 ? `1px solid ${css.border}` : "none",
                      transition:"background .1s", cursor:"pointer",
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = css.surface2}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  >
                    <td style={{ padding:"12px 16px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <Avatar name={s.name} size={32} />
                        <span style={{ fontSize:13, fontWeight:500, color:css.text }}>{s.name}</span>
                      </div>
                    </td>
                    <td style={{ padding:"12px 16px", fontSize:13, color:css.text2 }}>{s.adm || "—"}</td>
                    <td style={{ padding:"12px 16px", fontSize:13, color:css.text2 }}>{s.cls}</td>
                    <td style={{ padding:"12px 16px", fontSize:13, color:css.text, fontVariantNumeric:"tabular-nums" }}>
                      {s.fee.toLocaleString()}
                    </td>
                    <td style={{ padding:"12px 16px", fontSize:13, color:css.accent, fontVariantNumeric:"tabular-nums", fontWeight:500 }}>
                      {s.paid.toLocaleString()}
                    </td>
                    <td style={{ padding:"12px 16px", fontSize:13,
                      color: balance === 0 ? css.text3 : css.accent3,
                      fontVariantNumeric:"tabular-nums", fontWeight:500,
                    }}>
                      {balance === 0 ? "—" : balance.toLocaleString()}
                    </td>
                    <td style={{ padding:"12px 16px", minWidth:120 }}>
                      <ProgressBar fee={s.fee} paid={s.paid} />
                    </td>
                    <td style={{ padding:"12px 16px" }}>
                      <Badge status={status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <AddStudentModal
          onClose={() => setShowModal(false)}
          onAdd={handleAdd}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position:"fixed", bottom:28, right:28, zIndex:100,
          background:css.surface, border:`1px solid ${css.border}`,
          borderLeft:`3px solid ${toast.type === "error" ? css.danger : css.accent}`,
          borderRadius:10, padding:"12px 18px",
          fontSize:13, color:css.text,
          boxShadow:"0 8px 24px rgba(0,0,0,0.4)",
          animation:"slideUp .2s ease",
          display:"flex", alignItems:"center", gap:10,
        }}>
          <span style={{ color: toast.type === "error" ? css.danger : css.accent, fontSize:16 }}>
            {toast.type === "error" ? "✕" : "✓"}
          </span>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
