import { useState, useMemo, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import { useFeeStructure } from "../hooks/useFeeStructure";
import useAppStore from "../store/useAppStore";
import Pagination from "../components/Pagination";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";
const PAGE_SIZE = 50;

// ─── Icons ────────────────────────────────────────────────────────────────────
const SearchIcon = () => <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>;
const PayIcon   = () => <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/></svg>;
const QIcon     = () => <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>;
const TrashIcon = () => <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>;
const PrintIcon = () => <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>;
const LockIcon  = () => <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>;

const MethodBadge = ({ method }) => {
  const c = {
    mpesa: { label: "M-Pesa", color: "var(--green)", bg: "var(--green-bg)", border: "var(--green-border)" },
    bank:  { label: "Bank",   color: "var(--blue)",  bg: "var(--blue-bg)",  border: "var(--blue-border)"  },
    cash:  { label: "Cash",   color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
  }[method?.toLowerCase()] || { label: method || "—", color: "var(--text3)", bg: "var(--surface2)", border: "var(--border)" };
  return <span style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: c.bg, border: `1px solid ${c.border}`, color: c.color, flexShrink: 0 }}>{c.label}</span>;
};

const inp = { width: "100%", padding: "10px 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

// ─── Receipt printer — includes method, fee types, date ──────────────────────
function printReceipt(payment, schoolName = "FeeFlow School") {
  const methodLabel = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash" };
  const win = window.open("", "_blank", "width=420,height=600");
  win.document.write(`
    <!DOCTYPE html><html lang="en"><head><title>Receipt</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#111;padding:28px;max-width:380px;margin:0 auto}
      .logo{font-size:20px;font-weight:700;color:#059669;margin-bottom:2px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .school{font-size:11px;color:#666;margin-bottom:20px}
      h2{font-size:15px;font-weight:700;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #059669;color:#059669;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #eee;font-size:12.5px}
      .row .label{color:#666}
      .row .val{font-weight:600;text-align:right;max-width:60%}
      .amount{font-size:22px;font-weight:800;color:#059669;text-align:center;padding:16px 0;margin:12px 0;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .section{margin-top:14px;font-size:11.5px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
      .footer{text-align:center;font-size:11px;color:#aaa;margin-top:20px;padding-top:12px;border-top:1px dashed #ddd}
      @media print{
        *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
        body{padding:16px}
      }
    </style></head><body>
    <div class="logo">FeeFlow</div>
    <div class="school">${schoolName}</div>
    <h2>Payment Receipt</h2>
    <div class="amount">KES ${payment.amount}</div>
    ${[
      ["Student",    payment.name],
      ["Class · Adm", payment.meta],
      ["Method",     methodLabel[payment.method?.toLowerCase()] || payment.method?.toUpperCase() || "—"],
      payment.txn && payment.txn !== "—" ? ["M-Pesa Ref", payment.txn] : null,
      ["Date",       payment.time],
    ].filter(Boolean).map(([l, v]) => `<div class="row"><span class="label">${l}</span><span class="val">${v}</span></div>`).join("")}
    ${payment.feeBreakdown?.length ? `
      <div class="section">Fee Breakdown</div>
      ${payment.feeBreakdown.map(fb => `<div class="row"><span class="label">${fb.typeName}</span><span class="val">KES ${Number(fb.amount).toLocaleString()}</span></div>`).join("")}
    ` : ""}
    <div class="footer">Thank you for your payment · FeeFlow Fee Management</div>
    </body></html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

// ─── Delete Confirm Modal ─────────────────────────────────────────────────────
function DeleteConfirmModal({ payment, onClose, token }) {
  const deletePayment = useAppStore(s => s.deletePayment);
  const updateStudent = useAppStore(s => s.updateStudent);
  const students      = useAppStore(s => s.students);
  const refreshStats  = useAppStore(s => s.refreshStats);
  const [deleting, setDeleting] = useState(false);
  const [error,    setError]    = useState("");

  const handleDelete = async () => {
    setDeleting(true); setError("");
    try {
      await axios.delete(`${API}/api/payments/${payment.id}`, { headers: { Authorization: `Bearer ${token}` } });
      deletePayment(payment.id);
      const student = students.find(s => s.id === payment.studentId);
      if (student) {
        const amt = typeof payment.amount === "string" ? parseFloat(payment.amount.replace(/[^0-9.]/g, "")) : payment.amount || 0;
        updateStudent({ ...student, paid: Math.max(0, student.paid - amt) });
      }
      refreshStats(token);
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to delete payment."); }
    finally { setDeleting(false); }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 400, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", padding: 24, animation: "modalIn .18s ease" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--red-bg)", border: "1px solid var(--red-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--red)", flexShrink: 0 }}><TrashIcon /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Delete Payment?</div>
            <div style={{ fontSize: 12.5, color: "var(--text3)", marginTop: 2 }}>This will reverse the student's balance</div>
          </div>
        </div>
        <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 4 }}>{payment.name}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 6 }}>{payment.meta}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--red)", fontVariantNumeric: "tabular-nums" }}>{payment.amount}</div>
          <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 3 }}>{payment.time}</div>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>
          ⚠ This cannot be undone. The amount will be deducted from the student's paid total.
        </div>
        {error && <div style={{ fontSize: 12.5, color: "var(--red)", marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleDelete} disabled={deleting} style={{ padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: deleting ? "var(--surface2)" : "var(--red)", border: "none", color: deleting ? "var(--text3)" : "#fff", cursor: deleting ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {deleting ? "Deleting…" : "Delete payment"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Assign Unmatched Modal ───────────────────────────────────────────────────
function AssignModal({ payment, onClose, token }) {
  const students        = useAppStore(s => s.students);
  const removeUnmatched = useAppStore(s => s.removeUnmatched);
  const updateStudent   = useAppStore(s => s.updateStudent);
  const refreshStats    = useAppStore(s => s.refreshStats);
  const [search,    setSearch]    = useState("");
  const [selected,  setSelected]  = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [error,     setError]     = useState("");

  const filtered = students.filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()) || (s.adm || "").toLowerCase().includes(search.toLowerCase()));

  const handleAssign = async () => {
    if (!selected) return;
    setAssigning(true); setError("");
    try {
      await axios.post(`${API}/api/payments/unmatched/${payment.id}/assign`, { studentId: selected.id }, { headers: { Authorization: `Bearer ${token}` } });
      removeUnmatched(payment.id);
      const rawAmt = payment.rawAmount || (typeof payment.amount === "string" ? parseFloat(payment.amount.replace(/[^0-9.]/g, "")) : payment.amount || 0);
      updateStudent({ ...selected, paid: selected.paid + rawAmt });
      refreshStats(token);
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to assign payment."); }
    finally { setAssigning(false); }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 460, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", maxHeight: "80vh", animation: "modalIn .18s ease" }}>
        <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Assign Payment</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>Link this M-Pesa payment to a student</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 14 }}>×</button>
        </div>
        <div style={{ margin: "14px 18px 0", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 9, padding: "12px 14px", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11.5, color: "var(--amber)", fontWeight: 600, textTransform: "uppercase", letterSpacing: .6, marginBottom: 2 }}>Unmatched M-Pesa</div>
              <div style={{ fontSize: 12, color: "var(--text3)" }}>Phone: {payment.phone} · Ref: {payment.txn}</div>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--amber)", fontVariantNumeric: "tabular-nums" }}>{payment.amount}</div>
          </div>
        </div>
        <div style={{ padding: "14px 18px 0", flexShrink: 0 }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)" }}><SearchIcon /></span>
            <input style={{ ...inp, paddingLeft: 34 }} placeholder="Search student by name or adm…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", margin: "10px 18px 0", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
          {filtered.length === 0
            ? <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: "var(--text3)" }}>No students found.</div>
            : filtered.map(s => {
              const isSel   = selected?.id === s.id;
              const balance = Math.max(0, s.fee - s.paid);
              return (
                <div key={s.id} onClick={() => setSelected(s)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", cursor: "pointer", background: isSel ? "var(--green-bg)" : "transparent", borderLeft: `3px solid ${isSel ? "var(--green)" : "transparent"}`, borderBottom: "1px solid var(--border)", transition: "all .1s" }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: "var(--surface2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--text2)" }}>
                    {s.name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text3)" }}>{s.cls} · {s.adm}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {balance > 0
                      ? <div style={{ fontSize: 12, color: "var(--amber)", fontWeight: 600 }}>KES {balance.toLocaleString()} due</div>
                      : <div style={{ fontSize: 12, color: "var(--green)" }}>✓ Cleared</div>
                    }
                  </div>
                </div>
              );
            })
          }
        </div>
        {error && <div style={{ margin: "10px 18px 0", fontSize: 12.5, color: "var(--red)" }}>{error}</div>}
        <div style={{ padding: "14px 18px", borderTop: "1px solid var(--border)", display: "flex", gap: 10, justifyContent: "flex-end", flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleAssign} disabled={!selected || assigning} style={{ padding: "9px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: selected && !assigning ? "var(--green)" : "var(--surface2)", border: "none", color: selected && !assigning ? "#0b1a14" : "var(--text3)", cursor: selected && !assigning ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
            {assigning ? "Assigning…" : selected ? `Assign to ${selected.name.split(" ")[0]}` : "Select a student"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Fee Type Selector ────────────────────────────────────────────────────────
function PaymentFeeTypeSelector({ feeTypes, selectedIds, onToggle, feeAmounts, onAmountChange, studentClass, feeMatrix }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {feeTypes.map(ft => {
        const isSelected = selectedIds.includes(ft.id);
        const suggested  = feeMatrix?.[studentClass]?.[ft.id] || 0;
        // Use empty string as placeholder, never pre-fill with 0
        const amount     = isSelected ? (feeAmounts[ft.id] !== undefined ? feeAmounts[ft.id] : suggested) : "";
        return (
          <div key={ft.id} style={{ display: "flex", alignItems: "center", gap: 10, background: isSelected ? "var(--green-bg)" : "var(--surface3)", border: `1px solid ${isSelected ? "var(--green-border)" : "var(--border)"}`, borderRadius: 8, padding: "9px 12px", transition: "all .15s" }}>
            <div onClick={() => onToggle(ft.id, suggested)} style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, border: `2px solid ${isSelected ? "var(--green)" : "var(--text3)"}`, background: isSelected ? "var(--green)" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}>
              {isSelected && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#0b1a14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            <span onClick={() => onToggle(ft.id, suggested)} style={{ flex: 1, fontSize: 13, color: isSelected ? "var(--text)" : "var(--text2)", cursor: "pointer", fontWeight: isSelected ? 500 : 400 }}>
              {ft.name}
              {suggested > 0 && !isSelected && <span style={{ fontSize: 11, color: "var(--text3)", marginLeft: 6 }}>(KES {suggested.toLocaleString()})</span>}
            </span>
            {isSelected && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 11, color: "var(--text3)" }}>KES</span>
                <input
                  type="number" min="0"
                  // Use string value so clearing works; 0 shows as empty placeholder
                  value={feeAmounts[ft.id] !== undefined ? feeAmounts[ft.id] : (suggested || "")}
                  onChange={e => {
                    // Replace leading zeros: parse then set so "050000" becomes "50000"
                    const raw = e.target.value;
                    const num = raw === "" ? "" : String(parseInt(raw, 10) || 0);
                    onAmountChange(ft.id, num);
                  }}
                  placeholder={suggested > 0 ? suggested.toLocaleString() : "0"}
                  style={{ width: 90, padding: "5px 8px", textAlign: "right", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 6, color: "var(--text)", fontSize: 12.5, fontFamily: "inherit", outline: "none" }}
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
function AddPaymentModal({ onClose }) {
  const { token, canUse, plan }  = useAuth();
  const { feeTypes, feeMatrix }  = useFeeStructure();
  const students      = useAppStore(s => s.students);
  const addPayment    = useAppStore(s => s.addPayment);
  const updateStudent = useAppStore(s => s.updateStudent);
  const refreshStats  = useAppStore(s => s.refreshStats);

  const [classFilter,      setClassFilter]      = useState("all");
  const [search,           setSearch]           = useState("");
  const [selected,         setSelected]         = useState(null);
  const [selectedFeeTypes, setSelectedFeeTypes] = useState([]);
  const [feeAmounts,       setFeeAmounts]       = useState({});
  const [othersLabel,      setOthersLabel]      = useState("");
  const [form,             setForm]             = useState({ phone: "", txnRef: "", method: "mpesa" });
  const [saving,           setSaving]           = useState(false);
  const [stkLoading,       setStkLoading]       = useState(false);
  const [stkSent,          setStkSent]          = useState(false);
  const [error,            setError]            = useState("");

  const canSTK = canUse?.("mpesa");

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const selectStudent = s => { setSelected(s); setSelectedFeeTypes([]); setFeeAmounts({}); setOthersLabel(""); setStkSent(false); };

  const handleToggleFeeType = (typeId, suggested) => {
    setSelectedFeeTypes(prev => {
      const isIn = prev.includes(typeId);
      if (isIn) {
        setFeeAmounts(fa => { const { [typeId]: _, ...rest } = fa; return rest; });
        return prev.filter(id => id !== typeId);
      }
      if (suggested > 0) setFeeAmounts(fa => ({ ...fa, [typeId]: suggested }));
      return [...prev, typeId];
    });
  };

  const handleAmountChange = (typeId, val) => {
    const num = val === "" ? "" : String(parseInt(val, 10) || 0);
    setFeeAmounts(fa => ({ ...fa, [typeId]: num }));
  };

  const totalAmount    = selectedFeeTypes.reduce((s, id) => s + (parseInt(feeAmounts[id], 10) || 0), 0);
  const classes        = [...new Set(students.map(s => s.cls))].sort();
  const filteredStu    = students
    .filter(s => classFilter === "all" || s.cls === classFilter)
    .filter(s => !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.adm?.toLowerCase().includes(search.toLowerCase()));
  const balance        = selected ? Math.max(0, selected.fee - selected.paid) : 0;
  const phoneClean     = form.phone.replace(/\s/g, "");
  const phoneValid     = /^(07|01)\d{8}$/.test(phoneClean);
  const selectedOthers = selectedFeeTypes.includes("others");

  const handleSave = async () => {
    if (!selected)                     return setError("Select a student.");
    if (totalAmount <= 0)              return setError("Enter a valid amount for at least one fee type.");
    if (selectedFeeTypes.length === 0) return setError("Select at least one fee type.");
    if (selectedOthers && !othersLabel.trim()) return setError("Specify the 'Others' description.");
    setSaving(true); setError("");
    try {
      const feeBreakdown = selectedFeeTypes.map(id => ({
        typeId: id,
        typeName: id === "others" ? othersLabel : feeTypes.find(ft => ft.id === id)?.name || id,
        amount: parseInt(feeAmounts[id], 10) || 0,
      }));
      const res = await axios.post(`${API}/api/payments`,
        { studentId: selected.id, amount: totalAmount, txnRef: form.txnRef || null, method: form.method, feeBreakdown },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      addPayment(res.data);
      updateStudent({ ...selected, paid: selected.paid + totalAmount });
      refreshStats(token);
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleSTK = async () => {
    if (!phoneValid || !selected || totalAmount <= 0 || !canSTK) return;
    setStkLoading(true); setError(""); setStkSent(false);
    try {
      await axios.post(`${API}/api/payments/stk`, { studentId: selected.id, amount: totalAmount, phone: phoneClean }, { headers: { Authorization: `Bearer ${token}` } });
      setStkSent(true);
    } catch (e) { setError(e.response?.data?.message || "STK push failed."); }
    finally { setStkLoading(false); }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-box" style={{ maxWidth: 540 }}>
        <div className="modal-header">
          <div><div className="modal-title">Record Payment</div><div className="modal-sub">Pick student, select fee types, then save</div></div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 20, overflowY: "auto", maxHeight: "65vh", WebkitOverflowScrolling: "touch" }}>

          {/* Student picker */}
          <div>
            <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>Select Student</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <div style={{ position: "relative", flex: 1 }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)" }}><SearchIcon /></span>
                <input style={{ ...inp, paddingLeft: 34 }} placeholder="Search by name or adm…" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <select value={classFilter} onChange={e => setClassFilter(e.target.value)} style={{ ...inp, width: 130, padding: "10px 10px" }}>
                <option value="all">All classes</option>
                {classes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
              {filteredStu.length === 0
                ? <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: "var(--text3)" }}>No students found.</div>
                : filteredStu.map(s => {
                  const isSel = selected?.id === s.id;
                  const bal   = Math.max(0, s.fee - s.paid);
                  return (
                    <div key={s.id} onClick={() => selectStudent(s)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer", background: isSel ? "var(--green-bg)" : "transparent", borderBottom: "1px solid var(--border)", borderLeft: `3px solid ${isSel ? "var(--green)" : "transparent"}`, transition: "all .1s" }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: "var(--surface2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--text2)" }}>
                        {s.name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--text3)" }}>{s.cls} · {s.adm}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        {bal > 0
                          ? <div style={{ fontSize: 12, color: "var(--amber)", fontWeight: 600 }}>KES {bal.toLocaleString()} due</div>
                          : <div style={{ fontSize: 12, color: "var(--green)" }}>✓ Cleared</div>
                        }
                      </div>
                    </div>
                  );
                })
              }
            </div>
          </div>

          {/* Fee types */}
          {selected && (
            <div>
              <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>
                Fee Types <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 400, textTransform: "none" }}>amounts auto-filled</span>
              </label>
              <PaymentFeeTypeSelector feeTypes={feeTypes} selectedIds={selectedFeeTypes} onToggle={handleToggleFeeType} feeAmounts={feeAmounts} onAmountChange={handleAmountChange} studentClass={selected.cls} feeMatrix={feeMatrix} />
              {selectedOthers && (
                <div style={{ marginTop: 10, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 9, padding: "12px 14px" }}>
                  <label className="settings-label">Specify "Others" description *</label>
                  <input style={inp} value={othersLabel} onChange={e => setOthersLabel(e.target.value)} placeholder="e.g. Exam registration…" />
                </div>
              )}
              {selectedFeeTypes.length > 0 && (
                <div style={{ marginTop: 12, background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--green)", marginBottom: 2, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>Total Payment</div>
                    <div style={{ fontSize: 22, fontFamily: "'DM Serif Display',serif", color: "var(--green)", lineHeight: 1 }}>KES {totalAmount.toLocaleString()}</div>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", textAlign: "right" }}>
                    <div>{selectedFeeTypes.length} fee type{selectedFeeTypes.length !== 1 ? "s" : ""}</div>
                    {balance > 0 && <div style={{ marginTop: 2, color: totalAmount >= balance ? "var(--green)" : "var(--amber)" }}>{totalAmount >= balance ? "✓ Clears balance" : `KES ${(balance - totalAmount).toLocaleString()} still owed`}</div>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Payment method — 3 options only, no Manual */}
          {selected && selectedFeeTypes.length > 0 && (
            <>
              <div>
                <label className="settings-label" style={{ marginBottom: 8, display: "block" }}>Payment Method</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {["mpesa", "bank", "cash"].map(m => (
                    <button key={m} onClick={() => setForm(f => ({ ...f, method: m }))} style={{ flex: 1, padding: "9px 0", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s", border: `1px solid ${form.method === m ? "var(--green)" : "var(--border)"}`, background: form.method === m ? "var(--green-bg)" : "var(--surface2)", color: form.method === m ? "var(--green)" : "var(--text2)" }}>
                      {m === "mpesa" ? "M-Pesa" : m.charAt(0).toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* M-Pesa fields — always shown when mpesa selected, locked for free plan */}
              {form.method === "mpesa" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* STK Push section — always visible; inputs disabled for free plan */}
                  <div style={{ background: "var(--surface2)", border: `1px solid ${canSTK ? "var(--border)" : "var(--border)"}`, borderRadius: 10, padding: "14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: canSTK ? "var(--text)" : "var(--text3)", display: "flex", alignItems: "center", gap: 6 }}>
                          {!canSTK && <span style={{ color: "var(--amber)" }}><LockIcon /></span>}
                          STK Push
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>
                          {canSTK
                            ? "Client will receive a prompt on their phone to enter their M-Pesa PIN"
                            : "Upgrade to Pro to send STK push prompts directly to parents' phones"
                          }
                        </div>
                      </div>
                      {!canSTK && (
                        <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Pro Upgrade" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", color: "var(--amber)", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}>
                          🔒 Upgrade to Pro
                        </a>
                      )}
                    </div>
                    {/* Phone input + button — always rendered, disabled on free plan */}
                    <div style={{ display: "flex", gap: 8, opacity: canSTK ? 1 : 0.45, pointerEvents: canSTK ? "auto" : "none" }}>
                      <input
                        style={{ ...inp, flex: 1, cursor: canSTK ? "text" : "not-allowed" }}
                        placeholder="07XX XXX XXX"
                        value={form.phone}
                        onChange={canSTK ? set("phone") : undefined}
                        readOnly={!canSTK}
                        tabIndex={canSTK ? 0 : -1}
                      />
                      <button
                        onClick={canSTK ? handleSTK : undefined}
                        disabled={!canSTK || !phoneValid || stkLoading || totalAmount <= 0}
                        style={{ padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: canSTK && phoneValid && !stkLoading ? "pointer" : "not-allowed", fontFamily: "inherit", background: canSTK && phoneValid ? "var(--green-bg)" : "var(--surface3)", border: `1px solid ${canSTK && phoneValid ? "var(--green-border)" : "var(--border)"}`, color: canSTK && phoneValid ? "var(--green)" : "var(--text3)", whiteSpace: "nowrap" }}
                      >
                        {stkLoading ? "Sending…" : "Send STK Push"}
                      </button>
                    </div>
                    {stkSent && canSTK && (
                      <div style={{ fontSize: 12, color: "var(--green)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                        ✓ Prompt sent — client will receive a pop-up to enter their PIN
                      </div>
                    )}
                  </div>

                  {/* M-Pesa reference */}
                  <div>
                    <label className="settings-label" style={{ marginBottom: 6, display: "block" }}>M-Pesa reference (optional)</label>
                    <input style={inp} placeholder="e.g. RHJ4KL9X" value={form.txnRef} onChange={set("txnRef")} />
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div style={{ fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "10px 14px" }}>✕ {error}</div>}
        </div>

        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !selected || totalAmount <= 0 || selectedFeeTypes.length === 0}
            style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: (!saving && selected && totalAmount > 0 && selectedFeeTypes.length > 0) ? "var(--green)" : "var(--surface2)", border: "none", color: (!saving && selected && totalAmount > 0 && selectedFeeTypes.length > 0) ? "#0b1a14" : "var(--text3)", cursor: (!saving && selected && totalAmount > 0 && selectedFeeTypes.length > 0) ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
            {saving ? "Saving…" : `Save — KES ${totalAmount.toLocaleString()}`}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Payments Page ─────────────────────────────────────────────────────────────
export default function Payments() {
  const { token, user } = useAuth();
  const { openSidebar } = useOutletContext();

  const payments       = useAppStore(s => s.payments);
  const unmatched      = useAppStore(s => s.unmatched);
  const paymentsLoaded = useAppStore(s => s.paymentsLoaded);
  const students       = useAppStore(s => s.students);

  const [showModal,     setShowModal]     = useState(false);
  const [deleteTarget,  setDeleteTarget]  = useState(null);
  const [page,          setPage]          = useState(1);
  const [assignTarget,  setAssignTarget]  = useState(null);
  const [search,        setSearch]        = useState("");
  // Only the 3 real methods — no Manual filter
  const [methodFilter,  setMethodFilter]  = useState("all");
  const [dateFilter,    setDateFilter]    = useState("all");
  const [studentFilter, setStudentFilter] = useState("all");

  const now = Date.now();
  const filtered = useMemo(() => payments.filter(p => {
    const matchSearch  = !search || p.name?.toLowerCase().includes(search.toLowerCase()) || p.txn?.toLowerCase().includes(search.toLowerCase());
    // treat "manual" as cash for display filter purposes
    const method = (p.method || "cash").toLowerCase() === "manual" ? "cash" : (p.method || "cash").toLowerCase();
    const matchMethod  = methodFilter === "all" || method === methodFilter;
    const ts           = p.createdAt ? new Date(p.createdAt).getTime() : 0;
    const matchDate    = dateFilter === "all" ? true : dateFilter === "today" ? ts > now - 86400000 : dateFilter === "week" ? ts > now - 7 * 86400000 : ts > now - 30 * 86400000;
    const matchStudent = studentFilter === "all" || p.studentId === studentFilter || p.name === studentFilter;
    return matchSearch && matchMethod && matchDate && matchStudent;
  }), [payments, search, methodFilter, dateFilter, studentFilter, now]);

  const totalFiltered = useMemo(() => filtered.reduce((s, p) => {
    const n = typeof p.amount === "string" ? parseFloat(p.amount.replace(/[^0-9.]/g, "")) || 0 : p.amount || 0;
    return s + n;
  }, 0), [filtered]);

  // Reset to page 1 when filters change
  const filteredLen = filtered.length;
  const totalPages  = Math.ceil(filteredLen / PAGE_SIZE);
  const paginated   = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

  // auto-reset page when filters change
  const prevFilterKey = useMemo(() => search + methodFilter + dateFilter + studentFilter, [search, methodFilter, dateFilter, studentFilter]);
  useEffect(() => { setPage(1); }, [prevFilterKey]);

  const studentsWithPayments = useMemo(() => {
    const ids = new Set(payments.map(p => p.studentId).filter(Boolean));
    return students.filter(s => ids.has(s.id));
  }, [payments, students]);

  return (
    <>
      <Topbar title="Payments" sub="All recorded payments" onMenuClick={openSidebar}>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Manual</button>
      </Topbar>

      <div className="page-content">
        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)" }}><SearchIcon /></span>
            <input style={{ width: "100%", paddingLeft: 34, paddingRight: 12, height: 40, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} placeholder="Search by name or ref…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          {/* Per-student filter */}
          <select value={studentFilter} onChange={e => setStudentFilter(e.target.value)} style={{ height: 40, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 9, padding: "0 12px", fontSize: 13.5, minWidth: 160, fontFamily: "inherit" }}>
            <option value="all">All students</option>
            {studentsWithPayments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>

          {/* Method filter — 3 options only, no Manual */}
          {["all", "mpesa", "bank", "cash"].map(m => (
            <button key={m} onClick={() => setMethodFilter(m)} style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", background: methodFilter === m ? "var(--blue-bg)" : "var(--surface2)", border: `1px solid ${methodFilter === m ? "var(--blue-border)" : "var(--border)"}`, color: methodFilter === m ? "var(--blue)" : "var(--text2)" }}>
              {m === "all" ? "All" : m === "mpesa" ? "M-Pesa" : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Date + summary */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {["all", "today", "week", "month"].map(d => (
            <button key={d} onClick={() => setDateFilter(d)} style={{ padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", background: dateFilter === d ? "var(--blue-bg)" : "var(--surface2)", border: `1px solid ${dateFilter === d ? "var(--blue-border)" : "var(--border)"}`, color: dateFilter === d ? "var(--blue)" : "var(--text2)" }}>
              {d === "all" ? "All time" : d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
          {filtered.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11.5, color: "var(--text3)" }}>{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
              {totalFiltered > 0 && <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: "var(--green-bg)", border: "1px solid var(--green-border)", color: "var(--green)" }}>KES {totalFiltered.toLocaleString()}</span>}
            </div>
          )}
        </div>

        {/* Payments list */}
        <div className="card">
          <div className="card-head">
            <div><div className="card-title">All Payments</div><div className="card-sub">Most recent first · hover for actions</div></div>
          </div>
          <div className="card-body-flush">
            {!paymentsLoaded ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "48px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>💳</div>
                <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500, marginBottom: 6 }}>
                  {search || methodFilter !== "all" ? "No payments match your filters" : "No payments recorded yet"}
                </div>
                <div style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer" }} onClick={() => { setSearch(""); setMethodFilter("all"); setStudentFilter("all"); }}>
                  {search || methodFilter !== "all" ? "Clear filters" : "Add manual payment →"}
                </div>
              </div>
            ) : paginated.map((p, i) => (
              <div key={p.id || i}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: i < paginated.length - 1 ? "1px solid var(--border)" : "none", transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: "var(--green-bg)", border: "1px solid var(--green-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--green)" }}><PayIcon /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{p.meta}</span>
                    {p.txn && p.txn !== "—" && <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", flexShrink: 0 }}>{p.txn}</span>}
                    {p.feeBreakdown?.length > 0 && p.feeBreakdown.map((fb, fi) => <span key={fi} style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 4, background: "var(--surface3)", border: "1px solid var(--border)", color: "var(--text3)" }}>{fb.typeName}</span>)}
                  </div>
                </div>
                <MethodBadge method={p.method === "manual" ? "cash" : p.method} />
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>+{p.amount}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                </div>
                {/* Print receipt */}
                <button onClick={e => { e.stopPropagation(); printReceipt(p, user?.schoolName); }} title="Print receipt"
                  style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: "transparent", border: "1px solid transparent", color: "var(--text3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--blue-bg)"; e.currentTarget.style.borderColor = "var(--blue-border)"; e.currentTarget.style.color = "var(--blue)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text3)"; }}>
                  <PrintIcon />
                </button>
                {/* Delete */}
                <button onClick={e => { e.stopPropagation(); setDeleteTarget(p); }} title="Delete payment"
                  style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: "transparent", border: "1px solid transparent", color: "var(--text3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--red-bg)"; e.currentTarget.style.borderColor = "var(--red-border)"; e.currentTarget.style.color = "var(--red)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text3)"; }}>
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={p => { setPage(p); window.scrollTo(0,0); }} total={filteredLen} perPage={PAGE_SIZE} />
        </div>

        {/* Unmatched */}
        {paymentsLoaded && unmatched.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "24px 0 16px" }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", padding: "4px 14px", borderRadius: 20, whiteSpace: "nowrap" }}>⚠ Unmatched Payments — Action Required</div>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
            <div className="card">
              <div className="card-head">
                <div><div className="card-title" style={{ color: "var(--amber)" }}>Unmatched M-Pesa Payments</div><div className="card-sub">Could not be linked to a student — assign manually</div></div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 20, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", color: "var(--amber)" }}>{unmatched.length} pending</span>
              </div>
              <div className="card-body-flush">
                {unmatched.map((p, i) => (
                  <div key={p.id || i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: i < unmatched.length - 1 ? "1px solid var(--border)" : "none", flexWrap: "wrap" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--amber)" }}><QIcon /></div>
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--amber)", marginBottom: 2 }}>Unknown Sender</div>
                      <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        Phone: {p.phone}
                        {p.txn && p.txn !== "—" && <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--amber-bg)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--amber-border)", color: "var(--amber)" }}>{p.txn}</span>}
                      </div>
                    </div>
                    <button onClick={() => setAssignTarget(p)}
                      style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", minHeight: 36, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", color: "var(--amber)", transition: "all .15s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "var(--amber)"; e.currentTarget.style.color = "#0b1a14"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "var(--amber-bg)"; e.currentTarget.style.color = "var(--amber)"; }}>
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

      {showModal    && <AddPaymentModal    onClose={() => setShowModal(false)} />}
      {deleteTarget && <DeleteConfirmModal payment={deleteTarget} token={token} onClose={() => setDeleteTarget(null)} />}
      {assignTarget && <AssignModal        payment={assignTarget} token={token} onClose={() => setAssignTarget(null)} />}

      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}