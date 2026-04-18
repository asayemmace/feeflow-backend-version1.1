import { useState, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate, useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

// ─── Icons ────────────────────────────────────────────────────────────────────
const SearchIcon = () => (
  <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
  </svg>
);
const FilterIcon = () => (
  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M7 9h10M11 14h2"/>
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
const PlusIcon = () => (
  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
  </svg>
);
const MpesaIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/>
  </svg>
);

// ─── Method badge ─────────────────────────────────────────────────────────────
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
      background: c.bg, border: `1px solid ${c.border}`, color: c.color,
      flexShrink: 0,
    }}>
      {c.label}
    </span>
  );
};

// shared input style for the modal
const inp = {
  width: "100%", padding: "10px 12px",
  background: "var(--input-bg)", border: "1px solid var(--input-border)",
  borderRadius: 8, color: "var(--text)", fontSize: 14,
  fontFamily: "inherit", outline: "none", boxSizing: "border-box",
};

// ─── Add Payment Modal ────────────────────────────────────────────────────────
function AddPaymentModal({ onClose, onAdded }) {
  const { token, canUse } = useAuth();
  const navigate = useNavigate();
  const [students, setStudents]       = useState([]);
  const [loadingStudents, setLoading] = useState(true);
  const [classFilter, setClassFilter] = useState("all");
  const [search, setSearch]           = useState("");
  const [form, setForm] = useState({ studentId: "", amount: "", phone: "", txnRef: "", method: "mpesa" });
  const [selected, setSelected]       = useState(null);
  const [saving, setSaving]           = useState(false);
  const [stkLoading, setStkLoading]   = useState(false);
  const [stkSent, setStkSent]         = useState(false);
  const [error, setError]             = useState("");

  useEffect(() => {
    axios.get(`${API}/api/students`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setStudents(r.data))
      .catch(() => setError("Could not load students."))
      .finally(() => setLoading(false));
  }, [token]);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const selectStudent = s => {
    setSelected(s);
    setForm(f => ({ ...f, studentId: s.id, amount: Math.max(0, s.fee - s.paid).toString() }));
  };

  const classes  = [...new Set(students.map(s => s.cls))].sort();
  const filtered = students
    .filter(s => classFilter === "all" || s.cls === classFilter)
    .filter(s => !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.adm?.toLowerCase().includes(search.toLowerCase()));

  const balance    = selected ? Math.max(0, selected.fee - selected.paid) : 0;
  const amountNum  = parseFloat(form.amount) || 0;
  const phoneClean = form.phone.replace(/\s/g, "");
  const phoneValid = /^(07|01)\d{8}$/.test(phoneClean);
  const canSTK     = canUse?.("mpesa");

  const handleSave = async () => {
    if (!form.studentId) return setError("Select a student.");
    if (amountNum <= 0)  return setError("Enter a valid amount.");
    setSaving(true); setError("");
    try {
      const res = await axios.post(`${API}/api/payments`,
        { studentId: form.studentId, amount: amountNum, txnRef: form.txnRef || null },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      onAdded(res.data); onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleSTK = async () => {
    if (!phoneValid || !form.studentId || amountNum <= 0 || !canSTK) return;
    setStkLoading(true); setError(""); setStkSent(false);
    try {
      await axios.post(`${API}/api/payments/stk`,
        { studentId: form.studentId, amount: amountNum, phone: phoneClean },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setStkSent(true);
    } catch (e) { setError(e.response?.data?.message || "STK push failed."); }
    finally { setStkLoading(false); }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-box">
        <div className="modal-header">
          <div>
            <div className="modal-title">Record Payment</div>
            <div className="modal-sub">Select a student, enter amount, then save</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18, overflowY: "auto", maxHeight: "60vh", WebkitOverflowScrolling: "touch" }}>

          {/* Student picker */}
          <div>
            <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>Select Student</label>

            {/* Search */}
            <div style={{ position: "relative", marginBottom: 10 }}>
              <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", pointerEvents: "none", display: "flex" }}>
                <SearchIcon />
              </div>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or admission no…"
                style={{ ...inp, paddingLeft: 36 }}
              />
            </div>

            {/* Class filter pills */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {["all", ...classes].map(c => (
                <button key={c} onClick={() => setClassFilter(c)} style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 11.5, fontWeight: 500,
                  background: classFilter === c ? "var(--accent)" : "var(--surface2)",
                  border: `1px solid ${classFilter === c ? "var(--accent)" : "var(--border)"}`,
                  color: classFilter === c ? "#0b1a14" : "var(--text2)",
                  cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                  minHeight: 32,
                }}>
                  {c === "all" ? "All" : c}
                </button>
              ))}
            </div>

            {/* Student list */}
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", maxHeight: 200, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
              {loadingStudents
                ? <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading…</div>
                : filtered.length === 0
                ? <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>
                    No students found.{" "}
                    <span style={{ color: "var(--accent)", cursor: "pointer" }} onClick={() => { onClose(); navigate("/students"); }}>
                      Add students →
                    </span>
                  </div>
                : filtered.map(s => {
                    const bal  = Math.max(0, s.fee - s.paid);
                    const isSel = form.studentId === s.id;
                    return (
                      <div
                        key={s.id}
                        onClick={() => selectStudent(s)}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "11px 14px",
                          background: isSel ? "rgba(34,211,164,0.06)" : "transparent",
                          borderBottom: "1px solid var(--border)",
                          borderLeft: `3px solid ${isSel ? "var(--accent)" : "transparent"}`,
                          cursor: "pointer", transition: "background .1s", minHeight: 48,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: isSel ? "var(--accent)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                          <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{s.cls} · {s.adm || "—"}</div>
                        </div>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: bal === 0 ? "var(--green)" : "var(--amber)", flexShrink: 0, marginLeft: 8 }}>
                          {bal === 0 ? "✓ Paid" : `KES ${bal.toLocaleString()}`}
                        </div>
                      </div>
                    );
                  })
              }
            </div>
          </div>

          {/* Fee summary */}
          {selected && (
            <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8, fontWeight: 500 }}>Fee summary — {selected.name}</div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                {[["Term fee", `KES ${selected.fee?.toLocaleString()}`], ["Paid", `KES ${selected.paid?.toLocaleString()}`], ["Balance", `KES ${balance.toLocaleString()}`]].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10.5, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>{k}</div>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: k === "Balance" && balance > 0 ? "var(--amber)" : k === "Balance" ? "var(--green)" : "var(--text)" }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Amount + method */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field-group">
              <label className="settings-label">Amount (KES)</label>
              <input type="number" inputMode="numeric" value={form.amount} onChange={set("amount")} placeholder="Enter amount" style={inp} />
              {selected && balance > 0 && (
                <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
                  <span onClick={() => setForm(f => ({ ...f, amount: balance.toString() }))} style={{ color: "var(--accent)", cursor: "pointer" }}>
                    Use full balance ({balance.toLocaleString()})
                  </span>
                </div>
              )}
            </div>
            <div className="field-group">
              <label className="settings-label">Method</label>
              <select value={form.method} onChange={set("method")} style={inp}>
                <option value="mpesa">M-Pesa</option>
                <option value="bank">Bank transfer</option>
                <option value="cash">Cash</option>
              </select>
            </div>
          </div>

          {/* TXN ref */}
          <div className="field-group">
            <label className="settings-label">Transaction reference (optional)</label>
            <input value={form.txnRef} onChange={set("txnRef")} placeholder="e.g. QA73NXP2" style={inp} />
          </div>

          {/* STK Push */}
          <div style={{ background: "rgba(34,211,164,0.05)", border: "1px solid rgba(34,211,164,0.15)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text2)", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>📲</span> M-Pesa STK Push
              </span>
              {!canSTK && (
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", color: "var(--amber)" }}>
                  🔒 Pro feature
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ position: "relative", flex: 1 }}>
                <div style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", pointerEvents: "none" }}>
                  <MpesaIcon />
                </div>
                <input
                  type="tel"
                  inputMode="tel"
                  value={form.phone}
                  onChange={set("phone")}
                  placeholder="07XX XXX XXX"
                  maxLength={12}
                  disabled={!canSTK}
                  style={{
                    ...inp,
                    paddingLeft: 32,
                    background: !canSTK ? "var(--surface3)" : "var(--input-bg)",
                    color: !canSTK ? "var(--text3)" : "var(--text)",
                    opacity: !canSTK ? 0.6 : 1,
                  }}
                />
              </div>
              <button
                onClick={handleSTK}
                disabled={!phoneValid || !form.studentId || amountNum <= 0 || stkLoading || !canSTK}
                style={{
                  padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  whiteSpace: "nowrap", fontFamily: "inherit", border: "none",
                  minHeight: 44, cursor: !canSTK || !phoneValid || !form.studentId || amountNum <= 0 ? "not-allowed" : "pointer",
                  background: !canSTK || !phoneValid || !form.studentId || amountNum <= 0 ? "var(--surface3)"
                    : stkSent ? "rgba(34,211,164,0.1)" : "var(--accent)",
                  color: !canSTK || !phoneValid || !form.studentId || amountNum <= 0 ? "var(--text3)"
                    : stkSent ? "var(--accent)" : "#0b1a14",
                  transition: "all .2s",
                }}
              >
                {stkLoading ? "Sending…" : stkSent ? "✓ Sent!" : "Send →"}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 8 }}>
              {!canSTK ? "STK Push requires a Pro or Max plan."
                : !form.phone ? "Enter a valid Kenyan number to enable."
                : !phoneValid ? "Must be 10 digits starting with 07 or 01."
                : "STK prompt will ask the parent for their M-Pesa PIN."}
            </div>
            {stkSent && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent)", background: "rgba(34,211,164,0.05)", border: "1px solid rgba(34,211,164,0.15)", borderRadius: 8, padding: "8px 10px" }}>
                ✓ Prompt sent! Once parent pays, it auto-matches or record manually.
              </div>
            )}
          </div>

          {error && <div className="settings-error">✕ {error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !form.studentId || amountNum <= 0}>
            {saving ? "Saving…" : "Save payment"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Payments Page ─────────────────────────────────────────────────────────────
export default function Payments() {
  const { token } = useAuth();
  const { openSidebar } = useOutletContext();

  const [payments, setPayments]       = useState([]);
  const [unmatched, setUnmatched]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showModal, setShowModal]     = useState(false);
  const [search, setSearch]           = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [dateFilter, setDateFilter]   = useState("all");

  useEffect(() => {
    (async () => {
      try {
        const [pRes, uRes] = await Promise.all([
          axios.get(`${API}/api/payments/recent`,    { headers: { Authorization: `Bearer ${token}` } }),
          axios.get(`${API}/api/payments/unmatched`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        setPayments(pRes.data);
        setUnmatched(uRes.data);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, [token]);

  const handleAdded = payment => setPayments(prev => [payment, ...prev]);

  const filtered = payments.filter(p => {
    const matchSearch = !search || p.name?.toLowerCase().includes(search.toLowerCase()) || p.txn?.toLowerCase().includes(search.toLowerCase());
    const matchMethod = methodFilter === "all" || p.method?.toLowerCase() === methodFilter;
    return matchSearch && matchMethod;
  });

  const totalFiltered = filtered.reduce((acc, p) => {
    return acc + (parseFloat(String(p.amount).replace(/[^0-9.]/g, "")) || 0);
  }, 0);

  return (
    <>
      <Topbar
        title="Payments"
        sub="M-Pesa and manual records"
        onMenuClick={openSidebar}
      >
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <PlusIcon /> Add Manual
        </button>
      </Topbar>

      <div className="page-content">

        {/* ── Search & Filter Bar ───────────────────────────────────────── */}
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 12, padding: "14px 16px",
          display: "flex", alignItems: "center", gap: 10,
          flexWrap: "wrap", marginBottom: 20,
        }}>
          {/* Search input */}
          <div style={{ position: "relative", flex: "1 1 180px", minWidth: 160 }}>
            <div style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", pointerEvents: "none", display: "flex" }}>
              <SearchIcon />
            </div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search student or reference…"
              style={{ width: "100%", padding: "9px 12px 9px 34px", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, fontSize: 14, color: "var(--text)", fontFamily: "inherit", outline: "none" }}
            />
          </div>

          {/* Method pills */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text3)", fontSize: 11.5, marginRight: 2 }}>
              <FilterIcon /> Method
            </div>
            {[
              { key: "all",   label: "All" },
              { key: "mpesa", label: "M-Pesa" },
              { key: "bank",  label: "Bank" },
              { key: "cash",  label: "Cash" },
            ].map(opt => (
              <button key={opt.key} onClick={() => setMethodFilter(opt.key)} style={{
                padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 500,
                fontFamily: "inherit", cursor: "pointer", transition: "all .15s", minHeight: 32,
                background: methodFilter === opt.key ? "var(--accent)" : "var(--surface2)",
                border: `1px solid ${methodFilter === opt.key ? "var(--accent)" : "var(--border)"}`,
                color: methodFilter === opt.key ? "#0b1a14" : "var(--text2)",
              }}>
                {opt.label}
              </button>
            ))}
          </div>

          {/* Date pills */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text3)", fontSize: 11.5, marginRight: 2 }}>
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
              </svg>
              Period
            </div>
            {["today","week","month","all"].map(d => (
              <button key={d} onClick={() => setDateFilter(d)} style={{
                padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 500,
                fontFamily: "inherit", cursor: "pointer", transition: "all .15s", minHeight: 32,
                background: dateFilter === d ? "rgba(59,130,246,0.15)" : "var(--surface2)",
                border: `1px solid ${dateFilter === d ? "rgba(59,130,246,0.4)" : "var(--border)"}`,
                color: dateFilter === d ? "var(--blue)" : "var(--text2)",
              }}>
                {d === "all" ? "All time" : d.charAt(0).toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>

          {/* Summary chip */}
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

        {/* ── Payments List ─────────────────────────────────────────────── */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">All Payments</div>
              <div className="card-sub">Most recent first</div>
            </div>
          </div>
          <div className="card-body-flush">
            {loading
              ? <div style={{ padding: 32, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading…</div>
              : filtered.length === 0
              ? (
                <div style={{ padding: "48px 20px", textAlign: "center" }}>
                  <div style={{ fontSize: 28, marginBottom: 12 }}>💳</div>
                  <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500, marginBottom: 6 }}>
                    {search || methodFilter !== "all" ? "No payments match your filters" : "No payments recorded yet"}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer" }}
                    onClick={() => search || methodFilter !== "all" ? (setSearch(""), setMethodFilter("all")) : setShowModal(true)}>
                    {search || methodFilter !== "all" ? "Clear filters" : "Add manual payment →"}
                  </div>
                </div>
              )
              : filtered.map((p, i) => (
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
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{p.meta}</span>
                      {p.txn && p.txn !== "—" && (
                        <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", flexShrink: 0 }}>{p.txn}</span>
                      )}
                    </div>
                  </div>
                  <MethodBadge method={p.method || "mpesa"} />
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>+{p.amount}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                  </div>
                </div>
              ))
            }
          </div>
        </div>

        {/* ── Unmatched ─────────────────────────────────────────────────── */}
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
                      transition: "all .15s",
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
