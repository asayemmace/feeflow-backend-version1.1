import { useState, useMemo, useEffect, useCallback } from "react";
import axios from "axios";
import { useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import { useFeeStructure } from "../hooks/useFeeStructure";
import useAppStore from "../store/useAppStore";
import Pagination from "../components/Pagination";
import { Landmark, UploadCloud } from "lucide-react";
import analytics from "../analytics/analytics";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";
const PAGE_SIZE = 50;

// Inject pulse animation for STK waiting state (once, on first render)
if (typeof document !== "undefined" && !document.getElementById("ff-pulse-style")) {
  const s = document.createElement("style");
  s.id = "ff-pulse-style";
  s.textContent = "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}";
  document.head.appendChild(s);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const SearchIcon = () => <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>;
const PayIcon   = () => <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/></svg>;
const QIcon     = () => <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>;
const TrashIcon = () => <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>;
const PrintIcon = () => <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>;
const LockIcon  = () => <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>;

const statusTone = {
  FULL: { color: "var(--green)", bg: "var(--green-bg)", border: "var(--green-border)" },
  PARTIAL: { color: "var(--blue)", bg: "var(--blue-bg)", border: "var(--blue-border)" },
  OVERPAYMENT: { color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
  DUPLICATE: { color: "var(--red)", bg: "var(--red-bg)", border: "var(--red-border)" },
  UNMATCHED: { color: "var(--text3)", bg: "var(--surface2)", border: "var(--border)" },
  NEEDS_REVIEW: { color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
  UNDER_REVIEW: { color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
  CONFIRMED: { color: "var(--green)", bg: "var(--green-bg)", border: "var(--green-border)" },
  REJECTED: { color: "var(--red)", bg: "var(--red-bg)", border: "var(--red-border)" },
};

const StatusPill = ({ status }) => {
  const tone = statusTone[status] || statusTone.NEEDS_REVIEW;
  return <span style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color, whiteSpace: "nowrap" }}>{status}</span>;
};

const MethodBadge = ({ method }) => {
  const c = {
    mpesa: { label: "M-Pesa", color: "var(--green)", bg: "var(--green-bg)", border: "var(--green-border)" },
    bank:  { label: "Bank",   color: "var(--blue)",  bg: "var(--blue-bg)",  border: "var(--blue-border)"  },
    cash:  { label: "Cash",   color: "var(--amber)", bg: "var(--amber-bg)", border: "var(--amber-border)" },
  }[method?.toLowerCase()] || { label: method || "—", color: "var(--text3)", bg: "var(--surface2)", border: "var(--border)" };
  return <span style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: c.bg, border: `1px solid ${c.border}`, color: c.color, flexShrink: 0 }}>{c.label}</span>;
};

const inp = { width: "100%", padding: "10px 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

function fmtMoney(value) {
  return Number(value || 0).toLocaleString();
}

function fmtDateTime(value) {
  return value ? new Date(value).toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function normalizeDisplayMpesaPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return "254" + digits;
  return "";
}

function isSha256Hex(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

function unmatchedRaw(p) {
  return p?.rawSafaricomMetadata && typeof p.rawSafaricomMetadata === "object"
    ? p.rawSafaricomMetadata
    : {};
}

function unmatchedSenderName(p) {
  const raw = unmatchedRaw(p);
  const fullName = [raw.FirstName, raw.MiddleName, raw.LastName]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return fullName || String(p?.senderName || p?.payerName || "").trim() || "Unknown Sender";
}

function unmatchedPhone(p) {
  const raw = unmatchedRaw(p);
  const phoneStr = p?.phone != null && !isSha256Hex(p.phone) ? String(p.phone) : "";
  const msisdnStr = raw.MSISDN != null ? String(raw.MSISDN) : "";
  return normalizeDisplayMpesaPhone(phoneStr || msisdnStr);
}

function unmatchedPhoneHiddenByProvider(p) {
  const raw = unmatchedRaw(p);
  return Boolean(p?.phoneHiddenByProvider || isSha256Hex(p?.phone) || isSha256Hex(raw.MSISDN) || isSha256Hex(raw.payerIdentifierHash));
}

function unmatchedPhoneLabel(p) {
  return unmatchedPhone(p) || (unmatchedPhoneHiddenByProvider(p) ? "Phone hidden by provider" : "No phone");
}

function unmatchedTxn(p) {
  const raw = unmatchedRaw(p);
  return String(p?.txn || raw.TransID || "").trim();
}

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

async function errorMessageFromBlobResponse(error, fallback) {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      const json = JSON.parse(text);
      return json.message || json.error || fallback;
    } catch {
      return fallback;
    }
  }
  return error?.response?.data?.message || error?.response?.data?.error || fallback;
}

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
  analytics.track("receipt_downloaded", {
    paymentId: payment.id,
    amount: typeof payment.amount === "string" ? parseFloat(payment.amount.replace(/[^0-9.]/g, "")) || null : payment.amount,
    paymentMethod: payment.method,
    studentId: payment.studentId,
  });
  setTimeout(() => win.print(), 400);
}

// ─── Reversal Modal (replaces DeleteConfirmModal) ─────────────────────────────
// Accounting-safe: never hard-deletes. Shows "Reverse" language to accountants
// who understand that the record is preserved, just neutralised.
function DeleteConfirmModal({ payment, onClose, token }) {
  const updateStudent = useAppStore(s => s.updateStudent);
  const updatePayment = useAppStore(s => s.updatePayment);
  const students      = useAppStore(s => s.students);
  const refreshStats   = useAppStore(s => s.refreshStats);
  const refreshStudents = useAppStore(s => s.refreshStudents);
  const [deleting, setDeleting] = useState(false);
  const [error,    setError]    = useState("");
  const [reason,   setReason]   = useState("");

  const handleDelete = async () => {
    setDeleting(true); setError("");
    try {
      const res = await axios.delete(`${API}/api/payments/${payment.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        data:    { reason: reason.trim() || undefined },
      });
      // Update the store: mark payment as reversed (don't remove it — it's still in history)
      if (updatePayment) {
        updatePayment({ ...payment, reversedAt: new Date().toISOString() });
      }
      const student = students.find(s => s.id === payment.studentId);
      if (student) {
        const amt = typeof payment.amount === "string" ? parseFloat(payment.amount.replace(/[^0-9.]/g, "")) : payment.amount || 0;
        if (res.data?.updatedStudent) updateStudent({ ...student, ...res.data.updatedStudent });
      }
      refreshStats(token);
      onClose();
    } catch (e) {
      const msg = e.response?.data?.message || "Failed to reverse payment.";
      setError(msg);
    }
    finally { setDeleting(false); }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div className="responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 420, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", padding: 24, animation: "modalIn .18s ease" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--red-bg)", border: "1px solid var(--red-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--red)", flexShrink: 0 }}><TrashIcon /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Reverse Payment?</div>
            <div style={{ fontSize: 12.5, color: "var(--text3)", marginTop: 2 }}>The record is preserved — the balance will be corrected</div>
          </div>
        </div>
        <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 4 }}>{payment.name}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 6 }}>{payment.meta}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--red)", fontVariantNumeric: "tabular-nums" }}>{payment.amount}</div>
          <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 3 }}>{payment.time}</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: .5, display: "block", marginBottom: 6 }}>Reversal reason (optional)</label>
          <input
            style={{ width: "100%", padding: "9px 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
            placeholder="e.g. Duplicate entry, wrong amount…"
            value={reason} onChange={e => setReason(e.target.value)} maxLength={120}
          />
        </div>
        <div style={{ fontSize: 12.5, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>
          ⚠ The original payment record is kept for audit purposes. The student's balance will be adjusted.
        </div>
        {error && <div style={{ fontSize: 12.5, color: "var(--red)", marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleDelete} disabled={deleting} style={{ padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: deleting ? "var(--surface2)" : "var(--red)", border: "none", color: deleting ? "var(--text3)" : "#fff", cursor: deleting ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {deleting ? "Reversing…" : "Reverse payment"}
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
      const res = await axios.post(`${API}/api/payments/unmatched/${payment.id}/assign`, { studentId: selected.id }, { headers: { Authorization: `Bearer ${token}` } });
      removeUnmatched(payment.id);
      const rawAmt = payment.rawAmount || (typeof payment.amount === "string" ? parseFloat(payment.amount.replace(/[^0-9.]/g, "")) : payment.amount || 0);
      if (res.data?.updatedStudent) updateStudent({ ...selected, ...res.data.updatedStudent });
      analytics.track("payment_matched", {
        amount: rawAmt,
        paymentMethod: "mpesa",
        studentId: selected.id,
        unmatchedPaymentId: payment.id,
      });
      refreshStats(token);
      onClose();
    } catch (e) {
      analytics.track("payment_matching_failed", {
        unmatchedPaymentId: payment.id,
        studentId: selected?.id,
        status: e.response?.status || null,
      });
      setError(e.response?.data?.message || "Failed to assign payment.");
    }
    finally { setAssigning(false); }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div className="responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 460, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", maxHeight: "80vh", animation: "modalIn .18s ease" }}>
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
              <div style={{ fontSize: 12, color: "var(--text3)" }}>
                {unmatchedSenderName(payment)} · Phone: {unmatchedPhoneLabel(payment)} · Ref: {unmatchedTxn(payment) || "—"}
              </div>
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
              const balance = s.outstanding ?? 0;
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
  const refreshStudents = useAppStore(s => s.refreshStudents);
  const refreshPayments = useAppStore(s => s.refreshPayments);

  const [classFilter,      setClassFilter]      = useState("all");
  const [search,           setSearch]           = useState("");
  const [selected,         setSelected]         = useState(null);
  const [selectedFeeTypes, setSelectedFeeTypes] = useState([]);
  const [feeAmounts,       setFeeAmounts]       = useState({});
  const [othersLabel,      setOthersLabel]      = useState("");
  const [form,             setForm]             = useState({ phone: "", txnRef: "", method: "mpesa" });
  const [bankRef,          setBankRef]          = useState("");
  const [saving,           setSaving]           = useState(false);
  const [stkLoading,       setStkLoading]       = useState(false);
  // stkState tracks the full M-Pesa flow: null | "sending" | "awaiting" | "polling" | "success" | "failed" | "cancelled" | "insufficient" | "timeout" | "in_flight"
  const [stkState,         setStkState]         = useState(null);
  const [stkMsg,           setStkMsg]           = useState("");
  const [stkCheckoutId,    setStkCheckoutId]    = useState(null);
  const [stkMerchantId,    setStkMerchantId]    = useState(null);
  const [stkPendingId,     setStkPendingId]     = useState(null);
  const [stkPollTimer,     setStkPollTimer]     = useState(null);
  const [overpayWarning,   setOverpayWarning]   = useState(null);
  const [error,            setError]            = useState("");
  const [showErrors,       setShowErrors]       = useState(false);
  const closeAfterSuccessRef = useRef(null);

  const canSTK = canUse?.("mpesa");

  // Clear polling timer on unmount
  useEffect(() => {
    return () => {
      if (stkPollTimer) clearInterval(stkPollTimer);
      if (closeAfterSuccessRef.current) clearTimeout(closeAfterSuccessRef.current);
    };
  }, [stkPollTimer]);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleClose = () => {
    setBankRef("");
    setShowErrors(false);
    onClose();
  };

  const handleMethodChange = method => {
    setForm(f => ({ ...f, method }));
    setBankRef("");
    setShowErrors(false);
  };

  const selectStudent = s => {
    setSelected(s);
    setSelectedFeeTypes([]);
    setFeeAmounts({});
    setOthersLabel("");
    setStkState(null);
    setStkMsg("");
    setStkCheckoutId(null);
    setStkMerchantId(null);
    setStkPendingId(null);
    setShowErrors(false);
    if (stkPollTimer) { clearInterval(stkPollTimer); setStkPollTimer(null); }
    if (closeAfterSuccessRef.current) { clearTimeout(closeAfterSuccessRef.current); closeAfterSuccessRef.current = null; }
  };

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

  const formatStkError = (data) => {
    if (!data) return "STK push failed.";
    const details = [
      data.errorCode ? `errorCode: ${data.errorCode}` : null,
      data.errorMessage ? `errorMessage: ${data.errorMessage}` : null,
      data.ResponseCode ? `ResponseCode: ${data.ResponseCode}` : null,
      data.ResponseDescription ? `ResponseDescription: ${data.ResponseDescription}` : null,
    ].filter(Boolean);
    return details.length ? details.join(" | ") : (data.message || "STK push failed.");
  };

  const totalAmount    = selectedFeeTypes.reduce((s, id) => s + (parseInt(feeAmounts[id], 10) || 0), 0);
  const classes        = [...new Set(students.map(s => s.cls))].sort();
  const filteredStu    = students
    .filter(s => classFilter === "all" || s.cls === classFilter)
    .filter(s => !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.adm?.toLowerCase().includes(search.toLowerCase()));
  // Use ledger-derived outstanding if available from store (set by updatedStudent on payment)
  const balance        = selected ? (selected.outstanding ?? 0) : 0;
  
  // Normalize phone to 254XXXXXXXXXXX format (2547 or 2541)
  const normalizePhone = (p) => {
    const clean = String(p || "").replace(/\D/g, "");
    if (clean.startsWith("254")) return clean;
    if (clean.startsWith("0")) return "254" + clean.slice(1);
    if (clean.match(/^[17]\d{8}$/)) return "254" + clean;
    return "";
  };
  
  const phoneClean     = form.phone.replace(/\D/g, "");
  const phoneValid     = /^(?:0[17]\d{8}|[17]\d{8}|254[17]\d{8})$/.test(phoneClean);
  const phoneNormalized = normalizePhone(form.phone);
  const stkButtonEnabled =
    canSTK &&
    phoneValid &&
    !stkLoading &&
    totalAmount > 0 &&
    !["awaiting", "sending", "in_flight"].includes(stkState);
  
  if (import.meta.env.DEV && form.phone) {
    console.log("[STK Phone Debug]", {
      raw: form.phone,
      clean: phoneClean,
      normalized: phoneNormalized,
      valid: phoneValid,
    });
  }
  
  const selectedOthers = selectedFeeTypes.includes("others");

  const hasRequiredReference = () => {
    if (form.method === "mpesa") {
      if (stkState === "success") return true;
      return form.txnRef.trim().length > 0;
    }
    if (form.method === "bank") {
      return bankRef.trim().length > 0;
    }
    if (form.method === "cash") return true;
    return false;
  };

  const canSave = () => (
    !!selected &&
    totalAmount > 0 &&
    selectedFeeTypes.length > 0 &&
    hasRequiredReference()
  );

  const saveButtonEnabled = !saving && stkState !== "success" && canSave();
  const referenceErrorsVisible = showErrors || (!!selected && selectedFeeTypes.length > 0 && !hasRequiredReference());

  const handleSave = async (confirmOverpayment = false) => {
    if (stkState === "success") return setError("This STK payment is already confirmed.");
    if (!selected)                     return setError("Select a student.");
    if (totalAmount <= 0)              return setError("Enter a valid amount for at least one fee type.");
    if (selectedFeeTypes.length === 0) return setError("Select at least one fee type.");
    if (!hasRequiredReference()) {
      setShowErrors(true);
      return;
    }
    if (selectedOthers && !othersLabel.trim()) return setError("Specify the 'Others' description.");
    setShowErrors(false);
    setSaving(true); setError("");
    try {
      const feeBreakdown = selectedFeeTypes.map(id => ({
        typeId: id,
        typeName: id === "others" ? othersLabel : feeTypes.find(ft => ft.id === id)?.name || id,
        amount: parseInt(feeAmounts[id], 10) || 0,
      }));
      const res = await axios.post(`${API}/api/payments`,
        {
          studentId: selected.id, amount: totalAmount, txnRef: null,
          method: form.method, feeBreakdown, confirmOverpayment,
          ...(form.method === "bank" && bankRef.trim() ? { txnRef: bankRef.trim() } : {}),
          ...(form.method === "mpesa" && form.txnRef.trim() ? { txnRef: form.txnRef.trim() } : {}),
          // Send the student version we loaded — server will reject if another cashier
          // saved a payment between when we loaded the student and now (409 conflict).
          clientVersion: selected.version,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.data?.requiresConfirmation) {
        setOverpayWarning(res.data);
        setSaving(false);
        return;
      }
      addPayment(res.data);
      analytics.track("payment_received", {
        amount: Number(res.data?.rawAmount || totalAmount),
        paymentMethod: form.method,
        studentId: selected.id,
      });
      // updatedStudent from server contains ledger-derived paid/outstanding/fee — use directly
      updateStudent({ ...selected, ...res.data.updatedStudent });
      await Promise.all([refreshStats(token), refreshStudents(token), refreshPayments(token)]);
      window.dispatchEvent(new CustomEvent("ff:student-profile-refresh", { detail: { studentId: selected.id } }));
      // Show overpayment warning before closing (accountant should be aware)
      if (res.data.overpayment) {
        setError(`✓ Saved payment of KES ${Number(res.data.rawAmount || totalAmount).toLocaleString()} — ${res.data.overpayment.message}`);
        setSaving(false);
        setTimeout(handleClose, 4000); // give them time to read the warning
        return;
      }
      setError(`✓ Saved payment of KES ${Number(res.data.rawAmount || totalAmount).toLocaleString()}.`);
      setSaving(false);
      setTimeout(handleClose, 900);
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.conflict) {
        // Cashier conflict: another payment was saved between load and submit
        setError("⚠ Conflict: " + (e.response.data.message || "Another payment was saved for this student. The record has been refreshed — please review and try again."));
        // Refresh the student in the store so the cashier sees fresh data
        const freshStudents = await axios.get(`${API}/api/students`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
        if (freshStudents?.data) {
          const fresh = (Array.isArray(freshStudents.data) ? freshStudents.data : freshStudents.data.data || []).find(s => s.id === selected.id);
          if (fresh) { updateStudent(fresh); setSelected(fresh); }
        }
      } else {
        setError(e.response?.data?.message || "Failed to save.");
      }
    }
    finally { setSaving(false); }
  };

  const handleSTK = async () => {
    if (!phoneValid || !selected || totalAmount <= 0 || !canSTK) return;
    // Prevent double-click during sending
    if (stkLoading || stkState === "awaiting" || stkState === "polling") return;

    setStkLoading(true);
    setStkState("sending");
    setStkMsg("");
    setError("");

    try {
      const res = await axios.post(
        `${API}/api/payments/stk`,
        { studentId: selected.id, amount: totalAmount, phone: phoneNormalized },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (res.data.success) {
        const checkoutRequestId = res.data.CheckoutRequestID || res.data.checkoutRequestId;
        analytics.track("stk_push_started", {
          amount: totalAmount,
          studentId: selected.id,
          checkoutRequestId,
        });
        setStkCheckoutId(checkoutRequestId);
        setStkMerchantId(res.data.MerchantRequestID || null);
        setStkPendingId(res.data.pendingPaymentId || res.data.mpesaTransactionId || null);
        setStkState("awaiting");
        // Show outage warning inline if Safaricom is degraded
        const baseMsg = "M-Pesa request sent. Ask the client to check their phone and enter their PIN.";
        const degradeMsg = res.data.degraded ? " Note: M-Pesa is experiencing delays — confirmation may take longer than usual." : "";
        setStkMsg(baseMsg + degradeMsg);
        startAdminPolling(checkoutRequestId);
      }
    } catch (e) {
      const msg  = formatStkError(e.response?.data);
      const code = e.response?.status;
      if (code === 409 || e.response?.data?.inFlight) {
        setStkState("in_flight");
        setStkMsg("A payment is already in progress for this student. Wait for confirmation before sending another.");
      } else {
        setStkState("failed");
        setStkMsg(msg);
        setError(msg);
      }
      analytics.track("stk_push_failed", {
        amount: totalAmount,
        studentId: selected?.id,
        status: code || null,
        reason: msg,
      });
    } finally {
      setStkLoading(false);
    }
  };

  // Poll the checkout status while waiting for Safaricom callback.
  const startAdminPolling = (checkoutRequestId) => {
    if (!checkoutRequestId) return;
    if (stkPollTimer) clearInterval(stkPollTimer);
    const startedAt = Date.now();

    const timer = setInterval(async () => {
      if (Date.now() - startedAt > 90_000) {
        clearInterval(timer);
        setStkPollTimer(null);
        setStkState("timeout");
        setStkMsg("No confirmation received within 90 seconds. Check M-Pesa messages before retrying.");
        analytics.track("stk_push_failed", {
          amount: totalAmount,
          studentId: selected?.id,
          checkoutRequestId,
          status: "TIMEOUT",
          reason: "No confirmation received within 90 seconds.",
        });
        return;
      }
      try {
        const res = await axios.get(`${API}/api/payments/stk/status/${checkoutRequestId}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = res.data || {};
        if (data.status === "SUCCESS") {
          clearInterval(timer);
          setStkPollTimer(null);
          if (data.updatedStudent) updateStudent({ ...(selected || {}), ...data.updatedStudent });
          setStkState("success");
          setStkMsg("Payment confirmed");
          analytics.track("stk_push_success", {
            amount: data.amount || totalAmount,
            studentId: selected?.id,
            checkoutRequestId,
          });
          await Promise.all([refreshPayments(token), refreshStudents(token), refreshStats(token)]);
          closeAfterSuccessRef.current = setTimeout(() => {
            closeAfterSuccessRef.current = null;
            handleClose();
          }, 1000);
          return;
        }
        if (["FAILED", "CANCELLED", "TIMEOUT"].includes(data.status)) {
          clearInterval(timer);
          setStkPollTimer(null);
          const msg = data.message || (
            data.status === "CANCELLED" ? "Payment was cancelled on the phone." :
            data.status === "TIMEOUT" ? "M-Pesa request timed out. Please try again." :
            "M-Pesa payment failed. Please try again."
          );
          setStkState(data.status.toLowerCase());
          setStkMsg(msg);
          setError(msg);
          analytics.track("stk_push_failed", {
            amount: totalAmount,
            studentId: selected?.id,
            checkoutRequestId,
            status: data.status,
            reason: msg,
          });
        }
      } catch { /* silent — keep polling */ }
    }, 2500);
    setStkPollTimer(timer);
  };

  return (
    <>
      <div className="modal-backdrop" onClick={handleClose} />
      <div className="modal-box" style={{ maxWidth: 540 }}>
        {overpayWarning && (
          <>
            <div className="modal-backdrop" style={{ zIndex: 75 }} onClick={() => setOverpayWarning(null)} />
            <div className="modal-box" style={{ maxWidth: 420, zIndex: 80 }}>
              <div className="modal-header">
                <div><div className="modal-title">Confirm overpayment</div><div className="modal-sub">This payment is more than the student owes.</div></div>
                <button className="modal-close" onClick={() => setOverpayWarning(null)}>×</button>
              </div>
              <div style={{ padding: 20, fontSize: 13.5, color: "var(--text2)", lineHeight: 1.6 }}>
                This payment is KES {Number(overpayWarning.overpayAmount || 0).toLocaleString()} more than the student owes. Proceed and save extra as credit?
              </div>
              <div style={{ padding: "14px 20px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button className="btn btn-outline" onClick={() => setOverpayWarning(null)} disabled={saving}>Change amount</button>
                <button className="btn btn-primary" onClick={() => { setOverpayWarning(null); handleSave(true); }} disabled={saving}>{saving ? "Saving..." : "Proceed anyway"}</button>
              </div>
            </div>
          </>
        )}
        <div className="modal-header">
          <div><div className="modal-title">Record Payment</div><div className="modal-sub">Pick student, select fee types, then save</div></div>
          <button className="modal-close" onClick={handleClose}>×</button>
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
                  const bal   = s.outstanding ?? 0;
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
                    <button key={m} onClick={() => handleMethodChange(m)} style={{ flex: 1, padding: "9px 0", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s", border: `1px solid ${form.method === m ? "var(--green)" : "var(--border)"}`, background: form.method === m ? "var(--green-bg)" : "var(--surface2)", color: form.method === m ? "var(--green)" : "var(--text2)" }}>
                      {m === "mpesa" ? "M-Pesa" : m.charAt(0).toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {form.method === "bank" && (
                <div className="field-group">
                  <label className="settings-label" style={{ marginBottom: 6, display: "block" }}>
                    Transaction Reference <span style={{ color: "var(--red)" }}>*</span>
                  </label>
                  <input
                    style={inp}
                    type="text"
                    placeholder="e.g. TRF2025051400123"
                    value={bankRef}
                    onChange={e => setBankRef(e.target.value)}
                  />
                  {referenceErrorsVisible && form.method === "bank" && !bankRef.trim() && (
                    <span className="field-error">
                      Transaction reference is required for bank payments
                    </span>
                  )}
                </div>
              )}

              {/* M-Pesa fields — always shown when mpesa selected, locked for free plan */}
              {form.method === "mpesa" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* STK Push section */}
                  <div style={{
                    background: "var(--surface2)",
                    border: `1px solid ${stkState === "success" ? "var(--green-border)" : stkState && ["failed","timeout","cancelled","insufficient"].includes(stkState) ? "var(--red-border)" : stkState === "awaiting" || stkState === "polling" ? "var(--amber-border)" : "var(--border)"}`,
                    borderRadius: 10, padding: "14px", transition: "border-color .2s"
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: canSTK ? "var(--text)" : "var(--text3)", display: "flex", alignItems: "center", gap: 6 }}>
                          {!canSTK && <span style={{ color: "var(--amber)" }}><LockIcon /></span>}
                          STK Push
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>
                          {canSTK
                            ? "Client receives a prompt on their phone to enter their M-Pesa PIN"
                            : "Upgrade to Pro to send STK push prompts directly to parents' phones"
                          }
                        </div>
                      </div>
                      {!canSTK && (
                        <a href="mailto:feeflow254@gmail.com?subject=FeeFlow Pro Upgrade" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 7, fontSize: 11.5, fontWeight: 600, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", color: "var(--amber)", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}>
                          🔒 Upgrade to Pro
                        </a>
                      )}
                    </div>

                    {/* Phone input + send button */}
                    <div style={{ display: "flex", gap: 8, opacity: canSTK ? 1 : 0.45, pointerEvents: canSTK ? "auto" : "none" }}>
                      <input
                        style={{ ...inp, flex: 1, cursor: canSTK ? "text" : "not-allowed" }}
                        placeholder="0701475742, 0112345678, or 254..."
                        value={form.phone}
                        onChange={canSTK ? set("phone") : undefined}
                        readOnly={!canSTK || stkState === "awaiting"}
                        tabIndex={canSTK ? 0 : -1}
                      />
                      <button
                        onClick={canSTK ? handleSTK : undefined}
                        disabled={!stkButtonEnabled}
                        style={{
                          padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                          fontFamily: "inherit", whiteSpace: "nowrap", transition: "all .15s",
                          cursor: stkButtonEnabled ? "pointer" : "not-allowed",
                          background: stkButtonEnabled ? "#2563eb" : "#1e293b",
                          border: `1px solid ${stkButtonEnabled ? "#2563eb" : "#1e293b"}`,
                          color: stkButtonEnabled ? "#ffffff" : "#64748b",
                          opacity: stkButtonEnabled ? 1 : 0.6,
                          boxShadow: "none",
                        }}
                      >
                        {stkState === "sending"  ? "Sending…"    :
                         stkState === "awaiting" ? "Waiting…"    :
                         stkState === "success"  ? "✓ Confirmed" :
                         stkState && ["failed","timeout","cancelled","insufficient","in_flight"].includes(stkState) ? "Send Again" :
                         "Send STK Push"}
                      </button>
                    </div>

                    {/* State-aware status banner */}
                    {canSTK && stkState && stkMsg && (
                      <div style={{
                        marginTop: 10, fontSize: 12, borderRadius: 7, padding: "9px 12px",
                        display: "flex", alignItems: "flex-start", gap: 7,
                        background: stkState === "success"  ? "var(--green-bg)"  :
                                    stkState === "awaiting" ? "rgba(245,158,11,0.08)" :
                                    stkState === "in_flight"? "rgba(245,158,11,0.08)" :
                                    "var(--red-bg)",
                        border: `1px solid ${
                                    stkState === "success"  ? "var(--green-border)"  :
                                    stkState === "awaiting" || stkState === "in_flight" ? "var(--amber-border)" :
                                    "var(--red-border)"}`,
                        color: stkState === "success"  ? "var(--green)"  :
                               stkState === "awaiting" || stkState === "in_flight" ? "var(--amber)" :
                               "var(--red)",
                      }}>
                        <span style={{ flexShrink: 0, marginTop: 1 }}>
                          {stkState === "success"  ? "✓" :
                           stkState === "awaiting" || stkState === "in_flight" ? "⏳" :
                           "✕"}
                        </span>
                        <span>{stkMsg}</span>
                      </div>
                    )}

                    {/* Waiting pulse animation */}
                    {stkState === "awaiting" && (
                      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text3)" }}>
                        <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--amber)", animation: "pulse 1.4s ease-in-out infinite" }} />
                        Waiting for client to enter PIN on their phone…
                      </div>
                    )}
                  </div>

                  {/* M-Pesa reference — auto-fills from confirmed payment, or manual entry */}
                  <div>
                    <label className="settings-label" style={{ marginBottom: 6, display: "block" }}>
                      M-Pesa reference
                      <span style={{ fontSize: 11, fontWeight: 600, color: stkState === "success" ? "var(--text3)" : "var(--red)", textTransform: "none", marginLeft: 6 }}>
                        {stkState === "success" ? "auto-filled after STK confirmation" : "Required"}
                      </span>
                    </label>
                    <input style={inp} placeholder="Required for manual M-Pesa payments" value={form.txnRef} onChange={set("txnRef")} />
                    {referenceErrorsVisible && form.method === "mpesa" && stkState !== "success" && !form.txnRef.trim() && (
                      <span className="field-error">
                        M-Pesa reference is required for manual payments
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div style={{ fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "10px 14px" }}>✕ {error}</div>}
        </div>

        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={handleClose} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={() => handleSave(false)} disabled={!saveButtonEnabled}
            style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: saveButtonEnabled ? "var(--green)" : "var(--surface2)", border: "none", color: saveButtonEnabled ? "#0b1a14" : "var(--text3)", cursor: saveButtonEnabled ? "pointer" : "not-allowed", opacity: saveButtonEnabled ? 1 : 0.5, fontFamily: "inherit" }}>
            {saving ? "Saving…" : `Save — KES ${totalAmount.toLocaleString()}`}
          </button>
        </div>
      </div>
    </>
  );
}

function BankStatementImportModal({ onClose }) {
  const { token } = useAuth();
  const students = useAppStore(s => s.students);
  const refreshStats = useAppStore(s => s.refreshStats);
  const refreshStudents = useAppStore(s => s.refreshStudents);
  const refreshPayments = useAppStore(s => s.refreshPayments);
  const [file, setFile] = useState(null);
  const [upload, setUpload] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(new Set());

  const isExactReferenceMatch = (r) => String(r.matchReason || "").startsWith("Exact ");
  const safeRows = rows.filter(r => isExactReferenceMatch(r) && r.matchConfidence >= 85 && ["FULL", "PARTIAL"].includes(r.paymentStatus) && !r.createdPaymentId);
  const selectedRows = rows.filter(r => selected.has(r.id));

  const refreshAll = async () => {
    await Promise.all([refreshStats(token), refreshStudents(token), refreshPayments(token)]);
  };

  const uploadFile = async () => {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("statement", file);
      const res = await axios.post(`${API}/api/bank-statements/upload`, form, { headers: { Authorization: `Bearer ${token}` } });
      setUpload(res.data.upload);
      setRows(res.data.transactions || []);
      setSelected(new Set((res.data.transactions || []).filter(r => isExactReferenceMatch(r) && r.matchConfidence >= 85 && ["FULL", "PARTIAL"].includes(r.paymentStatus)).map(r => r.id)));
    } catch (e) {
      setError(e.response?.data?.message || "Could not import statement.");
    } finally { setBusy(false); }
  };

  const approveSafe = async () => {
    if (!upload?.id) return;
    setBusy(true); setError("");
    try {
      const res = await axios.post(`${API}/api/bank-statements/uploads/${upload.id}/approve-safe`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setRows(res.data.transactions || rows);
      await refreshAll();
    } catch (e) { setError(e.response?.data?.message || "Could not approve safe matches."); }
    finally { setBusy(false); }
  };

  const approveOne = async (row, confirmOverpayment = false) => {
    setBusy(true); setError("");
    try {
      const res = await axios.post(`${API}/api/bank-statements/transactions/${row.id}/approve`, { confirmOverpayment }, { headers: { Authorization: `Bearer ${token}` } });
      setRows(prev => prev.map(r => r.id === row.id ? res.data.transaction : r));
      await refreshAll();
    } catch (e) {
      if (e.response?.data?.requiresConfirmation) {
        const ok = window.confirm(`Amount exceeds required balance by KES ${Number(e.response.data.overpaymentAmount || row.overpaymentAmount || 0).toLocaleString()}. Confirm overpayment?`);
        if (ok) return approveOne(row, true);
      }
      setError(e.response?.data?.message || "Could not approve transaction.");
    } finally { setBusy(false); }
  };

  const approveSelected = async () => {
    for (const row of selectedRows) {
      if (row.createdPaymentId || row.paymentStatus === "DUPLICATE" || row.matchConfidence < 85 || row.paymentStatus === "UNMATCHED" || row.paymentStatus === "NEEDS_REVIEW") continue;
      if (row.paymentStatus === "OVERPAYMENT") {
        const ok = window.confirm(`Amount exceeds required balance by KES ${Number(row.overpaymentAmount || 0).toLocaleString()}. Confirm overpayment for ${row.suggestedStudent?.name || "this student"}?`);
        if (!ok) continue;
        await approveOne(row, true);
      } else {
        await approveOne(row, false);
      }
    }
  };

  const updateMatch = async (row, studentId) => {
    if (!studentId) return;
    setBusy(true); setError("");
    try {
      const res = await axios.patch(`${API}/api/bank-statements/transactions/${row.id}/match`, { studentId }, { headers: { Authorization: `Bearer ${token}` } });
      setRows(prev => prev.map(r => r.id === row.id ? res.data.transaction : r));
    } catch (e) { setError(e.response?.data?.message || "Could not change matched student."); }
    finally { setBusy(false); }
  };

  const simpleAction = async (row, action) => {
    setBusy(true); setError("");
    try {
      const res = await axios.patch(`${API}/api/bank-statements/transactions/${row.id}/${action}`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setRows(prev => prev.map(r => r.id === row.id ? res.data.transaction : r));
    } catch (e) { setError(e.response?.data?.message || "Action failed."); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="responsive-modal-panel" style={{ position: "fixed", inset: "5vh 3vw", zIndex: 60, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,.45)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 9, display: "grid", placeItems: "center", color: "var(--blue)", background: "var(--blue-bg)", border: "1px solid var(--blue-border)" }}><Landmark size={18} /></div>
            <div><div className="card-title">Import Bank Statement</div><div className="card-sub">CSV and Excel reconciliation preview</div></div>
          </div>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div style={{ padding: 18, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 100%", padding: "10px 12px", borderRadius: 9, background: "var(--blue-bg)", border: "1px solid var(--blue-border)", color: "var(--blue)", fontSize: 12.5, fontWeight: 600 }}>
            For accurate automatic reconciliation, parents should include the student's payment reference when making bank payments.
          </div>
          <label className="btn btn-outline" style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <UploadCloud size={16} /> {file ? file.name : "Choose CSV, Excel, or PDF"}
            <input type="file" accept=".csv,.xlsx,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} style={{ display: "none" }} />
          </label>
          <button className="btn btn-primary" onClick={uploadFile} disabled={!file || busy}>{busy ? "Processing..." : "Upload & Preview"}</button>
          {upload && <button className="btn btn-outline" onClick={approveSafe} disabled={!safeRows.length || busy}>Approve all safe matches ({safeRows.length})</button>}
          {selectedRows.length > 0 && <button className="btn btn-outline" onClick={approveSelected} disabled={busy}>Approve selected ({selectedRows.length})</button>}
          {error && <span style={{ color: "var(--red)", fontSize: 13, fontWeight: 600 }}>{error}</span>}
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {!rows.length ? (
            <div style={{ padding: 38, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Upload a CSV, Excel, or PDF statement to preview matches before receipting.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040, fontSize: 12.5 }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--surface2)", zIndex: 1 }}>
                <tr>{["", "Date", "Amount", "Payer/Narration", "Suggested Student", "Confidence", "Match Reason", "Required Balance", "Status", "Action"].map(h => <th key={h} style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--border)", color: "var(--text3)", fontWeight: 700 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px" }}><input type="checkbox" checked={selected.has(row.id)} disabled={!!row.createdPaymentId || row.paymentStatus === "DUPLICATE" || row.paymentStatus === "NEEDS_REVIEW" || row.matchConfidence < 85} onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(row.id) : next.delete(row.id); return next; })} /></td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>{new Date(row.paidAt).toLocaleDateString("en-KE")}</td>
                    <td style={{ padding: "10px 12px", fontWeight: 700, color: "var(--green)", whiteSpace: "nowrap" }}>KES {Number(row.amount || 0).toLocaleString()}</td>
                    <td style={{ padding: "10px 12px", maxWidth: 260 }}><div style={{ fontWeight: 600, color: "var(--text)" }}>{row.payerName || "Unknown"}</div><div style={{ color: "var(--text3)" }}>{row.narration || row.transactionRef || "No narration"}</div></td>
                    <td style={{ padding: "10px 12px", minWidth: 170 }}>
                      {(row.suggestedStudent || row.reviewHintStudent) && (
                        <div style={{ fontSize: 11.5, color: row.matchedStudentId ? "var(--green)" : "var(--amber)", marginBottom: 5, fontWeight: 700 }}>
                          {(row.suggestedStudent || row.reviewHintStudent).name}
                          {!row.matchedStudentId && " (hint only)"}
                        </div>
                      )}
                      <select value={row.matchedStudentId || ""} disabled={!!row.createdPaymentId || busy} onChange={e => updateMatch(row, e.target.value)} style={{ ...inp, padding: "7px 9px", fontSize: 12.5 }}>
                        <option value="">Unmatched</option>
                        {students.map(s => <option key={s.id} value={s.id}>{s.name} · {s.adm}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "10px 12px", fontWeight: 700 }}>{row.matchConfidence}%</td>
                    <td style={{ padding: "10px 12px", color: "var(--text3)", minWidth: 130 }}>{row.matchReason || "Needs review"}</td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>KES {Number(row.requiredBalance || 0).toLocaleString()}</td>
                    <td style={{ padding: "10px 12px" }}><StatusPill status={row.paymentStatus} />{row.overpaymentAmount > 0 && <div style={{ color: "var(--amber)", marginTop: 4 }}>Exceeds by KES {Number(row.overpaymentAmount).toLocaleString()}</div>}</td>
                    <td style={{ padding: "10px 12px", minWidth: 190 }}>
                      {row.createdPaymentId ? <span style={{ color: "var(--green)", fontWeight: 700 }}>Approved</span> : (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {row.paymentStatus === "NEEDS_REVIEW" && row.suggestedStudentId && <button className="btn btn-outline" style={{ padding: "6px 9px", fontSize: 12 }} disabled={busy} onClick={() => updateMatch(row, row.suggestedStudentId)}>Use suggestion</button>}
                          <button className="btn btn-outline" style={{ padding: "6px 9px", fontSize: 12 }} disabled={busy || row.paymentStatus === "DUPLICATE" || row.paymentStatus === "NEEDS_REVIEW" || row.matchConfidence < 85} onClick={() => approveOne(row)}>Approve</button>
                          <button className="btn btn-outline" style={{ padding: "6px 9px", fontSize: 12 }} disabled={busy} onClick={() => simpleAction(row, "mark-unknown")}>Mark unknown</button>
                          {row.paymentStatus === "DUPLICATE" && <button className="btn btn-outline" style={{ padding: "6px 9px", fontSize: 12 }} disabled={busy} onClick={() => simpleAction(row, "ignore-duplicate")}>Ignore duplicate</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Payments Page ─────────────────────────────────────────────────────────────
export default function Payments() {
  const { token, user, hasPermission, hasAnyPermission } = useAuth();
  const { openSidebar } = useOutletContext();

  const payments       = useAppStore(s => s.payments);
  const unmatched      = useAppStore(s => s.unmatched);
  const paymentsLoaded = useAppStore(s => s.paymentsLoaded);
  const students       = useAppStore(s => s.students);
  const activeTerm     = useAppStore(s => s.activeTerm);
  const refreshStats   = useAppStore(s => s.refreshStats);
  const refreshStudents = useAppStore(s => s.refreshStudents);
  const refreshPayments = useAppStore(s => s.refreshPayments);

  const [showModal,     setShowModal]     = useState(false);
  const [showImport,    setShowImport]    = useState(false);
  const [showReport,    setShowReport]    = useState(false);
  const [deleteTarget,  setDeleteTarget]  = useState(null);
  const [page,          setPage]          = useState(1);
  const [assignTarget,  setAssignTarget]  = useState(null);
  const [search,        setSearch]        = useState("");
  const [bankSubs,      setBankSubs]      = useState([]);
  const [bankSubsLoading, setBankSubsLoading] = useState(false);
  const [bankSubsError, setBankSubsError] = useState("");
  const [bankSubsMessage, setBankSubsMessage] = useState("");
  const [bankActionId, setBankActionId] = useState(null);
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
    const ts           = p.receivedAt || p.createdAt ? new Date(p.receivedAt || p.createdAt).getTime() : 0;
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

  const loadBankConfirmations = useCallback(async () => {
    setBankSubsLoading(true);
    setBankSubsError("");
    try {
      const res = await axios.get(`${API}/api/payments/bank-confirmations`, { headers: { Authorization: `Bearer ${token}` } });
      setBankSubs(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setBankSubsError(e.response?.data?.message || "Could not load parent bank confirmations.");
    } finally {
      setBankSubsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadBankConfirmations();
  }, [loadBankConfirmations]);

  const refreshPaymentSurfaces = useCallback(() => Promise.all([
    refreshPayments(token),
    refreshStudents(token),
    refreshStats(token),
  ]), [refreshPayments, refreshStudents, refreshStats, token]);

  const openProof = async (submission) => {
    if (!submission.proofUrl) return;
    setBankActionId(`proof-${submission.id}`);
    setBankSubsError("");
    try {
      const res = await axios.get(`${API}${submission.proofUrl}`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "blob",
      });
      // Determine MIME type for correct rendering (PDF vs image)
      const mime = res.headers["content-type"] || res.data.type || "application/octet-stream";
      const blob = new Blob([res.data], { type: mime });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      // e.response.data is a Blob when responseType is "blob" -- use the existing helper
      setBankSubsError(await errorMessageFromBlobResponse(e, "Could not open proof file. It may have been deleted from the server."));
    } finally {
      setBankActionId(null);
    }
  };

  const confirmBankSubmission = async (submission) => {
    if (!window.confirm("Confirm this parent bank submission and create the payment receipt?")) return;
    setBankActionId(submission.id);
    setBankSubsError("");
    setBankSubsMessage("");
    try {
      await axios.post(`${API}/api/payments/bank-confirmations/${submission.id}/confirm`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setBankSubs(prev => prev.map(row => row.id === submission.id ? { ...row, status: "CONFIRMED" } : row));
      await refreshPaymentSurfaces();
      analytics.track("bank_payment_approved", {
        amount: submission.amount,
        studentId: submission.studentId,
        submissionId: submission.id,
      });
      setBankSubsMessage("Payment confirmed. Receipt generated and balances refreshed.");
    } catch (e) {
      if (e.response?.status === 409) {
        setBankSubs(prev => prev.map(row => row.id === submission.id ? { ...row, status: "DUPLICATE" } : row));
      }
      setBankSubsError(e.response?.data?.message || "Failed to confirm submission.");
    } finally {
      setBankActionId(null);
    }
  };

  const rejectBankSubmission = async (submission) => {
    const reason = window.prompt("Reason for rejection (optional)") || "";
    setBankActionId(submission.id);
    setBankSubsError("");
    setBankSubsMessage("");
    try {
      await axios.post(`${API}/api/payments/bank-confirmations/${submission.id}/reject`, { reason }, { headers: { Authorization: `Bearer ${token}` } });
      setBankSubs(prev => prev.map(row => row.id === submission.id ? { ...row, status: "REJECTED" } : row));
      analytics.track("bank_payment_rejected", {
        amount: submission.amount,
        studentId: submission.studentId,
        submissionId: submission.id,
      });
      setBankSubsMessage("Submission rejected.");
    } catch (e) {
      setBankSubsError(e.response?.data?.message || "Failed to reject submission.");
    } finally {
      setBankActionId(null);
    }
  };

  const studentsWithPayments = useMemo(() => {
    const ids = new Set(payments.map(p => p.studentId).filter(Boolean));
    return students.filter(s => ids.has(s.id));
  }, [payments, students]);

  return (
    <>
      <Topbar title="Payments" sub="All recorded payments" onMenuClick={openSidebar}>
        {hasAnyPermission(['payments.view', 'reports.view']) && <button className="btn btn-outline" onClick={() => setShowReport(true)}>Download Payments</button>}
        {hasPermission('payments.create') && <button className="btn btn-outline" onClick={() => setShowImport(true)} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Landmark size={16} /> Import Statement</button>}
        {hasPermission('payments.create') && <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Manual</button>}
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
          <div className="card-body-flush payment-record-scroll">
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
                className="payment-record-row"
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: i < paginated.length - 1 ? "1px solid var(--border)" : "none", transition: "background .1s", opacity: p.reversedAt ? 0.5 : 1 }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: p.reversedAt ? "var(--red-bg)" : "var(--green-bg)", border: `1px solid ${p.reversedAt ? "var(--red-border)" : "var(--green-border)"}`, display: "flex", alignItems: "center", justifyContent: "center", color: p.reversedAt ? "var(--red)" : "var(--green)" }}><PayIcon /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                    {p.reversedAt && <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 8, padding: "2px 7px", borderRadius: 10, background: "var(--red-bg)", border: "1px solid var(--red-border)", color: "var(--red)" }}>REVERSED</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{p.meta}</span>
                    {p.txn && p.txn !== "—" && <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--surface2)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", flexShrink: 0 }}>{p.txn}</span>}
                    {p.feeBreakdown?.length > 0 && p.feeBreakdown.map((fb, fi) => <span key={fi} style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 4, background: "var(--surface3)", border: "1px solid var(--border)", color: "var(--text3)" }}>{fb.typeName}</span>)}
                  </div>
                </div>
                <MethodBadge method={p.method === "manual" ? "cash" : p.method} />
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: p.reversedAt ? "var(--red)" : "var(--green)", fontVariantNumeric: "tabular-nums", textDecoration: p.reversedAt ? "line-through" : "none" }}>+{p.amount}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                </div>
                {/* Print receipt */}
                <button onClick={e => { e.stopPropagation(); printReceipt(p, user?.schoolName); }} title="Print receipt"
                  style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: "transparent", border: "1px solid transparent", color: "var(--text3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--blue-bg)"; e.currentTarget.style.borderColor = "var(--blue-border)"; e.currentTarget.style.color = "var(--blue)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text3)"; }}>
                  <PrintIcon />
                </button>
                {/* Reverse — only shown for non-reversed payments */}
                {!p.reversedAt && hasPermission('payments.reverse') && (
                <button onClick={e => { e.stopPropagation(); setDeleteTarget(p); }} title="Reverse payment"
                  style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: "transparent", border: "1px solid transparent", color: "var(--text3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--red-bg)"; e.currentTarget.style.borderColor = "var(--red-border)"; e.currentTarget.style.color = "var(--red)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text3)"; }}>
                  <TrashIcon />
                </button>
                )}
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
                {unmatched.map((p, i) => {
                  const sender = unmatchedSenderName(p);
                  const phone = unmatchedPhoneLabel(p);
                  const txn = unmatchedTxn(p);
                  const raw = unmatchedRaw(p);
                  const hasRaw = Object.keys(raw).length > 0;
                  return (
                  <div key={p.id || i} className="payment-record-row" style={{ display: "grid", gridTemplateColumns: "36px minmax(220px, 1fr) auto auto", alignItems: "center", gap: 14, padding: "14px 18px", borderBottom: i < unmatched.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--amber)" }}><QIcon /></div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--amber)", marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sender}</div>
                      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                        <div style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: 6, overflow: "hidden" }}>
                          {txn && txn !== "—" && <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--amber-bg)", padding: "2px 7px", borderRadius: 5, border: "1px solid var(--amber-border)", color: "var(--amber)", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 }}>{txn}</span>}
                          {p.billRefNumber ? <span style={{ fontSize: 11, color: "var(--text3)", padding: "2px 7px", borderRadius: 4, background: "var(--surface2)", border: "1px solid var(--border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 }}>Account: {p.billRefNumber}</span> : null}
                        </div>
                        <div style={{ display: "flex", flexWrap: "nowrap", gap: 10, fontSize: 11.5, color: "var(--text3)", minWidth: 0 }}>
                          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>Phone: {phone}</span>
                          {p.matchReason ? <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{p.matchReason}{p.matchConfidence ? ` (${p.matchConfidence}%)` : ""}</span> : null}
                        </div>
                        {hasRaw && <details style={{ width: "100%", marginTop: 4 }}>
                          <summary style={{ cursor: "pointer", color: "var(--text3)", fontSize: 11 }}>Raw Safaricom metadata</summary>
                          <pre style={{ margin: "6px 0 0", maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 10.5, lineHeight: 1.45, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>{JSON.stringify(raw, null, 2)}</pre>
                        </details>}
                      </div>
                    </div>
                    {hasPermission('payments.create') && <button onClick={() => setAssignTarget(p)}
                      style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", minHeight: 36, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", color: "var(--amber)", transition: "all .15s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "var(--amber)"; e.currentTarget.style.color = "#0b1a14"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "var(--amber-bg)"; e.currentTarget.style.color = "var(--amber)"; }}>
                      Assign →
                    </button>}
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--amber)", fontVariantNumeric: "tabular-nums" }}>{p.amount}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{p.time}</div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Parent Bank Confirmations */}
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Parent Bank Confirmations</div>
              <div className="card-sub">Parent-submitted bank/paybill confirmations awaiting review</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 20, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)" }}>
                {bankSubs.filter(s => ["UNDER_REVIEW", "DUPLICATE"].includes(s.status)).length} awaiting confirmation
              </span>
              <button className="btn btn-outline" style={{ padding: "7px 12px", fontSize: 12 }} disabled={bankSubsLoading} onClick={loadBankConfirmations}>
                {bankSubsLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          {bankSubsMessage && <div style={{ margin: "0 18px 12px", padding: "9px 12px", borderRadius: 8, background: "var(--green-bg)", border: "1px solid var(--green-border)", color: "var(--green)", fontSize: 12.5 }}>{bankSubsMessage}</div>}
          {bankSubsError && <div style={{ margin: "0 18px 12px", padding: "9px 12px", borderRadius: 8, background: "var(--red-bg)", border: "1px solid var(--red-border)", color: "var(--red)", fontSize: 12.5 }}>{bankSubsError}</div>}
          <div className="card-body-flush">
            {bankSubsLoading ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading parent bank confirmations...</div>
            ) : bankSubs.length === 0 ? (
              <div style={{ padding: "42px 20px", textAlign: "center", color: "var(--text3)", fontSize: 13 }}>No parent bank confirmations awaiting review</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text3)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Student</th>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Invoice</th>
                      <th style={{ padding: "10px 12px", textAlign: "right" }}>Amount</th>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Reference</th>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Paid</th>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Parent</th>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Note</th>
                      <th style={{ padding: "10px 12px", textAlign: "left" }}>Status</th>
                      <th style={{ padding: "10px 12px", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bankSubs.map((s, i) => {
                      const actionable = hasPermission("payments.create") && ["UNDER_REVIEW", "DUPLICATE"].includes(s.status);
                      const busy = bankActionId === s.id || bankActionId === `proof-${s.id}`;
                      return (
                        <tr key={s.id} style={{ borderBottom: i < bankSubs.length - 1 ? "1px solid var(--border)" : "none", opacity: s.status === "REJECTED" ? 0.72 : 1 }}>
                          <td style={{ padding: "12px", verticalAlign: "top" }}>
                            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{s.studentName || "Unknown student"}</div>
                            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 3 }}>{s.admNo || "No adm"} · {s.className || "No class"}</div>
                          </td>
                          <td style={{ padding: "12px", verticalAlign: "top", fontSize: 12.5, color: "var(--text2)" }}>{s.invoiceNo ? `#${s.invoiceNo}` : "—"}</td>
                          <td style={{ padding: "12px", verticalAlign: "top", textAlign: "right", fontSize: 13.5, fontWeight: 700, color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>KES {fmtMoney(s.amount)}</td>
                          <td style={{ padding: "12px", verticalAlign: "top" }}>
                            <span style={{ fontFamily: "monospace", fontSize: 11.5, background: "var(--surface2)", padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)", color: "var(--text2)" }}>{s.transactionRef || "—"}</span>
                          </td>
                          <td style={{ padding: "12px", verticalAlign: "top", fontSize: 12.5, color: "var(--text2)", whiteSpace: "nowrap" }}>{fmtDateTime(s.paidAt || s.createdAt)}</td>
                          <td style={{ padding: "12px", verticalAlign: "top" }}>
                            <div style={{ fontSize: 12.5, color: "var(--text2)" }}>{s.parentName || "—"}</div>
                            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 3 }}>{s.parentPhone || "—"}</div>
                          </td>
                          <td style={{ padding: "12px", verticalAlign: "top", fontSize: 12.5, color: "var(--text2)", maxWidth: 220, whiteSpace: "normal" }}>{s.note || "—"}</td>
                          <td style={{ padding: "12px", verticalAlign: "top" }}><StatusPill status={s.status || "UNDER_REVIEW"} /></td>
                          <td style={{ padding: "12px", verticalAlign: "top", textAlign: "right" }}>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                              {s.proofUrl && <button className="btn btn-outline" style={{ padding: "6px 9px", fontSize: 12 }} disabled={busy} onClick={() => openProof(s)}>{bankActionId === `proof-${s.id}` ? "Opening..." : "Proof"}</button>}
                              <button className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12 }} disabled={!actionable || busy || s.status === "DUPLICATE"} onClick={() => confirmBankSubmission(s)}>Confirm</button>
                              <button className="btn btn-outline" style={{ padding: "6px 10px", fontSize: 12 }} disabled={!actionable || busy} onClick={() => rejectBankSubmission(s)}>Reject</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {showModal    && <AddPaymentModal    onClose={() => setShowModal(false)} />}
      {showImport   && <BankStatementImportModal onClose={() => setShowImport(false)} />}
      {showReport   && <PaymentsReportModal onClose={() => setShowReport(false)} students={students} activeTerm={activeTerm} />}
      {deleteTarget && <DeleteConfirmModal payment={deleteTarget} token={token} onClose={() => setDeleteTarget(null)} />}
      {assignTarget && <AssignModal        payment={assignTarget} token={token} onClose={() => setAssignTarget(null)} />}

      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

function PaymentsReportModal({ onClose, students, activeTerm }) {
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    range: "this_month",
    startDate: "",
    endDate: "",
    studentId: "",
    className: "",
    method: "all",
    status: "valid",
  });
  const classes = useMemo(() => [...new Set(students.map(s => s.cls).filter(Boolean))].sort(), [students]);
  const set = key => e => setFilters(f => ({ ...f, [key]: e.target.value }));
  const rangeDates = () => {
    const now = new Date();
    const iso = d => d.toISOString().slice(0, 10);
    if (filters.range === "today") return { startDate: iso(now), endDate: iso(now) };
    if (filters.range === "this_week") {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay() + 1);
      return { startDate: iso(start), endDate: iso(now) };
    }
    if (filters.range === "this_month") {
      return { startDate: iso(new Date(now.getFullYear(), now.getMonth(), 1)), endDate: iso(now) };
    }
    if (filters.range === "this_term" && activeTerm) {
      return { startDate: iso(new Date(activeTerm.startDate)), endDate: iso(new Date(activeTerm.endDate)) };
    }
    if (filters.range === "custom") return { startDate: filters.startDate, endDate: filters.endDate };
    return {};
  };
  const download = async () => {
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams();
      const dates = rangeDates();
      Object.entries({ ...dates, studentId: filters.studentId, className: filters.className, method: filters.method, status: filters.status })
        .forEach(([k, v]) => { if (v) params.set(k, v); });
      const url = `${API}/api/payments/report/pdf?${params.toString()}`;
      const res = await axios.get(url, {
        responseType: "blob",
        headers: { Authorization: `Bearer ${token}` },
      });
      downloadBlob(res.data, "Payments-Report.pdf");
      onClose();
    } catch (e) {
      console.warn("Payments report download failed", { status: e.response?.status, contentType: e.response?.headers?.["content-type"] });
      setError(await errorMessageFromBlobResponse(e, "Could not generate payments report."));
    }
    finally { setBusy(false); }
  };
  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 560, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 24px 60px rgba(0,0,0,.45)", overflow: "hidden" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div><div className="card-title">Download Payments Report</div><div className="card-sub">Generate a professional PDF with filters.</div></div>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div style={{ padding: 22, display: "grid", gap: 14 }}>
          <div><label style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>Date range</label><select style={inp} value={filters.range} onChange={set("range")}><option value="today">Today</option><option value="this_week">This week</option><option value="this_month">This month</option><option value="this_term">This term</option><option value="custom">Custom date range</option><option value="all">All time</option></select></div>
          {filters.range === "custom" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}><input type="date" style={inp} value={filters.startDate} onChange={set("startDate")} /><input type="date" style={inp} value={filters.endDate} onChange={set("endDate")} /></div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>Student</label><select style={inp} value={filters.studentId} onChange={set("studentId")}><option value="">All students</option>{students.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div><label style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>Class</label><select style={inp} value={filters.className} onChange={set("className")}><option value="">All classes</option>{classes.map(cls => <option key={cls} value={cls}>{cls}</option>)}</select></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>Payment method</label><select style={inp} value={filters.method} onChange={set("method")}><option value="all">All</option><option value="mpesa">M-Pesa</option><option value="manual">Manual</option></select></div>
            <div><label style={{ fontSize: 12, color: "var(--text3)", fontWeight: 700 }}>Status</label><select style={inp} value={filters.status} onChange={set("status")}><option value="all">All</option><option value="valid">Valid</option><option value="reversed">Reversed</option><option value="deleted">Deleted</option></select></div>
          </div>
          {error && <div style={{ color: "var(--red)", fontSize: 13 }}>{error}</div>}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={download}>{busy ? "Generating..." : "Download PDF"}</button>
        </div>
      </div>
    </>
  );
}
