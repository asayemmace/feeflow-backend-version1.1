import { useState, useMemo, useEffect, useRef } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import useAppStore from "../store/useAppStore";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) { return Number(n || 0).toLocaleString(); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" }) : "—"; }
function fmtDatetime(d) { return d ? new Date(d).toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
function initials(name) { return (name || "?").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase(); }
function hue(name) { return ((name || "").charCodeAt(0) * 37 + ((name || "").charCodeAt((name || "").length - 1) || 0) * 13) % 360; }

// ─── Plan Gate Banner ─────────────────────────────────────────────────────────
function PlanGate({ feature, plan, children }) {
  const gates = {
    invoices: { required: "pro",  label: "Pro or Max", desc: "Bulk & scheduled invoice delivery via WhatsApp and email" },
    receipts: { required: "max",  label: "Max",        desc: "Instant auto-receipts on every payment" },
  };
  const order = { free: 0, pro: 1, max: 2 };
  const gate = gates[feature];
  if (!gate || order[plan] >= order[gate.required]) return children;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center", gap: 16 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🔒</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{gate.label} plan required</div>
      <div style={{ fontSize: 13.5, color: "var(--text3)", maxWidth: 340, lineHeight: 1.6 }}>{gate.desc}. Upgrade your plan to unlock this feature.</div>
      <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Upgrade" style={{ padding: "10px 24px", borderRadius: 9, background: "var(--amber)", color: "#1a0f00", fontSize: 13.5, fontWeight: 700, textDecoration: "none", marginTop: 4 }}>Upgrade plan →</a>
    </div>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ name, size = 32 }) {
  const h = hue(name);
  return (
    <div style={{ width: size, height: size, borderRadius: size > 40 ? 12 : 8, flexShrink: 0, background: `hsl(${h},55%,22%)`, border: `1px solid hsl(${h},55%,32%)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.34, fontWeight: 700, color: `hsl(${h},70%,72%)`, letterSpacing: 0.3 }}>
      {initials(name)}
    </div>
  );
}

// ─── Status Pill ──────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const map = {
    sent:      { color: "var(--green)",  bg: "var(--green-bg)",  border: "var(--green-border)",  label: "Sent" },
    pending:   { color: "var(--amber)",  bg: "var(--amber-bg)",  border: "var(--amber-border)",  label: "Pending" },
    scheduled: { color: "var(--blue, #60a5fa)",  bg: "rgba(96,165,250,0.1)",  border: "rgba(96,165,250,0.25)",  label: "Scheduled" },
    failed:    { color: "var(--red)",    bg: "var(--red-bg)",    border: "var(--red-border)",    label: "Failed" },
    draft:     { color: "var(--text3)",  bg: "var(--surface2)",  border: "var(--border)",         label: "Draft" },
  };
  const s = map[status] || map.draft;
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: s.bg, color: s.color, border: `1px solid ${s.border}`, letterSpacing: 0.3, textTransform: "uppercase" }}>{s.label}</span>;
}

// ─── Delivery Channel Badge ───────────────────────────────────────────────────
function ChannelBadge({ channels }) {
  const arr = Array.isArray(channels) ? channels : (channels || "").split(",").filter(Boolean);
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {arr.includes("whatsapp") && <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 10, background: "rgba(37,211,102,0.12)", color: "#25d366", border: "1px solid rgba(37,211,102,0.25)", fontWeight: 600 }}>WhatsApp</span>}
      {arr.includes("email")    && <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 10, background: "rgba(96,165,250,0.1)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.2)", fontWeight: 600 }}>Email</span>}
    </div>
  );
}

// ─── Invoice PDF Preview ──────────────────────────────────────────────────────
function InvoicePreview({ invoice, school, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 90, width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: 14, boxShadow: "0 32px 80px rgba(0,0,0,0.6)", animation: "modalIn .2s ease" }}>
        {/* Invoice paper */}
        <div style={{ padding: 36, fontFamily: "'Georgia', serif", color: "#111" }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, paddingBottom: 20, borderBottom: "2px solid #111" }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{school || "School Name"}</div>
              <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>SCHOOL FEE INVOICE</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#777" }}>Invoice #</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{invoice.invoiceNo || "INV-001"}</div>
              <div style={{ fontSize: 11, color: "#777", marginTop: 4 }}>Date issued</div>
              <div style={{ fontSize: 12 }}>{fmtDate(invoice.issuedAt || new Date())}</div>
            </div>
          </div>

          {/* Bill to */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
            <div>
              <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Bill To</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{invoice.studentName}</div>
              <div style={{ fontSize: 12, color: "#444", marginTop: 2 }}>{invoice.className}</div>
              <div style={{ fontSize: 12, color: "#444" }}>Adm: {invoice.admNo}</div>
              {invoice.parentName  && <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>Parent: {invoice.parentName}</div>}
              {invoice.parentPhone && <div style={{ fontSize: 12, color: "#444" }}>📱 {invoice.parentPhone}</div>}
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Payment Due</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#c00" }}>{fmtDate(invoice.dueDate)}</div>
              {invoice.termName && <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>Term: {invoice.termName}</div>}
            </div>
          </div>

          {/* Fee breakdown table */}
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20, fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#111", color: "#fff" }}>
                <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600 }}>Description</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>Amount (KES)</th>
              </tr>
            </thead>
            <tbody>
              {(invoice.feeBreakdown || [{ typeName: "Tuition Fee", amount: invoice.totalFee }]).map((fb, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "9px 12px" }}>{fb.typeName}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(fb.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid #111" }}>
                <td style={{ padding: "10px 12px", fontWeight: 700, fontSize: 14 }}>Total Due</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>KES {fmt(invoice.totalFee)}</td>
              </tr>
              {invoice.paid > 0 && (
                <>
                  <tr>
                    <td style={{ padding: "6px 12px", color: "#27ae60" }}>Amount Paid</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: "#27ae60", fontVariantNumeric: "tabular-nums" }}>KES {fmt(invoice.paid)}</td>
                  </tr>
                  <tr style={{ background: invoice.balance > 0 ? "#fff5f5" : "#f0fff4" }}>
                    <td style={{ padding: "8px 12px", fontWeight: 700, color: invoice.balance > 0 ? "#c00" : "#27ae60" }}>Balance Remaining</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: invoice.balance > 0 ? "#c00" : "#27ae60", fontVariantNumeric: "tabular-nums" }}>KES {fmt(invoice.balance)}</td>
                  </tr>
                </>
              )}
            </tfoot>
          </table>

          {/* Footer note */}
          <div style={{ fontSize: 11, color: "#888", borderTop: "1px solid #eee", paddingTop: 14, lineHeight: 1.7 }}>
            Please ensure payment is made before the due date. For inquiries contact the school administration.<br />
            <em>This invoice was generated by FeeFlow · {school}</em>
          </div>
        </div>

        {/* Actions */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end", gap: 10, background: "#fafafa", borderRadius: "0 0 14px 14px" }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, background: "transparent", border: "1px solid #ddd", fontSize: 13, cursor: "pointer" }}>Close</button>
          <button onClick={() => window.print()} style={{ padding: "9px 18px", borderRadius: 8, background: "#111", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Print / Save PDF</button>
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

// ─── Receipt Preview ──────────────────────────────────────────────────────────
function ReceiptPreview({ receipt, school, onClose }) {
  const methodLabel = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash", manual: "Manual Entry" };
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 90, width: "100%", maxWidth: 480, background: "#fff", borderRadius: 14, boxShadow: "0 32px 80px rgba(0,0,0,0.6)", animation: "modalIn .2s ease" }}>
        <div style={{ padding: 36, fontFamily: "'Georgia', serif", color: "#111" }}>
          <div style={{ textAlign: "center", marginBottom: 24, paddingBottom: 20, borderBottom: "2px solid #111" }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{school || "School Name"}</div>
            <div style={{ fontSize: 11, color: "#777", marginTop: 4, letterSpacing: 2, textTransform: "uppercase" }}>Official Payment Receipt</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24, fontSize: 13 }}>
            {[
              ["Receipt No.", receipt.receiptNo || "REC-001"],
              ["Date",       fmtDatetime(receipt.paidAt)],
              ["Student",    receipt.studentName],
              ["Adm. No.",   receipt.admNo],
              ["Class",      receipt.className],
              ["Term",       receipt.termName || "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: 0.8 }}>{k}</div>
                <div style={{ fontWeight: 600, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ background: "#f9f9f9", border: "1px solid #eee", borderRadius: 10, padding: 16, marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8 }}>
              <span style={{ color: "#666" }}>Payment Method</span>
              <span style={{ fontWeight: 600 }}>{methodLabel[receipt.method] || receipt.method}</span>
            </div>
            {receipt.txnRef && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8 }}>
                <span style={{ color: "#666" }}>Transaction Ref</span>
                <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{receipt.txnRef}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, borderTop: "1px solid #eee" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Amount Received</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#27ae60" }}>KES {fmt(receipt.amount)}</span>
            </div>
          </div>
          {receipt.balance !== undefined && (
            <div style={{ fontSize: 13, display: "flex", justifyContent: "space-between", padding: "10px 14px", background: receipt.balance > 0 ? "#fff5f5" : "#f0fff4", borderRadius: 8, fontWeight: 600 }}>
              <span style={{ color: receipt.balance > 0 ? "#c00" : "#27ae60" }}>Outstanding Balance</span>
              <span style={{ color: receipt.balance > 0 ? "#c00" : "#27ae60" }}>{receipt.balance > 0 ? `KES ${fmt(receipt.balance)}` : "Cleared ✓"}</span>
            </div>
          )}
          <div style={{ marginTop: 20, fontSize: 11, color: "#aaa", textAlign: "center", lineHeight: 1.7 }}>
            Thank you for your payment · {school}<br/>
            <em>Generated by FeeFlow</em>
          </div>
        </div>
        <div style={{ padding: "14px 24px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end", gap: 10, background: "#fafafa", borderRadius: "0 0 14px 14px" }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, background: "transparent", border: "1px solid #ddd", fontSize: 13, cursor: "pointer" }}>Close</button>
          <button onClick={() => window.print()} style={{ padding: "9px 18px", borderRadius: 8, background: "#111", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Print / Save PDF</button>
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

// ─── Create Invoice Modal ─────────────────────────────────────────────────────
function CreateInvoiceModal({ onClose, token, schoolName }) {
  const students = useAppStore(s => s.students);
  const [step,         setStep]         = useState(1); // 1=select, 2=configure, 3=review
  const [mode,         setMode]         = useState("bulk"); // bulk | single
  const [selectedIds,  setSelectedIds]  = useState([]);
  const [filterClass,  setFilterClass]  = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [dueDate,      setDueDate]      = useState("");
  const [sendDate,     setSendDate]     = useState("");
  const [sendTime,     setSendTime]     = useState("08:00");
  const [channels,     setChannels]     = useState(["whatsapp"]);
  const [note,         setNote]         = useState("");
  const [termName,     setTermName]     = useState("");
  const [sending,      setSending]      = useState(false);
  const [error,        setError]        = useState("");

  const allClasses = useMemo(() => [...new Set(students.map(s => s.cls))].filter(Boolean).sort(), [students]);
  const filtered   = useMemo(() => students.filter(s =>
    (filterClass  === "all" || s.cls === filterClass) &&
    (filterStatus === "all" ||
      (filterStatus === "unpaid"   && s.paid <= 0) ||
      (filterStatus === "partial"  && s.paid > 0 && s.paid < s.fee) ||
      (filterStatus === "overdue"  && s.paid < s.fee))
  ), [students, filterClass, filterStatus]);

  const toggleStudent = id => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleAll     = () => setSelectedIds(selectedIds.length === filtered.length ? [] : filtered.map(s => s.id));
  const toggleChannel = ch => setChannels(prev => prev.includes(ch) ? prev.filter(x => x !== ch) : [...prev, ch]);

  const selectedStudents = students.filter(s => selectedIds.includes(s.id));
  const totalFee = selectedStudents.reduce((a, s) => a + (s.fee || 0), 0);

  const handleSchedule = async () => {
    if (!dueDate)              { setError("Due date is required"); return; }
    if (channels.length === 0) { setError("Select at least one delivery channel"); return; }
    if (selectedIds.length === 0) { setError("Select at least one student"); return; }
    // Check parent contact info
    const missing = selectedStudents.filter(s => {
      if (channels.includes("whatsapp") && !s.parentPhone) return true;
      if (channels.includes("email")    && !s.email && !s.parentEmail) return true;
      return false;
    });
    if (missing.length > 0) { setError(`${missing.length} student(s) missing required contact info for selected channels.`); return; }

    setSending(true); setError("");
    try {
      await axios.post(`${API}/api/invoices`, {
        studentIds: selectedIds,
        dueDate,
        scheduledFor: sendDate ? `${sendDate}T${sendTime}:00` : null,
        channels,
        note,
        termName,
      }, { headers: { Authorization: `Bearer ${token}` } });
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to schedule invoices."); }
    finally { setSending(false); }
  };

  const inp = { width: "100%", height: 40, padding: "0 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 60, width: "100%", maxWidth: 580, maxHeight: "92vh", display: "flex", flexDirection: "column", background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 28px 70px rgba(0,0,0,0.5)", animation: "modalIn .2s ease" }}>
        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Create Invoice Batch</div>
              <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>Step {step} of 3 — {["Select students","Configure & schedule","Review & send"][step-1]}</div>
            </div>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 16 }}>×</button>
          </div>
          {/* Step bar */}
          <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
            {[1,2,3].map(i => (
              <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= i ? "var(--accent)" : "var(--surface3)", transition: "background .3s" }} />
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>

          {/* ── Step 1: Select Students ── */}
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filters */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <select style={{ ...inp, flex: 1, minWidth: 130 }} value={filterClass} onChange={e => setFilterClass(e.target.value)}>
                  <option value="all">All classes</option>
                  {allClasses.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select style={{ ...inp, flex: 1, minWidth: 130 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                  <option value="all">All statuses</option>
                  <option value="unpaid">Unpaid only</option>
                  <option value="partial">Partial only</option>
                  <option value="overdue">Has balance</option>
                </select>
              </div>

              {/* Select all toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--surface2)", borderRadius: 9, border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div onClick={toggleAll} style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${selectedIds.length === filtered.length && filtered.length > 0 ? "var(--accent)" : "var(--text3)"}`, background: selectedIds.length === filtered.length && filtered.length > 0 ? "var(--accent)" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {selectedIds.length === filtered.length && filtered.length > 0 && <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="#0b1a14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  <span style={{ fontSize: 13, color: "var(--text2)" }}>Select all ({filtered.length} students)</span>
                </div>
                {selectedIds.length > 0 && <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>{selectedIds.length} selected</span>}
              </div>

              {/* Student list */}
              <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 320, overflowY: "auto", borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
                {filtered.length === 0 ? (
                  <div style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>No students match your filters</div>
                ) : filtered.map(s => {
                  const selected = selectedIds.includes(s.id);
                  const balance  = s.fee - s.paid;
                  const hasPh    = !!s.parentPhone;
                  return (
                    <div key={s.id} onClick={() => toggleStudent(s.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: selected ? "var(--green-bg)" : "var(--surface)", borderBottom: "1px solid var(--border)", cursor: "pointer", transition: "background .1s" }}>
                      <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${selected ? "var(--accent)" : "var(--text3)"}`, background: selected ? "var(--accent)" : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {selected && <svg width="9" height="9" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="#0b1a14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <Avatar name={s.name} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                          {s.name}
                          {!hasPh && <span style={{ fontSize: 10, color: "var(--amber)", background: "var(--amber-bg)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--amber-border)" }}>No phone</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text3)" }}>{s.cls} · {s.adm}</div>
                      </div>
                      <div style={{ textAlign: "right", fontSize: 12 }}>
                        <div style={{ color: balance > 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }}>KES {fmt(balance > 0 ? balance : s.fee)}</div>
                        <div style={{ color: "var(--text3)" }}>{balance > 0 ? "balance" : "total"}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Step 2: Configure ── */}
          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field-group">
                  <label className="settings-label">Term name <span style={{ color: "var(--text3)", fontWeight: 400 }}>(optional)</span></label>
                  <input style={inp} value={termName} onChange={e => setTermName(e.target.value)} placeholder="e.g. Term 1 2025" />
                </div>
                <div className="field-group">
                  <label className="settings-label">Payment due date *</label>
                  <input type="date" style={inp} value={dueDate} onChange={e => setDueDate(e.target.value)} min={new Date().toISOString().split("T")[0]} />
                </div>
              </div>

              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 12 }}>When to send</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="field-group">
                    <label className="settings-label">Send date <span style={{ color: "var(--text3)", fontWeight: 400 }}>(leave blank = send now)</span></label>
                    <input type="date" style={inp} value={sendDate} onChange={e => setSendDate(e.target.value)} min={new Date().toISOString().split("T")[0]} />
                  </div>
                  <div className="field-group">
                    <label className="settings-label">Send time</label>
                    <input type="time" style={inp} value={sendTime} onChange={e => setSendTime(e.target.value)} />
                  </div>
                </div>
                {sendDate && (
                  <div style={{ fontSize: 12, color: "var(--accent)", background: "var(--green-bg)", border: "1px solid var(--green-border)", padding: "8px 12px", borderRadius: 7 }}>
                    📅 Invoices will be sent automatically on {fmtDate(sendDate)} at {sendTime}
                  </div>
                )}
                {!sendDate && (
                  <div style={{ fontSize: 12, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", padding: "8px 12px", borderRadius: 7 }}>
                    ⚡ No schedule set — invoices will be sent immediately when you confirm
                  </div>
                )}
              </div>

              <div className="field-group">
                <label className="settings-label">Delivery channels *</label>
                <div style={{ display: "flex", gap: 10 }}>
                  {[
                    { id: "whatsapp", label: "📱 WhatsApp", desc: "Via parent phone" },
                    { id: "email",    label: "✉️ Email",    desc: "Via parent email" },
                  ].map(ch => {
                    const active = channels.includes(ch.id);
                    return (
                      <div key={ch.id} onClick={() => toggleChannel(ch.id)} style={{ flex: 1, padding: "12px 14px", borderRadius: 9, border: `2px solid ${active ? "var(--accent)" : "var(--border)"}`, background: active ? "var(--green-bg)" : "var(--surface2)", cursor: "pointer", transition: "all .15s" }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{ch.label}</div>
                        <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 2 }}>{ch.desc}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="field-group">
                <label className="settings-label">Additional note <span style={{ color: "var(--text3)", fontWeight: 400 }}>(shown on invoice)</span></label>
                <textarea style={{ ...inp, height: 72, padding: "10px 12px", resize: "vertical" }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Kindly pay before the start of the new term. Thank you." />
              </div>

              {/* Contact coverage warning */}
              {(() => {
                const noPhone = selectedStudents.filter(s => !s.parentPhone).length;
                if (channels.includes("whatsapp") && noPhone > 0) return (
                  <div style={{ fontSize: 12.5, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", padding: "10px 14px", borderRadius: 8 }}>
                    ⚠ {noPhone} student(s) have no parent phone — WhatsApp will be skipped for them.
                  </div>
                );
                return null;
              })()}
            </div>
          )}

          {/* ── Step 3: Review ── */}
          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
                {[
                  ["Recipients",   `${selectedIds.length} students`],
                  ["Term",         termName || "—"],
                  ["Due date",     fmtDate(dueDate)],
                  ["Send",         sendDate ? `${fmtDate(sendDate)} at ${sendTime}` : "Immediately"],
                  ["Channels",     channels.join(" + ").toUpperCase()],
                  ["Total fees",   `KES ${fmt(totalFee)}`],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 12.5, color: "var(--text3)" }}>{k}</span>
                    <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text3)", background: "var(--surface2)", borderRadius: 9, padding: "12px 14px", border: "1px solid var(--border)", lineHeight: 1.7 }}>
                A PDF invoice with fee breakdown will be generated per student and delivered via the selected channels. Receipts are auto-generated on payment.
              </div>
              {error && <div style={{ fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "10px 14px" }}>✕ {error}</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10, flexShrink: 0 }}>
          <button onClick={() => step > 1 ? setStep(s => s - 1) : onClose()} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
            {step > 1 ? "← Back" : "Cancel"}
          </button>
          {step < 3
            ? <button onClick={() => {
                if (step === 1 && selectedIds.length === 0) { setError("Select at least one student"); return; }
                setError(""); setStep(s => s + 1);
              }} disabled={step === 1 && selectedIds.length === 0} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: selectedIds.length > 0 || step > 1 ? "var(--accent)" : "var(--surface2)", border: "none", color: selectedIds.length > 0 || step > 1 ? "#0b1a14" : "var(--text3)", cursor: selectedIds.length > 0 || step > 1 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                Next →
              </button>
            : <button onClick={handleSchedule} disabled={sending} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: sending ? "var(--surface2)" : "var(--accent)", border: "none", color: sending ? "var(--text3)" : "#0b1a14", cursor: sending ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                {sending ? "Sending…" : sendDate ? "📅 Schedule invoices" : "⚡ Send now"}
              </button>
          }
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

// ─── Manual Receipt Modal ─────────────────────────────────────────────────────
function ManualReceiptModal({ onClose, token, schoolName }) {
  const students = useAppStore(s => s.students);
  const [studentId, setStudentId] = useState("");
  const [payments,  setPayments]  = useState([]);
  const [paymentId, setPaymentId] = useState("");
  const [channels,  setChannels]  = useState(["whatsapp"]);
  const [loading,   setLoading]   = useState(false);
  const [sending,   setSending]   = useState(false);
  const [error,     setError]     = useState("");
  const [preview,   setPreview]   = useState(null);

  const selectedStudent = students.find(s => s.id === studentId);

  useEffect(() => {
    if (!studentId) { setPayments([]); setPaymentId(""); return; }
    setLoading(true);
    axios.get(`${API}/api/students/${studentId}/payments`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { setPayments(r.data.termSummaries?.flatMap(t => t.payments) || []); })
      .catch(() => setError("Failed to load payments."))
      .finally(() => setLoading(false));
  }, [studentId, token]);

  const selectedPayment = payments.find(p => p.id === paymentId);

  const handleSend = async () => {
    if (!paymentId)            { setError("Select a payment"); return; }
    if (channels.length === 0) { setError("Select at least one channel"); return; }
    setSending(true); setError("");
    try {
      await axios.post(`${API}/api/receipts/manual`, { paymentId, studentId, channels }, { headers: { Authorization: `Bearer ${token}` } });
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to send receipt."); }
    finally { setSending(false); }
  };

  const inp = { width: "100%", height: 40, padding: "0 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 60, width: "100%", maxWidth: 460, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 28px 70px rgba(0,0,0,0.5)", animation: "modalIn .2s ease" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Send Manual Receipt</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>Generate & deliver a receipt for any payment</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field-group">
            <label className="settings-label">Student</label>
            <select style={{ ...inp, cursor: "pointer" }} value={studentId} onChange={e => { setStudentId(e.target.value); setPaymentId(""); }}>
              <option value="">Select a student…</option>
              {students.map(s => <option key={s.id} value={s.id}>{s.name} — {s.cls}</option>)}
            </select>
          </div>

          {loading && <div style={{ fontSize: 13, color: "var(--text3)", textAlign: "center" }}>Loading payments…</div>}

          {payments.length > 0 && (
            <div className="field-group">
              <label className="settings-label">Payment to receipt</label>
              <select style={{ ...inp, cursor: "pointer" }} value={paymentId} onChange={e => setPaymentId(e.target.value)}>
                <option value="">Select a payment…</option>
                {payments.map(p => (
                  <option key={p.id} value={p.id}>
                    {fmtDate(p.paidAt || p.time)} — KES {fmt(p.amount)} ({p.method})
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedStudent && (
            <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, padding: "10px 14px" }}>
              <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 6 }}>Delivery to</div>
              <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{selectedStudent.parentName || "Parent"}</div>
              {selectedStudent.parentPhone
                ? <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>📱 {selectedStudent.parentPhone}</div>
                : <div style={{ fontSize: 12, color: "var(--amber)", marginTop: 2 }}>⚠ No parent phone on record</div>
              }
            </div>
          )}

          <div className="field-group">
            <label className="settings-label">Send via</label>
            <div style={{ display: "flex", gap: 10 }}>
              {[{ id: "whatsapp", label: "📱 WhatsApp" }, { id: "email", label: "✉️ Email" }].map(ch => {
                const active = channels.includes(ch.id);
                return (
                  <div key={ch.id} onClick={() => setChannels(prev => prev.includes(ch.id) ? prev.filter(x => x !== ch.id) : [...prev, ch.id])} style={{ flex: 1, padding: "10px 14px", borderRadius: 9, border: `2px solid ${active ? "var(--accent)" : "var(--border)"}`, background: active ? "var(--green-bg)" : "var(--surface2)", cursor: "pointer", textAlign: "center", fontSize: 13.5, fontWeight: active ? 600 : 400, color: active ? "var(--text)" : "var(--text2)" }}>
                    {ch.label}
                  </div>
                );
              })}
            </div>
          </div>

          {selectedPayment && (
            <button onClick={() => setPreview({ ...selectedPayment, studentName: selectedStudent?.name, admNo: selectedStudent?.adm, className: selectedStudent?.cls, balance: (selectedStudent?.fee || 0) - (selectedStudent?.paid || 0) })} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 13, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
              👁 Preview receipt
            </button>
          )}

          {error && <div style={{ fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 8, padding: "10px 14px" }}>✕ {error}</div>}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleSend} disabled={sending || !paymentId} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: sending || !paymentId ? "var(--surface2)" : "var(--accent)", border: "none", color: sending || !paymentId ? "var(--text3)" : "#0b1a14", cursor: sending || !paymentId ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {sending ? "Sending…" : "Send receipt"}
          </button>
        </div>
      </div>
      {preview && <ReceiptPreview receipt={preview} school={schoolName} onClose={() => setPreview(null)} />}
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ icon, title, sub, action }) {
  return (
    <div style={{ padding: "56px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
      <div style={{ fontSize: 36 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text2)" }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--text3)", maxWidth: 320, lineHeight: 1.6 }}>{sub}</div>
      {action}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function InvoicesReceipts() {
  const { token, user, plan, canUse } = useAuth();
  const { openSidebar }               = useOutletContext();
  const students                      = useAppStore(s => s.students);

  const [tab,            setTab]            = useState("invoices");
  const [invoices,       setInvoices]       = useState([]);
  const [receipts,       setReceipts]       = useState([]);
  const [invLoading,     setInvLoading]     = useState(false);
  const [recLoading,     setRecLoading]     = useState(false);
  const [showCreateInv,  setShowCreateInv]  = useState(false);
  const [showManualRec,  setShowManualRec]  = useState(false);
  const [previewInv,     setPreviewInv]     = useState(null);
  const [previewRec,     setPreviewRec]     = useState(null);
  const [searchInv,      setSearchInv]      = useState("");
  const [searchRec,      setSearchRec]      = useState("");
  const [filterInvStatus, setFilterInvStatus] = useState("all");
  const [filterRecStatus, setFilterRecStatus] = useState("all");

  const schoolName = user?.schoolName || "School";

  // ── Load invoices ──
  useEffect(() => {
    if (tab !== "invoices" || !canUse("invoices")) return;
    setInvLoading(true);
    axios.get(`${API}/api/invoices`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setInvoices(r.data || []))
      .catch(() => {})
      .finally(() => setInvLoading(false));
  }, [tab, token, canUse]);

  // ── Load receipts ──
  useEffect(() => {
    if (tab !== "receipts") return;
    setRecLoading(true);
    axios.get(`${API}/api/receipts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setReceipts(r.data || []))
      .catch(() => {})
      .finally(() => setRecLoading(false));
  }, [tab, token]);

  const handleResendInvoice = async (id) => {
    try {
      await axios.post(`${API}/api/invoices/${id}/resend`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, status: "sent" } : inv));
    } catch {}
  };

  const handleResendReceipt = async (id) => {
    try {
      await axios.post(`${API}/api/receipts/${id}/resend`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: "sent" } : r));
    } catch {}
  };

  const filteredInvoices = useMemo(() => invoices.filter(inv =>
    (filterInvStatus === "all" || inv.status === filterInvStatus) &&
    (searchInv === "" || (inv.studentName || "").toLowerCase().includes(searchInv.toLowerCase()) || (inv.admNo || "").toLowerCase().includes(searchInv.toLowerCase()))
  ), [invoices, filterInvStatus, searchInv]);

  const filteredReceipts = useMemo(() => receipts.filter(r =>
    (filterRecStatus === "all" || r.status === filterRecStatus) &&
    (searchRec === "" || (r.studentName || "").toLowerCase().includes(searchRec.toLowerCase()) || (r.admNo || "").toLowerCase().includes(searchRec.toLowerCase()))
  ), [receipts, filterRecStatus, searchRec]);

  // ── Stats ──
  const invStats = useMemo(() => ({
    total:     invoices.length,
    sent:      invoices.filter(i => i.status === "sent").length,
    scheduled: invoices.filter(i => i.status === "scheduled").length,
    failed:    invoices.filter(i => i.status === "failed").length,
  }), [invoices]);

  const recStats = useMemo(() => ({
    total:  receipts.length,
    sent:   receipts.filter(r => r.status === "sent").length,
    auto:   receipts.filter(r => r.type === "auto").length,
    manual: receipts.filter(r => r.type === "manual").length,
  }), [receipts]);

  const searchInp = { height: 38, padding: "0 12px 0 36px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit", flex: "1 1 180px", minWidth: 160 };
  const selInp    = { height: 38, padding: "0 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 13.5, outline: "none", fontFamily: "inherit" };

  return (
    <>
      <Topbar title="Invoices & Receipts" sub="Manage fee communications" onMenuClick={openSidebar} />

      <div className="page-content">
        {/* ── Tab bar ── */}
        <div style={{ display: "flex", gap: 4, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 11, padding: 4, marginBottom: 22, width: "fit-content" }}>
          {[
            { id: "invoices", label: "📄 Invoices",  badge: invStats.scheduled > 0 ? invStats.scheduled : null },
            { id: "receipts", label: "🧾 Receipts",  badge: recStats.total > 0 ? recStats.total : null },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13.5, fontWeight: tab === t.id ? 700 : 400, background: tab === t.id ? "var(--surface)" : "transparent", border: `1px solid ${tab === t.id ? "var(--border)" : "transparent"}`, color: tab === t.id ? "var(--text)" : "var(--text3)", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8, transition: "all .15s", boxShadow: tab === t.id ? "0 1px 4px rgba(0,0,0,0.12)" : "none" }}>
              {t.label}
              {t.badge && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "var(--accent)", color: "#0b1a14" }}>{t.badge}</span>}
            </button>
          ))}
        </div>

        {/* ══════════════ INVOICES TAB ══════════════ */}
        {tab === "invoices" && (
          <PlanGate feature="invoices" plan={plan}>
            {/* Stat cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total sent",   value: invStats.sent,      color: "var(--green)", icon: "✓" },
                { label: "Scheduled",    value: invStats.scheduled,  color: "var(--blue, #60a5fa)", icon: "📅" },
                { label: "Failed",       value: invStats.failed,     color: "var(--red)",   icon: "✕" },
                { label: "All invoices", value: invStats.total,      color: "var(--text)",  icon: "📄" },
              ].map(s => (
                <div key={s.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 11, padding: "14px 16px" }}>
                  <div style={{ fontSize: 22, fontFamily: "'DM Serif Display',serif", color: s.color, lineHeight: 1 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, textTransform: "uppercase", letterSpacing: 0.7 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Actions + Filters */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: "1 1 180px", minWidth: 160 }}>
                <svg style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="var(--text3)" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                <input style={searchInp} placeholder="Search by student or adm…" value={searchInv} onChange={e => setSearchInv(e.target.value)} />
              </div>
              <select style={selInp} value={filterInvStatus} onChange={e => setFilterInvStatus(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="sent">Sent</option>
                <option value="scheduled">Scheduled</option>
                <option value="failed">Failed</option>
                <option value="draft">Draft</option>
              </select>
              <button onClick={() => setShowCreateInv(true)} style={{ padding: "9px 18px", borderRadius: 9, fontSize: 13.5, fontWeight: 700, background: "var(--accent)", border: "none", color: "#0b1a14", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                + New Invoice Batch
              </button>
            </div>

            {/* Invoice list */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              {invLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading invoices…</div>
              ) : filteredInvoices.length === 0 ? (
                <EmptyState
                  icon="📄"
                  title="No invoices yet"
                  sub="Create an invoice batch to send fee notifications to parents via WhatsApp and email."
                  action={<button onClick={() => setShowCreateInv(true)} style={{ padding: "9px 20px", borderRadius: 9, fontSize: 13, fontWeight: 700, background: "var(--accent)", border: "none", color: "#0b1a14", cursor: "pointer", fontFamily: "inherit" }}>Create first batch</button>}
                />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        {["Student", "Adm", "Class", "Term fee", "Due date", "Channels", "Scheduled for", "Status", ""].map(h => <th key={h} style={{ padding: "10px 14px", fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.7, fontWeight: 600, textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInvoices.map((inv, i) => (
                        <tr key={inv.id} style={{ borderBottom: i < filteredInvoices.length - 1 ? "1px solid var(--border)" : "none" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <Avatar name={inv.studentName} size={28} />
                              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{inv.studentName}</span>
                            </div>
                          </td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text3)" }}>{inv.admNo || "—"}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text2)" }}>{inv.className}</td>
                          <td style={{ padding: "11px 14px", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>KES {fmt(inv.totalFee)}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text2)", whiteSpace: "nowrap" }}>{fmtDate(inv.dueDate)}</td>
                          <td style={{ padding: "11px 14px" }}><ChannelBadge channels={inv.channels} /></td>
                          <td style={{ padding: "11px 14px", fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>{inv.scheduledFor ? fmtDatetime(inv.scheduledFor) : <span style={{ color: "var(--green)", fontSize: 11 }}>Sent immediately</span>}</td>
                          <td style={{ padding: "11px 14px" }}><StatusPill status={inv.status} /></td>
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={() => setPreviewInv({ ...inv, school: schoolName })} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Preview</button>
                              {inv.status === "failed" && <button onClick={() => handleResendInvoice(inv.id)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--red-bg)", border: "1px solid var(--red-border)", color: "var(--red)", cursor: "pointer", fontFamily: "inherit" }}>Resend</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Upcoming scheduled banner */}
            {invStats.scheduled > 0 && (
              <div style={{ marginTop: 14, padding: "12px 16px", background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 10, fontSize: 13, color: "var(--text2)", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16 }}>📅</span>
                <span>{invStats.scheduled} invoice batch{invStats.scheduled > 1 ? "es" : ""} scheduled for automatic delivery. They will be sent at the configured date and time.</span>
              </div>
            )}
          </PlanGate>
        )}

        {/* ══════════════ RECEIPTS TAB ══════════════ */}
        {tab === "receipts" && (
          <div>
            {/* Info cards — receipts are always visible, auto-receipts are Max only */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total sent",     value: recStats.sent,   color: "var(--green)" },
                { label: "Auto receipts",  value: recStats.auto,   color: "var(--accent)" },
                { label: "Manual sends",   value: recStats.manual, color: "var(--amber)" },
                { label: "All records",    value: recStats.total,  color: "var(--text)" },
              ].map(s => (
                <div key={s.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 11, padding: "14px 16px" }}>
                  <div style={{ fontSize: 22, fontFamily: "'DM Serif Display',serif", color: s.color, lineHeight: 1 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, textTransform: "uppercase", letterSpacing: 0.7 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Auto-receipt status banner */}
            <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, border: `1px solid ${plan === "max" ? "var(--green-border)" : "var(--amber-border)"}`, background: plan === "max" ? "var(--green-bg)" : "var(--amber-bg)", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 18 }}>{plan === "max" ? "✅" : "⚠"}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: plan === "max" ? "var(--green)" : "var(--amber)" }}>
                  {plan === "max" ? "Auto-receipts active" : "Auto-receipts require Max plan"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 1 }}>
                  {plan === "max"
                    ? "Parents receive an instant WhatsApp message with a receipt download link every time a payment is recorded."
                    : "Upgrade to Max to automatically send WhatsApp receipts to parents the moment a payment is recorded."}
                </div>
              </div>
              {plan !== "max" && <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Max Upgrade" style={{ marginLeft: "auto", padding: "7px 14px", borderRadius: 8, background: "var(--amber)", color: "#1a0f00", fontSize: 12, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>Upgrade →</a>}
            </div>

            {/* Actions + Filters */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: "1 1 180px", minWidth: 160 }}>
                <svg style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="var(--text3)" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                <input style={searchInp} placeholder="Search by student or adm…" value={searchRec} onChange={e => setSearchRec(e.target.value)} />
              </div>
              <select style={selInp} value={filterRecStatus} onChange={e => setFilterRecStatus(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="sent">Sent</option>
                <option value="failed">Failed</option>
              </select>
              <button onClick={() => setShowManualRec(true)} style={{ padding: "9px 18px", borderRadius: 9, fontSize: 13.5, fontWeight: 700, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                + Manual receipt
              </button>
            </div>

            {/* Receipts list */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              {recLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>Loading receipts…</div>
              ) : filteredReceipts.length === 0 ? (
                <EmptyState
                  icon="🧾"
                  title="No receipts yet"
                  sub="Receipts are auto-generated when payments are recorded (Max plan). You can also generate and send receipts manually."
                  action={<button onClick={() => setShowManualRec(true)} style={{ padding: "9px 20px", borderRadius: 9, fontSize: 13, fontWeight: 700, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Send manual receipt</button>}
                />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        {["Student", "Adm", "Class", "Amount", "Method", "Paid on", "Channels", "Type", "Status", ""].map(h => <th key={h} style={{ padding: "10px 14px", fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.7, fontWeight: 600, textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReceipts.map((r, i) => (
                        <tr key={r.id} style={{ borderBottom: i < filteredReceipts.length - 1 ? "1px solid var(--border)" : "none" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <Avatar name={r.studentName} size={28} />
                              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{r.studentName}</span>
                            </div>
                          </td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text3)" }}>{r.admNo || "—"}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text2)" }}>{r.className}</td>
                          <td style={{ padding: "11px 14px", fontSize: 13, color: "var(--green)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>KES {fmt(r.amount)}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text2)", textTransform: "capitalize" }}>{r.method}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>{fmtDate(r.paidAt)}</td>
                          <td style={{ padding: "11px 14px" }}><ChannelBadge channels={r.channels} /></td>
                          <td style={{ padding: "11px 14px" }}>
                            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: r.type === "auto" ? "var(--green-bg)" : "var(--surface2)", color: r.type === "auto" ? "var(--green)" : "var(--text3)", border: `1px solid ${r.type === "auto" ? "var(--green-border)" : "var(--border)"}`, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>
                              {r.type === "auto" ? "Auto" : "Manual"}
                            </span>
                          </td>
                          <td style={{ padding: "11px 14px" }}><StatusPill status={r.status} /></td>
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={() => setPreviewRec(r)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Preview</button>
                              {r.status === "failed" && <button onClick={() => handleResendReceipt(r.id)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--red-bg)", border: "1px solid var(--red-border)", color: "var(--red)", cursor: "pointer", fontFamily: "inherit" }}>Resend</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* WhatsApp receipt flow note */}
            <div style={{ marginTop: 14, padding: "14px 16px", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12.5, color: "var(--text3)", lineHeight: 1.7 }}>
              <strong style={{ color: "var(--text2)" }}>How auto-receipts work:</strong> When a payment is recorded, the parent's WhatsApp number (from their phone on file) receives a message instantly with a secure link to download the PDF receipt. No manual action needed.
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreateInv && <CreateInvoiceModal onClose={() => { setShowCreateInv(false); /* reload */ }} token={token} schoolName={schoolName} />}
      {showManualRec && <ManualReceiptModal onClose={() => { setShowManualRec(false); }} token={token} schoolName={schoolName} />}
      {previewInv && <InvoicePreview invoice={previewInv} school={schoolName} onClose={() => setPreviewInv(null)} />}
      {previewRec && <ReceiptPreview  receipt={previewRec}  school={schoolName} onClose={() => setPreviewRec(null)} />}
    </>
  );
}