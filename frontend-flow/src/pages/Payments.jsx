import { useState, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate, useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import { useFeeStructure } from "../hooks/useFeeStructure";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

// ─── Icons ────────────────────────────────────────────────────────────────────
const SearchIcon = () => (
  <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
  </svg>
);
const PayIcon = () => (
  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/>
  </svg>
);
const QIcon = () => (
  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
  </svg>
);

const MethodBadge = ({ method }) => {
  const configs = {
    mpesa: { label: "M-Pesa", color: "var(--green)",  bg: "rgba(34,211,164,0.08)",  border: "rgba(34,211,164,0.15)" },
    bank:  { label: "Bank",   color: "var(--blue)",   bg: "rgba(59,130,246,0.08)",  border: "rgba(59,130,246,0.15)" },
    cash:  { label: "Cash",   color: "var(--amber)",  bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.15)" },
  };
  const c = configs[method?.toLowerCase()] || configs.cash;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
      background: c.bg, border: `1px solid ${c.border}`, color: c.color, flexShrink: 0,
    }}>
      {c.label}
    </span>
  );
};

const inp = {
  width: "100%", padding: "10px 12px",
  background: "var(--input-bg)", border: "1px solid var(--input-border)",
  borderRadius: 8, color: "var(--text)", fontSize: 14,
  fontFamily: "inherit", outline: "none", boxSizing: "border-box",
};

// ─── Fee Type Multi-Selector for Payment ─────────────────────────────────────
function PaymentFeeTypeSelector({ feeTypes, selectedIds, onToggle, feeAmounts, onAmountChange, studentClass, feeMatrix }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {feeTypes.map(ft => {
        const isSelected  = selectedIds.includes(ft.id);
        const suggested   = feeMatrix?.[studentClass]?.[ft.id] || 0;
        const amount      = feeAmounts[ft.id] ?? (isSelected ? suggested : "");

        return (
          <div
            key={ft.id}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              background: isSelected ? "rgba(34,211,164,0.05)" : "var(--surface3)",
              border: `1px solid ${isSelected ? "rgba(34,211,164,0.2)" : "var(--border)"}`,
              borderRadius: 8, padding: "9px 12px", transition: "all .15s",
            }}
          >
            <div
              onClick={() => onToggle(ft.id, suggested)}
              style={{
                width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                border: `2px solid ${isSelected ? "#22d3a4" : "var(--text3)"}`,
                background: isSelected ? "#22d3a4" : "transparent",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all .15s",
              }}
            >
              {isSelected && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#0b1a14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            <span
              onClick={() => onToggle(ft.id, suggested)}
              style={{ flex: 1, fontSize: 13, color: isSelected ? "var(--text)" : "var(--text2)", cursor: "pointer", fontWeight: isSelected ? 500 : 400 }}
            >
              {ft.name}
              {suggested > 0 && !isSelected && (
                <span style={{ fontSize: 11, color: "var(--text3)", marginLeft: 6 }}>
                  (KES {suggested.toLocaleString()})
                </span>
              )}
            </span>
            {isSelected && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 11, color: "var(--text3)" }}>KES</span>
                <input
                  type="number" min="0"
                  value={amount}
                  onChange={e => onAmountChange(ft.id, e.target.value)}
                  placeholder={suggested || "0"}
                  style={{
                    width: 90, padding: "5px 8px", textAlign: "right",
                    background: "var(--input-bg)", border: "1px solid var(--input-border)",
                    borderRadius: 6, color: "var(--text)", fontSize: 12.5,
                    fontFamily: "inherit", outline: "none",
                  }}
                  onClick={e => e.stopPropagation()}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Add Payment Modal ────────────────────────────────────────────────────────
function AddPaymentModal({ onClose, onAdded }) {
  const { token, canUse }    = useAuth();
  const navigate             = useNavigate();
  const { feeTypes, feeMatrix } = useFeeStructure();

  const [students, setStudents]       = useState([]);
  const [loadingStudents, setLoading] = useState(true);
  const [classFilter, setClassFilter] = useState("all");
  const [search, setSearch]           = useState("");
  const [selected, setSelected]       = useState(null);

  // Fee type selection
  const [selectedFeeTypes, setSelectedFeeTypes] = useState([]);
  const [feeAmounts, setFeeAmounts]             = useState({});
  const [othersLabel, setOthersLabel]           = useState("");

  const [form, setForm]       = useState({ phone: "", txnRef: "", method: "mpesa" });
  const [saving, setSaving]   = useState(false);
  const [stkLoading, setStkLoading] = useState(false);
  const [stkSent, setStkSent]       = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    axios.get(`${API}/api/students`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setStudents(r.data))
      .catch(() => setError("Could not load students."))
      .finally(() => setLoading(false));
  }, [token]);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const selectStudent = s => {
    setSelected(s);
    setSelectedFeeTypes([]);
    setFeeAmounts({});
    setOthersLabel("");
  };

  const handleToggleFeeType = (typeId, suggested) => {
    setSelectedFeeTypes(prev => {
      const isIn = prev.includes(typeId);
      if (isIn) {
        setFeeAmounts(fa => { const { [typeId]: _, ...rest } = fa; return rest; });
        return prev.filter(id => id !== typeId);
      } else {
        if (suggested > 0) {
          setFeeAmounts(fa => ({ ...fa, [typeId]: suggested }));
        }
        return [...prev, typeId];
      }
    });
  };

  const handleAmountChange = (typeId, val) => {
    setFeeAmounts(fa => ({ ...fa, [typeId]: Number(val) || 0 }));
  };

  // Total from selected fee types
  const totalAmount = selectedFeeTypes.reduce((sum, id) => sum + (Number(feeAmounts[id]) || 0), 0);

  const classes   = [...new Set(students.map(s => s.cls))].sort();
  const filtered  = students
    .filter(s => classFilter === "all" || s.cls === classFilter)
    .filter(s => !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.adm?.toLowerCase().includes(search.toLowerCase()));

  const balance       = selected ? Math.max(0, selected.fee - selected.paid) : 0;
  const phoneClean    = form.phone.replace(/\s/g, "");
  const phoneValid    = /^(07|01)\d{8}$/.test(phoneClean);
  const canSTK        = canUse?.("mpesa");
  const selectedOthers = selectedFeeTypes.includes("others");

  const handleSave = async () => {
    if (!selected)             return setError("Select a student.");
    if (totalAmount <= 0)      return setError("Enter a valid amount for at least one fee type.");
    if (selectedFeeTypes.length === 0) return setError("Select at least one fee type.");
    if (selectedOthers && !othersLabel.trim()) return setError("Specify the 'Others' fee description.");

    setSaving(true); setError("");
    try {
      const feeBreakdown = selectedFeeTypes.map(id => ({
        typeId: id,
        typeName: id === "others" ? othersLabel : feeTypes.find(ft => ft.id === id)?.name || id,
        amount: Number(feeAmounts[id]) || 0,
      }));
      const res = await axios.post(`${API}/api/payments`, {
        studentId: selected.id,
        amount: totalAmount,
        txnRef: form.txnRef || null,
        method: form.method,
        feeBreakdown,
      }, { headers: { Authorization: `Bearer ${token}` } });
      onAdded(res.data);
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleSTK = async () => {
    if (!phoneValid || !selected || totalAmount <= 0 || !canSTK) return;
    setStkLoading(true); setError(""); setStkSent(false);
    try {
      await axios.post(`${API}/api/payments/stk`,
        { studentId: selected.id, amount: totalAmount, phone: phoneClean },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setStkSent(true);
    } catch (e) { setError(e.response?.data?.message || "STK push failed."); }
    finally { setStkLoading(false); }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-box" style={{ maxWidth: 540 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Record Payment</div>
            <div className="modal-sub">Pick student, select fee types, then save</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 20, overflowY: "auto", maxHeight: "65vh", WebkitOverflowScrolling: "touch" }}>

          {/* ── Student picker ── */}
          <div>
            <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>Select Student</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <div style={{ position: "relative", flex: 1 }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)" }}><SearchIcon /></span>
                <input
                  style={{ ...inp, paddingLeft: 34, paddingRight: 12 }}
                  placeholder="Search by name or adm…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <select
                value={classFilter}
                onChange={e => setClassFilter(e.target.value)}
                style={{ ...inp, width: 130, padding: "10px 10px" }}
              >
                <option value="all">All classes</option>
                {classes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div style={{
              maxHeight: 200, overflowY: "auto",
              border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden",
            }}>
              {loadingStudents ? (
                <div style={{ padding: "20px", textAlign: "center", fontSize: 13, color: "var(--text3)" }}>Loading…</div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: "20px", textAlign: "center", fontSize: 13, color: "var(--text3)" }}>No students found.</div>
              ) : filtered.map(s => {
                const isSelected = selected?.id === s.id;
                const bal = Math.max(0, s.fee - s.paid);
                return (
                  <div
                    key={s.id}
                    onClick={() => selectStudent(s)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 14px", cursor: "pointer",
                      background: isSelected ? "rgba(34,211,164,0.06)" : "transparent",
                      borderBottom: "1px solid var(--border)",
                      borderLeft: `3px solid ${isSelected ? "var(--accent)" : "transparent"}`,
                      transition: "all .1s",
                    }}
                  >
                    <div style={{
                      width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                      background: "var(--surface3)", display: "flex", alignItems: "center",
                      justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--text2)",
                    }}>
                      {s.name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text3)" }}>{s.cls} · {s.adm}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {bal > 0 ? (
                        <div style={{ fontSize: 12, color: "var(--accent3)", fontWeight: 600 }}>KES {bal.toLocaleString()} due</div>
                      ) : (
                        <div style={{ fontSize: 12, color: "var(--accent)" }}>✓ Cleared</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Fee Types ── */}
          {selected && (
            <div>
              <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>
                Fee Types Being Paid
                <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 400, marginLeft: 6, textTransform: "none" }}>
                  Select one or more — amounts auto-filled from fee structure
                </span>
              </label>
              <PaymentFeeTypeSelector
                feeTypes={feeTypes}
                selectedIds={selectedFeeTypes}
                onToggle={handleToggleFeeType}
                feeAmounts={feeAmounts}
                onAmountChange={handleAmountChange}
                studentClass={selected.cls}
                feeMatrix={feeMatrix}
              />

              {/* Others label */}
              {selectedOthers && (
                <div style={{ marginTop: 10, background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 9, padding: "12px 14px" }}>
                  <label className="settings-label">Specify "Others" description *</label>
                  <input
                    style={inp}
                    value={othersLabel}
                    onChange={e => setOthersLabel(e.target.value)}
                    placeholder="e.g. Exam registration, Uniform…"
                  />
                </div>
              )}

              {/* Total */}
              {selectedFeeTypes.length > 0 && (
                <div style={{
                  marginTop: 12, background: "rgba(34,211,164,0.04)", border: "1px solid rgba(34,211,164,0.15)",
                  borderRadius: 10, padding: "12px 16px",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 2 }}>TOTAL PAYMENT</div>
                    <div style={{ fontSize: 22, fontFamily: "'DM Serif Display',serif", color: "var(--accent)", lineHeight: 1 }}>
                      KES {totalAmount.toLocaleString()}
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", textAlign: "right" }}>
                    <div>{selectedFeeTypes.length} fee type{selectedFeeTypes.length !== 1 ? "s" : ""}</div>
                    {balance > 0 && (
                      <div style={{ marginTop: 2, color: "var(--accent3)" }}>
                        {totalAmount >= balance ? "✓ Clears balance" : `KES ${(balance - totalAmount).toLocaleString()} still owed`}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Payment method ── */}
          {selected && selectedFeeTypes.length > 0 && (
            <div>
              <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>Payment Method</label>
              <div style={{ display: "flex", gap: 8 }}>
                {["mpesa", "bank", "cash"].map(m => (
                  <button
                    key={m}
                    onClick={() => setForm(f => ({ ...f, method: m }))}
                    style={{
                      flex: 1, padding: "9px 0", borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                      cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                      border: `1px solid ${form.method === m ? "var(--accent)" : "var(--border)"}`,
                      background: form.method === m ? "rgba(34,211,164,0.08)" : "var(--surface2)",
                      color: form.method === m ? "var(--accent)" : "var(--text2)",
                    }}
                  >
                    {m === "mpesa" ? "M-Pesa" : m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── M-Pesa fields ── */}
          {selected && form.method === "mpesa" && selectedFeeTypes.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {canSTK && (
                <div>
                  <label className="settings-label" style={{ marginBottom: 6, display: "block" }}>Phone number (STK Push)</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input style={{ ...inp, flex: 1 }} placeholder="07XX XXX XXX" value={form.phone} onChange={set("phone")} />
                    <button
                      onClick={handleSTK}
                      disabled={!phoneValid || stkLoading || totalAmount <= 0}
                      style={{
                        padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                        cursor: phoneValid && !stkLoading ? "pointer" : "not-allowed", fontFamily: "inherit",
                        background: phoneValid ? "rgba(34,211,164,0.1)" : "var(--surface2)",
                        border: `1px solid ${phoneValid ? "rgba(34,211,164,0.25)" : "var(--border)"}`,
                        color: phoneValid ? "var(--accent)" : "var(--text3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {stkLoading ? "Sending…" : "STK Push"}
                    </button>
                  </div>
                  {stkSent && <div style={{ fontSize: 12, color: "var(--accent)", marginTop: 6 }}>✓ STK sent — waiting for confirmation</div>}
                </div>
              )}
              <div>
                <label className="settings-label" style={{ marginBottom: 6, display: "block" }}>M-Pesa reference (optional)</label>
                <input style={inp} placeholder="e.g. RHJ4KL9X" value={form.txnRef} onChange={set("txnRef")} />
              </div>
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12.5, color: "var(--danger)", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 8, padding: "10px 14px" }}>
              ✕ {error}
            </div>
          )}
        </div>

        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !selected || totalAmount <= 0 || selectedFeeTypes.length === 0}
            style={{
              padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: (!saving && selected && totalAmount > 0 && selectedFeeTypes.length > 0) ? "var(--accent)" : "var(--surface2)",
              border: "none",
              color: (!saving && selected && totalAmount > 0 && selectedFeeTypes.length > 0) ? "#0b1a14" : "var(--text3)",
              cursor: (!saving && selected && totalAmount > 0 && selectedFeeTypes.length > 0) ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}
          >
            {saving ? "Saving…" : `Save — KES ${totalAmount.toLocaleString()}`}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Payments Page ────────────────────────────────────────────────────────────
export default function Payments() {
  const { token }          = useAuth();
  const { openSidebar }    = useOutletContext();
  const navigate           = useNavigate();

  const [payments,    setPayments]    = useState([]);
  const [unmatched,   setUnmatched]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showModal,   setShowModal]   = useState(false);
  const [search,      setSearch]      = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [dateFilter,  setDateFilter]  = useState("all");

  useEffect(() => {
    Promise.all([
      axios.get(`${API}/api/payments`,           { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${API}/api/payments/unmatched`, { headers: { Authorization: `Bearer ${token}` } }),
    ]).then(([pRes, uRes]) => {
      setPayments(pRes.data);
      setUnmatched(uRes.data || []);
    }).catch(console.error)
    .finally(() => setLoading(false));
  }, [token]);

  const handleAdded = (p) => setPayments(prev => [p, ...prev]);

  const now = Date.now();
  const filtered = payments.filter(p => {
    const matchSearch  = !search || p.name?.toLowerCase().includes(search.toLowerCase()) || p.txn?.toLowerCase().includes(search.toLowerCase());
    const matchMethod  = methodFilter === "all" || p.method?.toLowerCase() === methodFilter;
    const ts           = p.createdAt ? new Date(p.createdAt).getTime() : 0;
    const matchDate    =
      dateFilter === "all"   ? true :
      dateFilter === "today" ? ts > now - 86400000 :
      dateFilter === "week"  ? ts > now - 7 * 86400000 :
      dateFilter === "month" ? ts > now - 30 * 86400000 : true;
    return matchSearch && matchMethod && matchDate;
  });

  const totalFiltered = filtered.reduce((sum, p) => {
    const amt = typeof p.amount === "string"
      ? parseFloat(p.amount.replace(/[^0-9.]/g, "")) || 0
      : p.amount || 0;
    return sum + amt;
  }, 0);

  return (
    <>
      <Topbar title="Payments" sub="All recorded payments" onMenuClick={openSidebar}>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Manual</button>
      </Topbar>

      <div className="page-content">
        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)" }}><SearchIcon /></span>
            <input
              style={{ width: "100%", paddingLeft: 34, paddingRight: 12, height: 40, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
              placeholder="Search by name or ref…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Method filter */}
          {["all", "mpesa", "bank", "cash"].map(m => (
            <button
              key={m}
              onClick={() => setMethodFilter(m)}
              style={{
                padding: "7px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit",
                background: methodFilter === m ? "rgba(59,130,246,0.12)" : "var(--surface2)",
                border: `1px solid ${methodFilter === m ? "rgba(59,130,246,0.35)" : "var(--border)"}`,
                color: methodFilter === m ? "var(--blue)" : "var(--text2)",
              }}
            >
              {m === "all" ? "All methods" : m === "mpesa" ? "M-Pesa" : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Date filters + summary */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {["all", "today", "week", "month"].map(d => (
            <button
              key={d}
              onClick={() => setDateFilter(d)}
              style={{
                padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit",
                background: dateFilter === d ? "rgba(59,130,246,0.12)" : "var(--surface2)",
                border: `1px solid ${dateFilter === d ? "rgba(59,130,246,0.35)" : "var(--border)"}`,
                color: dateFilter === d ? "var(--blue)" : "var(--text2)",
              }}
            >
              {d === "all" ? "All time" : d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}

          {filtered.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11.5, color: "var(--text3)" }}>{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
              {totalFiltered > 0 && (
                <span style={{
                  fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
                  background: "rgba(34,211,164,0.08)", border: "1px solid rgba(34,211,164,0.15)", color: "var(--green)",
                }}>
                  KES {totalFiltered.toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Payments list */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">All Payments</div>
              <div className="card-sub">Most recent first</div>
            </div>
          </div>
          <div className="card-body-flush">
            {loading ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "48px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>💳</div>
                <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500, marginBottom: 6 }}>
                  {search || methodFilter !== "all" ? "No payments match your filters" : "No payments recorded yet"}
                </div>
                <div
                  style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer" }}
                  onClick={() => search || methodFilter !== "all" ? (setSearch(""), setMethodFilter("all")) : setShowModal(true)}
                >
                  {search || methodFilter !== "all" ? "Clear filters" : "Add manual payment →"}
                </div>
              </div>
            ) : filtered.map((p, i) => (
              <div
                key={p.id || i}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 18px",
                  borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none",
                  transition: "background .1s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                  background: "rgba(34,211,164,0.08)", border: "1px solid rgba(34,211,164,0.15)",
                  display: "flex", alignItems: "center", justifyContent: "center", color: "var(--green)",
                }}>
                  <PayIcon />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{p.meta}</span>
                    {p.txn && p.txn !== "—" && (
                      <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", flexShrink: 0 }}>{p.txn}</span>
                    )}
                    {/* Fee type tags */}
                    {p.feeBreakdown && p.feeBreakdown.length > 0 && (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {p.feeBreakdown.map((fb, fi) => (
                          <span key={fi} style={{
                            fontSize: 10.5, padding: "2px 7px", borderRadius: 4,
                            background: "var(--surface3)", border: "1px solid var(--border)",
                            color: "var(--text3)",
                          }}>
                            {fb.typeName}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <MethodBadge method={p.method || "mpesa"} />
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>+{p.amount}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Unmatched */}
        {!loading && unmatched.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "24px 0 16px" }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--amber)", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", padding: "4px 14px", borderRadius: 20, whiteSpace: "nowrap" }}>
                ⚠ Unmatched Payments — Action Required
              </div>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title" style={{ color: "var(--amber)" }}>Unmatched M-Pesa Payments</div>
                  <div className="card-sub">Could not be linked to a student — review and assign manually</div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 20, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "var(--amber)" }}>
                  {unmatched.length} pending
                </span>
              </div>
              <div className="card-body-flush">
                {unmatched.map((p, i) => (
                  <div key={p.id || i} style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "12px 18px",
                    borderBottom: i < unmatched.length - 1 ? "1px solid var(--border)" : "none",
                    flexWrap: "wrap",
                  }}>
                    <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--amber)" }}>
                      <QIcon />
                    </div>
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--amber)", marginBottom: 2 }}>Unknown Sender</div>
                      <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        Phone: {p.phone}
                        {p.txn && <span style={{ fontFamily: "monospace", fontSize: 11, background: "rgba(245,158,11,0.05)", padding: "1px 6px", borderRadius: 4, border: "1px solid rgba(245,158,11,0.15)", color: "var(--amber)" }}>{p.txn}</span>}
                      </div>
                    </div>
                    <button style={{
                      padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600,
                      cursor: "pointer", fontFamily: "inherit", minHeight: 36,
                      background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", color: "var(--amber)",
                    }}>
                      Assign →
                    </button>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--amber)", fontVariantNumeric: "tabular-nums" }}>{p.amount}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {showModal && <AddPaymentModal onClose={() => setShowModal(false)} onAdded={handleAdded} />}
    </>
  );
}
