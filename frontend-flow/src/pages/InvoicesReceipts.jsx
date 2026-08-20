import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import useAppStore from "../store/useAppStore";
import Pagination from "../components/Pagination";
import analytics from "../analytics/analytics";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";
const PAGE_SIZE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) { return Number(n || 0).toLocaleString(); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" }) : "—"; }
function fmtDatetime(d) { return d ? new Date(d).toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
function initials(name) { return (name || "?").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase(); }
function hue(name) { return ((name || "").charCodeAt(0) * 37 + ((name || "").charCodeAt((name || "").length - 1) || 0) * 13) % 360; }
function studentDisplayLedger(s) {
  const currentTermCharges = Number(s.currentTermCharges ?? s.totalCharges ?? 0);
  const currentTermPaid = Number(s.currentTermPaid ?? s.totalPaid ?? 0);
  const currentTermOutstanding = Number(s.currentTermOutstanding ?? s.outstanding ?? 0);
  if (currentTermCharges > 0) {
    return { charges: currentTermCharges, paid: currentTermPaid, outstanding: currentTermOutstanding };
  }
  return {
    charges: Number(s.lifetimeCharges ?? s.totalCharges ?? 0),
    paid: Number(s.lifetimePaid ?? s.totalPaid ?? 0),
    outstanding: Number(s.lifetimeOutstanding ?? s.outstanding ?? 0),
  };
}

// ─── Plan Gate Banner ─────────────────────────────────────────────────────────
function PlanGate({ feature, plan, children }) {
  const gates = {
    invoices: { required: "pro",  label: "Pro or Max", desc: "Bulk & scheduled invoice delivery via SMS, WhatsApp & Email to parents" },
    receipts: { required: "max",  label: "Max",        desc: "Instant auto-receipts via SMS, WhatsApp & Email on every payment" },
  };
  const order = { free: 0, pro: 1, max: 2 };
  const gate = gates[feature];
  if (!gate || order[plan] >= order[gate.required]) return children;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center", gap: 16 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🔒</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{gate.label} plan required</div>
      <div style={{ fontSize: 13.5, color: "var(--text3)", maxWidth: 340, lineHeight: 1.6 }}>{gate.desc}. Upgrade your plan to unlock this feature.</div>
      <a href="mailto:feeflow254@gmail.com?subject=FeeFlow Upgrade" style={{ padding: "10px 24px", borderRadius: 9, background: "var(--amber)", color: "#1a0f00", fontSize: 13.5, fontWeight: 700, textDecoration: "none", marginTop: 4 }}>Upgrade plan →</a>
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
    paid:      { color: "var(--green)",  bg: "var(--green-bg)",  border: "var(--green-border)",  label: "Paid" },
    pending:   { color: "var(--amber)",  bg: "var(--amber-bg)",  border: "var(--amber-border)",  label: "Pending" },
    scheduled: { color: "var(--blue, #60a5fa)",  bg: "rgba(96,165,250,0.1)",  border: "rgba(96,165,250,0.25)",  label: "Scheduled" },
    overdue:   { color: "var(--red)",    bg: "var(--red-bg)",    border: "var(--red-border)",    label: "Overdue" },
    failed:    { color: "var(--red)",    bg: "var(--red-bg)",    border: "var(--red-border)",    label: "Failed" },
    draft:     { color: "var(--text3)",  bg: "var(--surface2)",  border: "var(--border)",         label: "Draft" },
  };
  const s = map[status] || map.draft;
  return <span style={{ display: "inline-flex", alignItems: "center", width: "fit-content", maxWidth: "100%", whiteSpace: "nowrap", flexShrink: 0, lineHeight: 1, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 20, background: s.bg, color: s.color, border: `1px solid ${s.border}`, letterSpacing: 0.3, textTransform: "uppercase" }}>{s.label}</span>;
}

// ─── SMS Delivery Pill ────────────────────────────────────────────────────────
// Reads AT telco-level delivery: "delivered" = reached handset, "queued" = AT
// accepted but telco hasn't confirmed, "failed" = telco rejected/unreachable.
function SmsPill({ smsStatus, channels }) {
  const hasSms = Array.isArray(channels)
    ? channels.some(c => c === "sms")
    : (channels || "").includes("sms");
  if (!hasSms || !smsStatus) return null;
  const map = {
    delivered: { dot: "#22d3a4", label: "Delivered", title: "Telco confirmed delivery to handset" },
    queued:    { dot: "#f59e0b", label: "Queued",    title: "AT accepted — waiting for telco confirmation" },
    failed:    { dot: "#ef4444", label: "Failed",    title: "Telco rejected or number unreachable" },
  };
  const s = map[smsStatus] || map.queued;
  return (
    <span title={s.title} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", letterSpacing: 0.2, whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.dot, display: "inline-block", flexShrink: 0 }} />
      {s.label}
    </span>
  );
}

// ─── Delivery Channel Badge ───────────────────────────────────────────────────
function ChannelBadge({ channels }) {
  const str = Array.isArray(channels) ? channels.join(",") : (channels || "");
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {str.includes("sms") && <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 10, background: "rgba(34,211,164,0.1)", color: "var(--accent)", border: "1px solid rgba(34,211,164,0.2)", fontWeight: 600 }}>SMS</span>}
      {str.includes("whatsapp") && <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 10, background: "rgba(37,211,102,0.1)", color: "#25d366", border: "1px solid rgba(37,211,102,0.25)", fontWeight: 600 }}>WhatsApp</span>}
      {str.includes("email") && <span style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 10, background: "rgba(96,165,250,0.1)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.2)", fontWeight: 600 }}>Email</span>}
    </div>
  );
}

function WhatsAppPill({ channels }) {
  const hasWa = Array.isArray(channels)
    ? channels.some(c => c === "whatsapp")
    : (channels || "").includes("whatsapp");
  if (!hasWa) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "rgba(37,211,102,0.1)", border: "1px solid rgba(37,211,102,0.25)", color: "#25d366", whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#25d366", display: "inline-block", flexShrink: 0 }} />
      WhatsApp
    </span>
  );
}

// ─── Invoice PDF Preview ──────────────────────────────────────────────────────
function InvoicePreview({ invoice, school, onClose }) {
  const displayFeeTotal = Number(invoice.displayFeeTotal ?? invoice.totalFee ?? invoice.newChargesTotal ?? 0);
  const livePaid     = Number(invoice.totalPaidToDate ?? invoice.livePaid ?? 0);
  const fb = invoice.feeBreakdown?.length
    ? invoice.feeBreakdown
    : [{ typeName: "Fee", amount: displayFeeTotal }];
  const feeSubtotal = fb.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const liveBalance  = Math.max(0, feeSubtotal - livePaid);

  const handlePrint = () => {
    const fb = invoice.feeBreakdown?.length
      ? invoice.feeBreakdown
      : [{ typeName: "Fee", amount: displayFeeTotal }];
    const feeSubtotal = fb.reduce((sum, line) => sum + Number(line.amount || 0), 0);

    const feeRows = fb.map(f => `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #eee">${f.typeName || "Fee"}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${fmt(f.amount)}</td>
      </tr>`).join("");

    const printPaid = livePaid;
    const printBal  = liveBalance;

    const paidRows = `
      ${printPaid > 0 ? `<tr>
        <td style="padding:6px 12px;color:#27ae60;font-weight:600">Previously Paid</td>
        <td style="padding:6px 12px;text-align:right;color:#27ae60;font-weight:600;font-variant-numeric:tabular-nums">KES ${fmt(printPaid)}</td>
      </tr>` : ""}
      <tr style="background:${printBal > 0 ? "#fff5f5" : "#f0fff4"};-webkit-print-color-adjust:exact;print-color-adjust:exact">
        <td style="padding:8px 12px;font-weight:700;color:${printBal > 0 ? "#c00" : "#27ae60"}">Total Due Now</td>
        <td style="padding:8px 12px;text-align:right;font-weight:700;color:${printBal > 0 ? "#c00" : "#27ae60"};font-variant-numeric:tabular-nums">KES ${fmt(printBal)}</td>
      </tr>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Invoice — ${invoice.studentName}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;color:#1a1a2e;padding:36px;font-size:13px;max-width:600px;margin:0 auto}
    .hdr{background:#003366;color:#fff;padding:22px 26px;border-radius:8px;display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .hdr h1{font-size:20px;font-weight:700;margin-bottom:3px}
    .hdr .sub{font-size:11px;opacity:.75;letter-spacing:1px;text-transform:uppercase}
    .hdr .badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:3px 10px;border-radius:20px;font-size:10px;margin-top:6px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:22px}
    .box{background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .box .lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
    .box .val{font-size:14px;font-weight:700;color:#003366}
    .box .inf{font-size:12px;color:#555;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:13px}
    thead tr{background:#003366;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    thead th{padding:9px 12px;text-align:left;font-weight:600;font-size:11px;letter-spacing:.5px}
    .total-row{background:#e8f0fe;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .total-row td{font-weight:700;font-size:14px;color:#003366;border-top:2px solid #003366;padding:10px 12px}
    .note{background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;color:#555;margin-bottom:18px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .footer{font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px;line-height:1.7;margin-top:4px}
    @media print{
      html,body{height:auto;overflow:visible}
      body{padding:20px;max-width:100%}
      *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
      .hdr{background:#003366!important;color:#fff!important}
      thead tr{background:#003366!important;color:#fff!important}
      .total-row{background:#e8f0fe!important}
    }
  </style>
</head>
<body>
  <div class="hdr">
    <div>
      <h1>${school || "School"}</h1>
      <div class="sub">Official Fee Invoice</div>
      <div class="badge">PAYMENT DUE</div>
    </div>
    <div style="text-align:right;font-size:12px">
      <div style="opacity:.75">Invoice No.</div>
      <div style="font-size:14px;font-weight:700">${invoice.invoiceNo || "—"}</div>
      <div style="opacity:.75;margin-top:5px">Issued</div>
      <div>${fmtDate(invoice.issuedAt || invoice.createdAt || new Date())}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="lbl">Billed To</div>
      <div class="val">${invoice.studentName}</div>
      <div class="inf">${invoice.className}${invoice.admNo ? " · Adm: " + invoice.admNo : ""}</div>
      ${invoice.parentName  ? `<div class="inf">Parent: ${invoice.parentName}</div>` : ""}
      ${invoice.parentPhone ? `<div class="inf">Phone: ${invoice.parentPhone}</div>` : ""}
    </div>
    <div class="box">
      <div class="lbl">Payment Due</div>
      <div class="val" style="color:#c00">${fmtDate(invoice.dueDate)}</div>
      ${invoice.termName ? `<div class="inf">Term: ${invoice.termName}</div>` : ""}
    </div>
  </div>

  <table>
    <thead><tr><th>Description</th><th style="text-align:right">Amount (KES)</th></tr></thead>
    <tbody>${feeRows}</tbody>
    <tfoot>
      ${fb.length > 1 ? `<tr class="total-row">
        <td>Subtotal</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">KES ${fmt(feeSubtotal)}</td>
      </tr>` : ""}
      ${paidRows}
    </tfoot>
  </table>

  ${invoice.note ? `<div class="note"><strong>Note:</strong> ${invoice.note}</div>` : ""}

  <div class="footer">
    Please ensure payment is made before the due date. For inquiries, contact ${school || "the school"} administration.<br>
    <em>Generated by FeeFlow · Fee Management Platform</em>
  </div>
</body>
</html>`;

    const filename = "Invoice-" + (invoice.studentName || "student").replace(/[^a-zA-Z0-9]/g, "-") + "-" + (invoice.invoiceNo || "") + ".pdf";

    // Inject html2pdf.js for proper A4 PDF — same library the server-side invoice uses.
    // We replace the closing </head> to insert the script + auto-trigger before page paints.
    const fullHtml = html.replace("</head>", `<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script>
<script>
(function(){
  var tries = 0;
  function attempt() {
    tries++;
    if (typeof html2pdf === "undefined") {
      if (tries < 50) { setTimeout(attempt, 150); return; }
      window.print(); return; // graceful fallback
    }
    html2pdf().set({
      margin: [14, 14, 14, 14],
      filename: "${filename.replace(/"/g, '\"')}",
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: "#ffffff", logging: false, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["avoid-all"] }
    }).from(document.body).save().catch(function(){ window.print(); });
  }
  attempt();
}());
<\/script></head>`);

    const win = window.open("", "_blank");
    if (!win) { alert("Please allow popups for this site to download invoices."); return; }
    win.document.write(fullHtml);
    win.document.close();
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }} />
      <div className="invoice-preview-panel responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 90, width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: 14, boxShadow: "0 32px 80px rgba(0,0,0,0.6)", animation: "modalIn .2s ease" }}>
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
              {fb.map((line, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "9px 12px" }}>{line.typeName}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(line.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {fb.length > 1 && <tr style={{ borderTop: "2px solid #111" }}>
                <td style={{ padding: "10px 12px", fontWeight: 700, fontSize: 14 }}>Subtotal</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>KES {fmt(feeSubtotal)}</td>
              </tr>}
              {livePaid > 0 && <tr>
                <td style={{ padding: "6px 12px", color: "#27ae60" }}>Previously Paid</td>
                <td style={{ padding: "6px 12px", textAlign: "right", color: "#27ae60", fontVariantNumeric: "tabular-nums" }}>KES {fmt(livePaid)}</td>
              </tr>}
              <tr style={{ background: liveBalance > 0 ? "#fff5f5" : "#f0fff4" }}>
                <td style={{ padding: "8px 12px", fontWeight: 700, color: liveBalance > 0 ? "#c00" : "#27ae60" }}>Total Due Now</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: liveBalance > 0 ? "#c00" : "#27ae60", fontVariantNumeric: "tabular-nums" }}>KES {fmt(liveBalance)}</td>
              </tr>
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
          <button onClick={handlePrint} style={{ padding: "9px 18px", borderRadius: 8, background: "#003366", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>⬇ Download / Print PDF</button>
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

// ─── Receipt Preview ──────────────────────────────────────────────────────────
function ReceiptPreview({ receipt, school, onClose }) {
  const METHOD = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash", manual: "Cash" };
  const balance = receipt.balance;

  const handlePrint = () => {
    analytics.track("receipt_downloaded", {
      receiptId: receipt.id,
      amount: receipt.amount,
      paymentMethod: receipt.method,
      studentId: receipt.studentId,
    });
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Receipt — ${receipt.studentName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;color:#1a1a2e;padding:40px;font-size:13px;max-width:480px;margin:0 auto}
.hdr{background:#059669;color:#fff;padding:20px 24px;border-radius:8px;text-align:center;margin-bottom:22px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.hdr h1{font-size:16px;font-weight:700;letter-spacing:1px}
.hdr .sub{font-size:11px;opacity:.8;margin-top:3px;letter-spacing:1px;text-transform:uppercase}
.rec-no{text-align:center;font-size:12px;color:#888;margin-bottom:18px}
.amount-box{background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.amount-box .lbl{font-size:11px;color:#16a34a;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.amount-box .val{font-size:28px;font-weight:800;color:#16a34a}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12.5px}
.row .lbl{color:#666}
.row .val{font-weight:600;text-align:right;max-width:60%}
.bal{border-radius:8px;padding:10px 14px;margin-top:14px;display:flex;justify-content:space-between;font-weight:700;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.footer{text-align:center;font-size:11px;color:#aaa;margin-top:20px;padding-top:14px;border-top:1px dashed #ddd;line-height:1.7}
@media print{
  html,body{height:auto;overflow:visible}
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  body{padding:20px;max-width:100%}
  .hdr{background:#059669!important;color:#fff!important}
}
</style></head><body>
<div class="hdr"><h1>FEEFLOW</h1><div class="sub">${school} · Official Payment Receipt</div></div>
<div class="rec-no">Receipt No: <strong style="font-family:monospace;color:#333">${receipt.receiptNo || "REC-001"}</strong></div>
<div class="amount-box">
  <div class="lbl">Amount Received</div>
  <div class="val">KES ${fmt(receipt.amount)}</div>
</div>
<div class="row"><span class="lbl">Student</span><span class="val">${receipt.studentName}</span></div>
${receipt.admNo   ? `<div class="row"><span class="lbl">Adm. No.</span><span class="val">${receipt.admNo}</span></div>` : ""}
<div class="row"><span class="lbl">Class</span><span class="val">${receipt.className}</span></div>
${receipt.termName ? `<div class="row"><span class="lbl">Term</span><span class="val">${receipt.termName}</span></div>` : ""}
<div class="row"><span class="lbl">Payment Method</span><span class="val">${METHOD[receipt.method] || receipt.method}</span></div>
${receipt.txnRef  ? `<div class="row"><span class="lbl">Transaction Ref</span><span class="val" style="font-family:monospace">${receipt.txnRef}</span></div>` : ""}
<div class="row"><span class="lbl">Date &amp; Time</span><span class="val">${fmtDatetime(receipt.paidAt)}</span></div>
${balance !== undefined
  ? `<div class="bal" style="background:${balance > 0 ? "#fff5f5" : "#f0fdf4"};border:1px solid ${balance > 0 ? "#fecaca" : "#bbf7d0"}">
      <span style="color:${balance > 0 ? "#c00" : "#16a34a"}">Outstanding Balance</span>
      <span style="color:${balance > 0 ? "#c00" : "#16a34a"}">${balance > 0 ? `KES ${fmt(balance)}` : "Cleared ✓"}</span>
    </div>`
  : ""}
<div class="footer">Thank you for your payment · ${school}<br>Powered by FeeFlow · Fee Management Platform</div>
</body></html>`;
    const filename = "Receipt-" + (receipt.studentName || "student").replace(/[^a-zA-Z0-9]/g, "-") + "-" + (receipt.receiptNo || "") + ".pdf";

    // Inject html2pdf.js for proper A4 PDF — same library the server-side invoice uses.
    // We replace the closing </head> to insert the script + auto-trigger before page paints.
    const fullHtml = html.replace("</head>", `<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script>
<script>
(function(){
  var tries = 0;
  function attempt() {
    tries++;
    if (typeof html2pdf === "undefined") {
      if (tries < 50) { setTimeout(attempt, 150); return; }
      window.print(); return; // graceful fallback
    }
    html2pdf().set({
      margin: [14, 14, 14, 14],
      filename: "${filename.replace(/"/g, '\"')}",
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: "#ffffff", logging: false, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["avoid-all"] }
    }).from(document.body).save().catch(function(){ window.print(); });
  }
  attempt();
}());
<\/script></head>`);

    const win = window.open("", "_blank");
    if (!win) { alert("Please allow popups for this site to download invoices."); return; }
    win.document.write(fullHtml);
    win.document.close();
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }} />
      <div className="receipt-preview-panel responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 90, width: "100%", maxWidth: 440, background: "#fff", borderRadius: 14, boxShadow: "0 32px 80px rgba(0,0,0,0.6)", overflow: "hidden", animation: "modalIn .2s ease" }}>
        {/* Green header */}
        <div style={{ background: "#059669", color: "#fff", padding: "20px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>FEEFLOW</div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2, letterSpacing: 1, textTransform: "uppercase" }}>{school} · Official Payment Receipt</div>
        </div>

        <div style={{ padding: 24 }}>
          {/* Receipt no */}
          <div style={{ textAlign: "center", fontSize: 12, color: "#888", marginBottom: 18 }}>
            Receipt No: <strong style={{ color: "#333", fontFamily: "monospace" }}>{receipt.receiptNo || "REC-001"}</strong>
          </div>

          {/* Amount box */}
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: 18, textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: "#16a34a", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Amount Received</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: "#16a34a", fontVariantNumeric: "tabular-nums" }}>KES {fmt(receipt.amount)}</div>
          </div>

          {/* Details */}
          {[
            ["Student",        receipt.studentName],
            receipt.admNo     ? ["Adm. No.",    receipt.admNo]     : null,
            ["Class",          receipt.className],
            receipt.termName  ? ["Term",         receipt.termName]  : null,
            ["Payment Method", METHOD[receipt.method] || receipt.method],
            receipt.txnRef    ? ["Transaction Ref", receipt.txnRef] : null,
            ["Date & Time",    fmtDatetime(receipt.paidAt)],
          ].filter(Boolean).map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f0f0f0", fontSize: 13 }}>
              <span style={{ color: "#666" }}>{k}</span>
              <span style={{ fontWeight: 600, textAlign: "right", maxWidth: "60%", fontFamily: k === "Transaction Ref" ? "monospace" : "inherit" }}>{v}</span>
            </div>
          ))}

          {/* Balance */}
          {balance !== undefined && (
            <div style={{ marginTop: 14, padding: "11px 14px", borderRadius: 9, background: balance > 0 ? "#fff5f5" : "#f0fdf4", border: `1px solid ${balance > 0 ? "#fecaca" : "#bbf7d0"}`, display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 13 }}>
              <span style={{ color: balance > 0 ? "#c00" : "#16a34a" }}>Outstanding Balance</span>
              <span style={{ color: balance > 0 ? "#c00" : "#16a34a" }}>{balance > 0 ? `KES ${fmt(balance)}` : "Cleared ✓"}</span>
            </div>
          )}

          <div style={{ marginTop: 16, fontSize: 11, color: "#aaa", textAlign: "center", lineHeight: 1.7 }}>
            Thank you for your payment · {school}<br/>
            <em>Powered by FeeFlow</em>
          </div>
        </div>

        <div style={{ padding: "14px 24px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end", gap: 10, background: "#fafafa" }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, background: "transparent", border: "1px solid #ddd", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Close</button>
          <button onClick={handlePrint} style={{ padding: "9px 18px", borderRadius: 8, background: "#059669", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>⬇ Download / Print PDF</button>
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}

// ─── Create Invoice Modal ─────────────────────────────────────────────────────
function CreateInvoiceModal({ onClose, token, schoolName }) {
  const students = useAppStore(s => s.students);
  const [step,         setStep]         = useState(1);
  const [selectedIds,  setSelectedIds]  = useState([]);
  const [filterClass,  setFilterClass]  = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [dueDate,      setDueDate]      = useState("");
  const [sendDate,     setSendDate]     = useState("");
  const [sendTime,     setSendTime]     = useState("08:00");
  const [channels,     setChannels]     = useState(["sms"]);
  const [note,         setNote]         = useState("");
  const [termName,     setTermName]     = useState("");
  const [sending,      setSending]      = useState(false);
  const [error,        setError]        = useState("");

  // ── Fee breakdown state (Step 3, max 3 students) ──────────────────────────
  // Each item: { id, typeName, amount, enabled }
  // "enabled" drives whether it appears on the invoice
  const [feeItems,    setFeeItems]    = useState([]);
  const [invoiceQuote, setInvoiceQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const initialLoadDone = useRef(false);
  const initialPreviewKey = useRef("");

  const isSmallBatch   = selectedIds.length > 0 && selectedIds.length <= 3;
  const totalSteps     = isSmallBatch ? 4 : 3; // 1=select 2=configure 3=fee+preview 4=review  OR  1=select 2=configure 3=review
  const STEP_LABELS    = isSmallBatch
    ? ["Select students", "Configure & schedule", "Fee breakdown & preview", "Review & send"]
    : ["Select students", "Configure & schedule", "Review & send"];

  const allClasses = useMemo(() => [...new Set(students.map(s => s.cls))].filter(Boolean).sort(), [students]);
  const filtered   = useMemo(() => students.filter(s =>
    {
      const display = studentDisplayLedger(s);
      return (
    (filterClass  === "all" || s.cls === filterClass) &&
    (filterStatus === "all" ||
      (filterStatus === "unpaid"  && display.paid <= 0) ||
      (filterStatus === "partial" && display.paid > 0 && display.outstanding > 0) ||
      (filterStatus === "overdue" && display.outstanding > 0))
      );
    }
  ), [students, filterClass, filterStatus]);

  const toggleStudent = id => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleAll     = () => setSelectedIds(selectedIds.length === filtered.length ? [] : filtered.map(s => s.id));
  const toggleChannel = ch => setChannels(prev => prev.includes(ch) ? prev.filter(x => x !== ch) : [...prev, ch]);

  const selectedStudents = students.filter(s => selectedIds.includes(s.id));
  const totalFee         = selectedStudents.reduce((a, s) => a + studentDisplayLedger(s).charges, 0);

  useEffect(() => {
    initialLoadDone.current = false;
    initialPreviewKey.current = "";
  }, [selectedIds.join(",")]);

  const previewKeyFor = useCallback(items => items
    .filter(f => f.enabled && f.typeName && parseFloat(f.amount) > 0)
    .map(f => `${f.typeName}:${parseFloat(f.amount)}`)
    .join("|"), []);

  const loadInitialFeePreview = async (first) => {
    if (!first) return;
    setInvoiceQuote(null);
    setQuoteLoading(true);
    setQuoteError("");
    try {
      const res = await axios.post(`${API}/api/invoices/preview`, {
        studentId: first.id,
      }, { headers: { Authorization: `Bearer ${token}` } });

      const src = (res.data.feeLines || [])
        .filter(f => f.amount > 0)
        .map((f) => ({
          id: f.id || null,
          typeName: f.typeName || f.description || "Fee",
          type: f.type || null,
          amount: Number(f.amount),
          enabled: true,
          alreadyCharged: f.alreadyCharged ?? true,
        }));

      if (src.length === 0) {
        setFeeItems([]);
        setInvoiceQuote(null);
        setQuoteError("This student has no fee charges yet. Add fees from their profile before invoicing.");
        initialLoadDone.current = true;
        return;
      }

      setFeeItems(src);
      setInvoiceQuote(res.data);
      initialPreviewKey.current = previewKeyFor(src);
      initialLoadDone.current = true;
    } catch (e) {
      setInvoiceQuote(null);
      setQuoteError(e.response?.data?.message || "Could not load ledger invoice preview.");
      initialLoadDone.current = true;
    } finally {
      setQuoteLoading(false);
    }
  };

  const activeFeeItems   = feeItems.filter(f => f.enabled && f.typeName && parseFloat(f.amount) > 0);
  const selectedChargeIds = activeFeeItems.map(f => f.id).filter(id => id != null);
  const activeFeeTotal   = activeFeeItems.reduce((s, f) => s + parseFloat(f.amount), 0);

  useEffect(() => {
    const first = selectedStudents[0];
    if (!token || step !== 3 || !isSmallBatch || !first) {
      setInvoiceQuote(null);
      setQuoteLoading(false);
      setQuoteError("");
      return;
    }
    if (!initialLoadDone.current) return;
    const currentPreviewKey = previewKeyFor(feeItems);
    if (initialPreviewKey.current && currentPreviewKey === initialPreviewKey.current) {
      initialPreviewKey.current = "";
      return;
    }
    if (activeFeeItems.length === 0) {
      setInvoiceQuote(null);
      setQuoteLoading(false);
      setQuoteError("");
      return;
    }
    setInvoiceQuote(null);
    setQuoteLoading(true);
    setQuoteError("");
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await axios.post(`${API}/api/invoices/preview`, {
          studentId: first.id,
          selectedChargeIds,
        }, { headers: { Authorization: `Bearer ${token}` } });
        if (!cancelled) setInvoiceQuote(res.data);
      } catch (e) {
        if (!cancelled) {
          setInvoiceQuote(null);
          setQuoteError(e.response?.data?.message || "Could not load ledger invoice preview.");
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [token, step, isSmallBatch, selectedIds.join(","), selectedChargeIds.join(","), selectedStudents[0]?.id, previewKeyFor]);

  const toggleFeeItem = id => setFeeItems(prev => prev.map(f => f.id === id ? { ...f, enabled: !f.enabled } : f));
  const selectAll     = () => setFeeItems(prev => prev.map(f => ({ ...f, enabled: true })));
  const deselectAll   = () => setFeeItems(prev => prev.map(f => ({ ...f, enabled: false })));
  const removeFeeItem = id => setFeeItems(prev => prev.filter(f => f.id !== id));

  const handleSchedule = async () => {
    if (!dueDate)              { setError("Due date is required"); return; }
    if (channels.length === 0) { setError("Select at least one delivery channel"); return; }
    if (selectedIds.length === 0) { setError("Select at least one student"); return; }
    const missing = selectedStudents.filter(s => {
      if (channels.includes("sms")   && !s.parentPhone) return true;
      if (channels.includes("email") && !s.email && !s.parentEmail) return true;
      if (channels.includes("whatsapp") && !s.parentPhone) return true;
      return false;
    });
    if (missing.length > 0) { setError(`${missing.length} student(s) missing required contact info.`); return; }
    setSending(true); setError("");
    try {
      await axios.post(`${API}/api/invoices`, {
        studentIds: selectedIds,
        dueDate,
        sendDate: sendDate ? `${sendDate}T${sendTime}:00` : null,
        selectedChargeIds,
        channels,
        note,
        termName,
      }, { headers: { Authorization: `Bearer ${token}` } });
      analytics.track("invoice_created", {
        amount: isSmallBatch ? activeFeeTotal : null,
        studentCount: selectedIds.length,
        studentId: selectedIds.length === 1 ? selectedIds[0] : null,
        className: selectedStudents[0]?.cls || null,
        channels,
      });
      analytics.track("invoice_sent", {
        scheduled: Boolean(sendDate),
        studentCount: selectedIds.length,
        channels,
      });
      onClose(true);
    } catch (e) { setError(e.response?.data?.message || "Failed to send invoices."); }
    finally { setSending(false); }
  };

  const goNext = () => {
    setError("");
    if (step === 1) {
      if (selectedIds.length === 0) { setError("Select at least one student"); return; }
      setStep(2); return;
    }
    if (step === 2) {
      if (!dueDate) { setError("Payment due date is required"); return; }
      if (channels.length === 0) { setError("Select at least one delivery channel"); return; }
      if (isSmallBatch) {
        const first = selectedStudents[0];
        setFeeItems([]);
        setStep(3);
        loadInitialFeePreview(first);
        return;
      }
      setStep(3); return;
    }
    if (step === 3 && isSmallBatch) {
      if (activeFeeItems.length === 0) { setError("Select at least one fee item to include on the invoice"); return; }
      if (quoteLoading) { setError("Invoice preview is still loading."); return; }
      if (quoteError || !invoiceQuote) { setError(quoteError || "Invoice preview is required before continuing."); return; }
      setStep(4); return;
    }
    setStep(s => s + 1);
  };

  const inp = { width: "100%", height: 40, padding: "0 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div className="create-invoice-modal responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 60, width: "100%", maxWidth: 580, maxHeight: "92vh", display: "flex", flexDirection: "column", background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 28px 70px rgba(0,0,0,0.5)", animation: "modalIn .2s ease" }}>
        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Create Invoice Batch</div>
              <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>Step {step} of {totalSteps} — {STEP_LABELS[step - 1]}</div>
            </div>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 16 }}>×</button>
          </div>
          {/* Step bar */}
          <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
            {Array.from({ length: totalSteps }, (_, i) => (
              <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= i + 1 ? "var(--accent)" : "var(--surface3)", transition: "background .3s" }} />
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
                  const display = studentDisplayLedger(s);
                  const balance  = display.outstanding;
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
                          {!hasPh && <span style={{ fontSize: 10, color: "var(--amber)", background: "var(--amber-bg)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--amber-border)" }}>No SMS</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text3)" }}>{s.cls} · {s.adm}</div>
                      </div>
                      <div style={{ textAlign: "right", fontSize: 12 }}>
                        <div style={{ color: balance > 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }}>KES {fmt(balance > 0 ? balance : display.charges)}</div>
                        <div style={{ color: "var(--text3)" }}>{balance > 0 ? "balance" : "total"}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Step 2: Configure & Schedule ── */}
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
                    <label className="settings-label">Send date <span style={{ color: "var(--text3)", fontWeight: 400 }}>(blank = send now)</span></label>
                    <input type="date" style={inp} value={sendDate} onChange={e => setSendDate(e.target.value)} min={new Date().toISOString().split("T")[0]} />
                  </div>
                  <div className="field-group">
                    <label className="settings-label">Send time</label>
                    <input type="time" style={inp} value={sendTime} onChange={e => setSendTime(e.target.value)} />
                  </div>
                </div>
                {sendDate
                  ? <div style={{ fontSize: 12, color: "var(--accent)", background: "var(--green-bg)", border: "1px solid var(--green-border)", padding: "8px 12px", borderRadius: 7 }}>📅 Invoices will be sent on {fmtDate(sendDate)} at {sendTime}</div>
                  : <div style={{ fontSize: 12, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", padding: "8px 12px", borderRadius: 7 }}>⚡ No schedule — invoices sent immediately on confirm</div>
                }
              </div>
              <div className="field-group">
                <label className="settings-label">Delivery channels *</label>
                <div style={{ display: "flex", gap: 10 }}>
                  {[
                    { id: "sms",   label: "📱 SMS",   desc: "Via parent phone number" },
                    { id: "email", label: "✉️ Email", desc: "Via parent email address" },
                    { id: "whatsapp", label: "💬 WhatsApp", desc: "Via parent WhatsApp number" },
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
                <textarea style={{ ...inp, height: 72, padding: "10px 12px", resize: "vertical" }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Kindly pay before the start of the new term." />
              </div>
              {(() => {
                const noPhone = selectedStudents.filter(s => !s.parentPhone).length;
                if ((channels.includes("sms") || channels.includes("whatsapp")) && noPhone > 0)
                  return <div style={{ fontSize: 12.5, color: "var(--amber)", background: "var(--amber-bg)", border: "1px solid var(--amber-border)", padding: "10px 14px", borderRadius: 8 }}>⚠ {noPhone} student(s) have no parent phone — SMS/WhatsApp will be skipped for them.</div>;
                return null;
              })()}
            </div>
          )}

          {/* ── Step 3 (small batch ≤3 only): Fee Breakdown + Live Preview ── */}
          {step === 3 && isSmallBatch && (() => {
            const prev = selectedStudents[0];
            if (!prev) return null;
            const previewReady = Boolean(invoiceQuote) && !quoteLoading && !quoteError;
            const previewLines = Array.isArray(invoiceQuote?.feeLines) ? invoiceQuote.feeLines : [];
            const dedupedNewCharges = Number(invoiceQuote?.newChargesTotal ?? 0);
            const displayFeeTotal = Number(invoiceQuote?.displayFeeTotal ?? previewLines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
            const paidToDate = Number(invoiceQuote?.totalPaidToDate ?? 0);
            const balance = Number(invoiceQuote?.totalDueNow ?? 0);
            const dueDateFmt = dueDate ? new Date(dueDate).toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" }) : "—";
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, padding: "11px 14px", fontSize: 12.5, color: "var(--text3)", lineHeight: 1.6 }}>
                  👁 Previewing for <strong style={{ color: "var(--text)" }}>{prev.name}</strong>.{selectedIds.length > 1 && <> All <strong style={{ color: "var(--text)" }}>{selectedIds.length}</strong> students will receive the same fee breakdown.</>}
                </div>

                {/* Fee selector */}
                <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>📋 Select fees to include</div>
                      <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                        Total due now: {previewReady ? <strong style={{ color: "var(--red)" }}>KES {balance.toLocaleString()}</strong> : <strong style={{ color: "var(--text3)" }}>Loading preview...</strong>}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={selectAll}   style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--green-bg)", border: "1px solid var(--green-border)", color: "var(--accent)", cursor: "pointer", fontFamily: "inherit" }}>All</button>
                      <button onClick={deselectAll} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--surface3)", border: "1px solid var(--border)", color: "var(--text3)", cursor: "pointer", fontFamily: "inherit" }}>None</button>
                    </div>
                  </div>
                  {feeItems.map(f => (
                    <div key={f.id} onClick={() => toggleFeeItem(f.id)}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border)", background: f.enabled ? "var(--green-bg)" : "transparent", cursor: "pointer", transition: "background .12s" }}>
                      <div style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, border: `2px solid ${f.enabled ? "var(--accent)" : "var(--border)"}`, background: f.enabled ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {f.enabled && <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="#0b1a14" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: f.enabled ? "var(--text)" : "var(--text3)", textDecoration: f.enabled ? "none" : "line-through" }}>{f.typeName}</div>
                        <span
                          title={f.alreadyCharged === false ? "This is a new fee that will be added to the student's ledger when this invoice is sent." : "This charge already exists on the student's ledger. Including it on this invoice reminds the parent but does not double-charge them."}
                          style={{
                            display: "inline-flex",
                            width: "fit-content",
                            marginTop: 4,
                            padding: "2px 7px",
                            borderRadius: 999,
                            fontSize: 10.5,
                            fontWeight: 700,
                            lineHeight: 1.2,
                            color: f.alreadyCharged === false ? "var(--accent)" : "var(--text3)",
                            background: f.alreadyCharged === false ? "var(--green-bg)" : "var(--surface2)",
                            border: `1px solid ${f.alreadyCharged === false ? "var(--green-border)" : "var(--border)"}`,
                          }}
                        >
                          {f.alreadyCharged === false ? "New charge" : "Existing charge"}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: f.enabled ? "var(--accent)" : "var(--text3)", fontVariantNumeric: "tabular-nums" }}>KES {Number(f.amount).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "11px 16px" }}>
                    <span style={{ fontSize: 12.5, color: "var(--text3)" }}>{activeFeeItems.length} fee{activeFeeItems.length !== 1 ? "s" : ""} selected</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>New: {previewReady ? `KES ${dedupedNewCharges.toLocaleString()}` : "..."}</span>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>Subtotal: {previewReady ? `KES ${displayFeeTotal.toLocaleString()}` : "..."}</span>
                    </div>
                  </div>
                </div>

                {/* Live invoice preview */}
                {quoteError && <div className="modal-error">{quoteError}</div>}
                {!previewReady ? (
                  <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, display: "grid", gap: 12 }}>
                    <div style={{ height: 18, width: "42%", borderRadius: 5, background: "var(--surface3)" }} />
                    <div style={{ height: 12, width: "70%", borderRadius: 5, background: "var(--surface3)" }} />
                    <div style={{ height: 120, borderRadius: 8, background: "var(--surface3)" }} />
                    <div style={{ height: 16, width: "55%", borderRadius: 5, background: "var(--surface3)", justifySelf: "end" }} />
                  </div>
                ) : (
                <div style={{ background: "#fff", borderRadius: 12, color: "#111", fontFamily: "Arial,sans-serif", boxShadow: "0 4px 20px rgba(0,0,0,0.15)", overflow: "hidden" }}>
                  <div style={{ background: "#003366", color: "#fff", padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{schoolName}</div>
                      <div style={{ fontSize: 10, opacity: 0.75, textTransform: "uppercase", letterSpacing: 1, marginTop: 3 }}>Official Fee Invoice</div>
                      <div style={{ display: "inline-block", marginTop: 7, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.3)", padding: "2px 10px", borderRadius: 20, fontSize: 9, letterSpacing: 1 }}>PAYMENT DUE</div>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 11 }}>
                      <div style={{ opacity: 0.7 }}>Invoice No.</div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>INV-{new Date().getFullYear()}-{String(prev.adm || "AUTO").replace(/\W/g, "").slice(0, 6)}</div>
                    </div>
                  </div>
                  <div style={{ padding: "16px 22px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                      <div style={{ background: "#f7f9fc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "12px 14px" }}>
                        <div style={{ fontSize: 9, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Billed To</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#003366" }}>{prev.name}</div>
                        <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{prev.cls}{prev.adm ? ` · Adm: ${prev.adm}` : ""}</div>
                        {prev.parentName  && <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Parent: {prev.parentName}</div>}
                        {prev.parentPhone && <div style={{ fontSize: 11, color: "#555" }}>Phone: {prev.parentPhone}</div>}
                      </div>
                      <div style={{ background: "#f7f9fc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "12px 14px" }}>
                        <div style={{ fontSize: 9, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Payment Due</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#c00" }}>{dueDateFmt}</div>
                        {termName && <div style={{ fontSize: 11, color: "#555", marginTop: 3 }}>Term: {termName}</div>}
                      </div>
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 0 }}>
                      <thead>
                        <tr style={{ background: "#003366", color: "#fff" }}>
                          <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11 }}>Description</th>
                          <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, fontSize: 11 }}>Amount (KES)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewLines.length > 0
                          ? previewLines.map((f, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                                <td style={{ padding: "9px 12px" }}>{f.typeName}</td>
                                <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Number(f.amount).toLocaleString()}</td>
                              </tr>
                            ))
                          : <tr><td colSpan={2} style={{ padding: 14, color: "#bbb", textAlign: "center", fontSize: 12, fontStyle: "italic" }}>No fees selected — tick items above</td></tr>
                        }
                      </tbody>
                      <tfoot>
                        {previewLines.length > 1 && <tr style={{ background: "#e8f0fe" }}>
                          <td style={{ padding: "10px 12px", fontWeight: 700, fontSize: 14, color: "#003366", borderTop: "2px solid #003366" }}>Subtotal</td>
                          <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, fontSize: 14, color: "#003366", borderTop: "2px solid #003366", fontVariantNumeric: "tabular-nums" }}>KES {displayFeeTotal.toLocaleString()}</td>
                        </tr>}
                        {paidToDate > 0 && <tr>
                          <td style={{ padding: "7px 12px", fontWeight: 600, color: "#16a34a" }}>Previously Paid</td>
                          <td style={{ padding: "7px 12px", textAlign: "right", fontWeight: 600, color: "#16a34a", fontVariantNumeric: "tabular-nums" }}>KES {paidToDate.toLocaleString()}</td>
                        </tr>}
                        <tr style={{ background: balance > 0 ? "#fff5f5" : "#f0fdf4" }}>
                          <td style={{ padding: "8px 12px", fontWeight: 700, color: balance > 0 ? "#c00" : "#16a34a" }}>Total Due Now</td>
                          <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: balance > 0 ? "#c00" : "#16a34a", fontVariantNumeric: "tabular-nums" }}>KES {balance.toLocaleString()}</td>
                        </tr>
                      </tfoot>
                    </table>
                    {note && <div style={{ marginTop: 12, fontSize: 11, color: "#555", background: "#f9f9f9", borderRadius: 6, padding: "8px 10px" }}><strong>Note:</strong> {note}</div>}
                    <div style={{ marginTop: 12, fontSize: 10, color: "#bbb", borderTop: "1px solid #eee", paddingTop: 10 }}>Please ensure payment is made before the due date · <em>Powered by FeeFlow</em></div>
                  </div>
                </div>
                )}
                {selectedIds.length > 1 && <div style={{ fontSize: 12, color: "var(--text3)", textAlign: "center" }}>+ {selectedIds.length - 1} more student{selectedIds.length > 2 ? "s" : ""} will receive a similar invoice</div>}
              </div>
            );
          })()}

          {/* ── Final Review step ── */}
          {((isSmallBatch && step === 4) || (!isSmallBatch && step === 3)) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
                {[
                  ["Recipients",  `${selectedIds.length} student${selectedIds.length > 1 ? "s" : ""}`],
                  ["Term",        termName || "—"],
                  ["Due date",    fmtDate(dueDate)],
                  ["Send",        sendDate ? `${fmtDate(sendDate)} at ${sendTime}` : "Immediately"],
                  ["Channels",    channels.map(ch => ch === "sms" ? "SMS" : ch.charAt(0).toUpperCase() + ch.slice(1)).join(" + ") || "—"],
                  ...(isSmallBatch && activeFeeItems.length > 0
                    ? [["Fee items", activeFeeItems.map(f => f.typeName).join(", ")], ["Invoice total", `KES ${activeFeeTotal.toLocaleString()}`]]
                    : [["Total fees", `KES ${fmt(totalFee)}`]]
                  ),
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 12.5, color: "var(--text3)", flexShrink: 0 }}>{k}</span>
                    <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500, textAlign: "right", maxWidth: "65%" }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text3)", background: "var(--surface2)", borderRadius: 9, padding: "12px 14px", border: "1px solid var(--border)", lineHeight: 1.7 }}>
                {channels.includes("sms") ? "A secure invoice link will be sent via SMS to each parent. They can view and download the PDF directly." : "Invoices will be delivered via the selected channels."}
              </div>
              {error && <div className="modal-error">{error}</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10, flexShrink: 0 }}>
          <button onClick={() => step > 1 ? setStep(s => s - 1) : onClose()} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
            {step > 1 ? "← Back" : "Cancel"}
          </button>
          {step < totalSteps ? (
            <button onClick={goNext} disabled={step === 1 && selectedIds.length === 0}
              style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: selectedIds.length > 0 || step > 1 ? "var(--accent)" : "var(--surface2)", border: "none", color: selectedIds.length > 0 || step > 1 ? "#0b1a14" : "var(--text3)", cursor: selectedIds.length > 0 || step > 1 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
              {step === totalSteps - 1 ? "Confirm & continue →" : "Next →"}
            </button>
          ) : (
            <button onClick={handleSchedule} disabled={sending}
              style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: sending ? "var(--surface2)" : "var(--accent)", border: "none", color: sending ? "var(--text3)" : "#0b1a14", cursor: sending ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {sending ? "Sending…" : sendDate ? "📅 Schedule invoices" : "⚡ Send now"}
            </button>
          )}
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
  const [channels,  setChannels]  = useState(["sms"]);
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
      analytics.track("receipt_generated", {
        studentId,
        paymentId,
        amount: selectedPayment?.amount || null,
        channels,
      });
      onClose();
    } catch (e) { setError(e.response?.data?.message || "Failed to send receipt."); }
    finally { setSending(false); }
  };

  const inp = { width: "100%", height: 40, padding: "0 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div className="manual-receipt-modal responsive-modal-panel" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 60, width: "100%", maxWidth: 460, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 28px 70px rgba(0,0,0,0.5)", animation: "modalIn .2s ease" }}>
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
              {[
                { id: "sms", label: "📱 SMS", desc: "Via parent phone number" },
                { id: "email", label: "✉️ Email", desc: "Via parent email address" },
                { id: "whatsapp", label: "💬 WhatsApp", desc: "Via parent WhatsApp number" },
              ].map(ch => {
                const active = channels.includes(ch.id);
                return (
                  <div key={ch.id} onClick={() => setChannels(prev => prev.includes(ch.id) ? prev.filter(x => x !== ch.id) : [...prev, ch.id])} style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: `2px solid ${active ? "var(--accent)" : "var(--border)"}`, background: active ? "var(--green-bg)" : "var(--surface2)", cursor: "pointer", textAlign: "center", color: active ? "var(--text)" : "var(--text2)" }}>
                    <div style={{ fontSize: 13.5, fontWeight: active ? 600 : 400 }}>{ch.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{ch.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {selectedPayment && (
            <button onClick={() => setPreview({ ...selectedPayment, studentName: selectedStudent?.name, admNo: selectedStudent?.adm, className: selectedStudent?.cls, balance: selectedStudent ? studentDisplayLedger(selectedStudent).outstanding : 0 })} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 13, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
              👁 Preview receipt
            </button>
          )}

          {error && <div className="modal-error">{error}</div>}
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
function InvoiceMobileCard({ inv, schoolName, onPreview, onResend }) {
  return (
    <div className="mobile-record-card">
      <div className="mobile-record-main">
        <Avatar name={inv.studentName} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mobile-record-title">{inv.studentName}</div>
          <div className="mobile-record-meta">{inv.className} | Adm: {inv.admNo || "-"}</div>
        </div>
        <StatusPill status={inv.status} />
      </div>
      <div className="mobile-record-grid">
        <div><span>Due date</span><strong>{fmtDate(inv.dueDate)}</strong></div>
        <div><span>Scheduled</span><strong>{inv.scheduledFor ? fmtDatetime(inv.scheduledFor) : "Sent now"}</strong></div>
        <div><span>SMS</span><SmsPill smsStatus={inv.smsStatus} channels={inv.channels} /><WhatsAppPill channels={inv.channels} /></div>
      </div>
      <div className="mobile-record-footer">
        <ChannelBadge channels={inv.channels} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => onPreview({ ...inv, school: schoolName })} className="mobile-record-btn">Preview</button>
          {inv.status === "failed" && onResend && <button onClick={() => onResend(inv.id)} className="mobile-record-btn danger">Resend</button>}
        </div>
      </div>
    </div>
  );
}

function ReceiptMobileCard({ receipt, onPreview, onResend }) {
  return (
    <div className="mobile-record-card">
      <div className="mobile-record-main">
        <Avatar name={receipt.studentName} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mobile-record-title">{receipt.studentName}</div>
          <div className="mobile-record-meta">{receipt.className} | Adm: {receipt.admNo || "-"}</div>
        </div>
        <StatusPill status={receipt.status} />
      </div>
      <div className="mobile-record-grid">
        <div><span>Amount</span><strong>KES {fmt(receipt.amount)}</strong></div>
        <div><span>Method</span><strong style={{ textTransform: "capitalize" }}>{receipt.method}</strong></div>
        <div><span>Paid on</span><strong>{fmtDate(receipt.paidAt)}</strong></div>
        <div><span>Type</span><strong>{receipt.type === "auto" ? "Auto" : "Manual"}</strong></div>
      </div>
      <div className="mobile-record-footer">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <ChannelBadge channels={receipt.channels} />
          <SmsPill smsStatus={receipt.smsStatus} channels={receipt.channels} />
          <WhatsAppPill channels={receipt.channels} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => onPreview(receipt)} className="mobile-record-btn">Preview</button>
          {receipt.status === "failed" && onResend && <button onClick={() => onResend(receipt.id)} className="mobile-record-btn danger">Resend</button>}
        </div>
      </div>
    </div>
  );
}

export default function InvoicesReceipts() {
  const { token, user, plan, canUse, hasPermission } = useAuth();
  const { openSidebar }                             = useOutletContext();
  const students                                    = useAppStore(s => s.students);

  const canViewInvoices = hasPermission('invoices.view');
  const canViewReceipts = hasPermission('receipts.view');
  const canCreateInvoices = hasPermission('invoices.create');
  const canSendInvoices = hasPermission('invoices.send');

  const [tab,            setTab]            = useState("invoices");
  const [invPage,        setInvPage]        = useState(1);
  const [recPage,        setRecPage]        = useState(1);
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
  const [mobileView,     setMobileView]     = useState(window.innerWidth < 768);

  const schoolName = user?.schoolName || "School";

  useEffect(() => {
    const onResize = () => setMobileView(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const loadInvoices = useCallback(() => {
    if (!canUse("invoices")) return Promise.resolve();
    setInvLoading(true);
    return axios.get(`${API}/api/invoices`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setInvoices(Array.isArray(r.data) ? r.data : (r.data?.data || [])))
      .catch(() => {})
      .finally(() => setInvLoading(false));
  }, [token, canUse]);

  // ── Load invoices ──
  useEffect(() => {
    if (tab !== "invoices") return;
    loadInvoices();
  }, [tab, loadInvoices]);

  // ── Load receipts ──
  useEffect(() => {
    if (tab !== "receipts") return;
    setRecLoading(true);
    axios.get(`${API}/api/receipts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setReceipts(Array.isArray(r.data) ? r.data : (r.data?.data || [])))
      .catch(() => {})
      .finally(() => setRecLoading(false));
  }, [tab, token]);

  const handleResendInvoice = async (id) => {
    if (!canSendInvoices) return;
    try {
      await axios.post(`${API}/api/invoices/${id}/resend`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, status: "sent" } : inv));
      analytics.track("invoice_sent", { invoiceId: id, resend: true });
    } catch {}
  };

  const handleResendReceipt = async (id) => {
    try {
      await axios.post(`${API}/api/receipts/${id}/resend`, {}, { headers: { Authorization: `Bearer ${token}` } });
      setReceipts(prev => prev.map(r => r.id === id ? { ...r, status: "sent" } : r));
      analytics.track("receipt_generated", { receiptId: id, resend: true });
    } catch {}
  };

  // Reset pages when tab changes
  useEffect(() => { setInvPage(1); setRecPage(1); }, [tab]);

  const filteredInvoices = useMemo(() => invoices.filter(inv =>
    (filterInvStatus === "all"            || inv.status === filterInvStatus ||
     (filterInvStatus === "sms_delivered" && inv.smsStatus === "delivered") ||
     (filterInvStatus === "sms_queued"    && inv.smsStatus === "queued")    ||
     (filterInvStatus === "sms_failed"    && inv.smsStatus === "failed")) &&
    (searchInv === "" || (inv.studentName || "").toLowerCase().includes(searchInv.toLowerCase()) || (inv.admNo || "").toLowerCase().includes(searchInv.toLowerCase()))
  ), [invoices, filterInvStatus, searchInv]);

  const invTotalPages   = Math.ceil(filteredInvoices.length / PAGE_SIZE);
  const paginatedInv     = useMemo(() => filteredInvoices.slice((invPage-1)*PAGE_SIZE, invPage*PAGE_SIZE), [filteredInvoices, invPage]);

  const filteredReceipts = useMemo(() => receipts.filter(r =>
    (filterRecStatus === "all"            || r.status === filterRecStatus ||
     (filterRecStatus === "sms_delivered" && r.smsStatus === "delivered") ||
     (filterRecStatus === "sms_queued"    && r.smsStatus === "queued")    ||
     (filterRecStatus === "sms_failed"    && r.smsStatus === "failed")) &&
    (searchRec === "" || (r.studentName || "").toLowerCase().includes(searchRec.toLowerCase()) || (r.admNo || "").toLowerCase().includes(searchRec.toLowerCase()))
  ), [receipts, filterRecStatus, searchRec]);

  // ── Stats ──
  const invStats = useMemo(() => ({
    total:        invoices.length,
    sent:         invoices.filter(i => i.status === "sent").length,
    scheduled:    invoices.filter(i => i.status === "scheduled").length,
    failed:       invoices.filter(i => i.status === "failed").length,
    smsDelivered: invoices.filter(i => i.smsStatus === "delivered").length,
    smsFailed:    invoices.filter(i => i.smsStatus === "failed").length,
  }), [invoices]);

  const recStats = useMemo(() => ({
    total:  receipts.length,
    sent:   receipts.filter(r => r.status === "sent").length,
    auto:   receipts.filter(r => r.type === "auto").length,
    manual: receipts.filter(r => r.type === "manual").length,
  }), [receipts]);

  const tabOptions = [
    ...(canViewInvoices ? [{ id: 'invoices', label: '📄 Invoices', badge: invStats.scheduled > 0 ? invStats.scheduled : null }] : []),
    ...(canViewReceipts ? [{ id: 'receipts', label: '🧾 Receipts', badge: recStats.total > 0 ? recStats.total : null }] : []),
  ];

  const searchInp = { height: 38, padding: "0 12px 0 36px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit", flex: "1 1 180px", minWidth: 160 };
  const selInp    = { height: 38, padding: "0 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 13.5, outline: "none", fontFamily: "inherit" };

  const recTotalPages   = Math.ceil(filteredReceipts.length / PAGE_SIZE);
  const paginatedRec     = useMemo(() => filteredReceipts.slice((recPage-1)*PAGE_SIZE, recPage*PAGE_SIZE), [filteredReceipts, recPage]);

  useEffect(() => {
    const availableTabs = [
      ...(canViewInvoices ? ['invoices'] : []),
      ...(canViewReceipts ? ['receipts'] : []),
    ];
    if (!availableTabs.includes(tab) && availableTabs.length > 0) {
      setTab(availableTabs[0]);
    }
  }, [canViewInvoices, canViewReceipts, tab]);

  return (
    <>
      <Topbar title="Invoices & Receipts" sub="Manage fee communications" onMenuClick={openSidebar} />

      <div className="page-content">
        {/* ── Tab bar ── */}
        <div style={{ display: "flex", gap: 4, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 11, padding: 4, marginBottom: 22, width: "fit-content" }}>
          {tabOptions.map(t => (
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
                { label: "Total sent",    value: invStats.sent,         color: "var(--green)"         },
                { label: "Scheduled",     value: invStats.scheduled,    color: "var(--blue, #60a5fa)" },
                { label: "Failed",        value: invStats.failed,       color: "var(--red)"           },
                { label: "SMS Delivered", value: invStats.smsDelivered, color: "#22d3a4"              },
                { label: "SMS Failed",    value: invStats.smsFailed,    color: "#ef4444"              },
                { label: "All invoices",  value: invStats.total,        color: "var(--text)"          },
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
                <option value="sms_delivered">SMS Delivered</option>
                <option value="sms_queued">SMS Queued</option>
                <option value="sms_failed">SMS Failed</option>
              </select>
              <button
                disabled={!canCreateInvoices}
                onClick={() => canCreateInvoices && setShowCreateInv(true)}
                style={{ padding: "9px 18px", borderRadius: 9, fontSize: 13.5, fontWeight: 700, background: canCreateInvoices ? "var(--accent)" : "var(--surface)", border: "none", color: canCreateInvoices ? "#0b1a14" : "var(--text3)", cursor: canCreateInvoices ? "pointer" : "not-allowed", fontFamily: "inherit", whiteSpace: "nowrap" }}>
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
                  sub="Create an invoice batch to send fee notifications to parents via SMS and email."
                  action={canCreateInvoices ? (
                    <button onClick={() => canCreateInvoices && setShowCreateInv(true)} style={{ padding: "9px 20px", borderRadius: 9, fontSize: 13, fontWeight: 700, background: "var(--accent)", border: "none", color: "#0b1a14", cursor: "pointer", fontFamily: "inherit" }}>Create first batch</button>
                  ) : (
                    <div style={{ padding: "9px 20px", borderRadius: 9, fontSize: 13, fontWeight: 700, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text3)", fontFamily: "inherit" }}>
                      You do not have permission to create invoices.
                    </div>
                  )}
                />
              ) : mobileView ? (
                <div className="mobile-record-list">
                  {filteredInvoices.map(inv => (
                    <InvoiceMobileCard
                      key={inv.id}
                      inv={inv}
                      schoolName={schoolName}
                      onPreview={setPreviewInv}
                      onResend={canSendInvoices ? handleResendInvoice : undefined}
                    />
                  ))}
                </div>
              ) : (
                <div className="compact-table-wrap">
                  <table className="compact-table invoice-compact-table" style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        {["Student", "Adm", "Class", "Due date", "Channels", "Scheduled for", "Status", "SMS Delivery", ""].map(h => <th key={h} style={{ padding: "10px 14px", fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.7, fontWeight: 600, textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInvoices.map((inv, i) => (
                        <tr key={inv.id} style={{ borderBottom: i < filteredInvoices.length - 1 ? "1px solid var(--border)" : "none" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td className="cell-name" style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                              <Avatar name={inv.studentName} size={28} />
                              <span className="cell-truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", minWidth: 0 }}>{inv.studentName}</span>
                            </div>
                          </td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text3)" }}>{inv.admNo || "—"}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text2)" }}>{inv.className}</td>
                          <td style={{ padding: "11px 14px", fontSize: 12.5, color: "var(--text2)", whiteSpace: "nowrap" }}>{fmtDate(inv.dueDate)}</td>
                          <td style={{ padding: "11px 14px" }}><ChannelBadge channels={inv.channels} /></td>
                          <td style={{ padding: "11px 14px", fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap" }}>{inv.scheduledFor ? fmtDatetime(inv.scheduledFor) : <span style={{ color: "var(--green)", fontSize: 11 }}>Sent immediately</span>}</td>
                          <td className="cell-status" style={{ padding: "11px 14px", whiteSpace: "nowrap", width: 96 }}><StatusPill status={inv.status} /></td>
                          <td style={{ padding: "11px 14px" }}><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><SmsPill smsStatus={inv.smsStatus} channels={inv.channels} /><WhatsAppPill channels={inv.channels} /></div></td>
                          <td className="cell-actions" style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button className="table-action-btn" onClick={() => setPreviewInv({ ...inv, school: schoolName })} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Preview</button>
                              {inv.status === "failed" && canSendInvoices && (
                                <button className="table-action-btn" onClick={() => handleResendInvoice(inv.id)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--red-bg)", border: "1px solid var(--red-border)", color: "var(--red)", cursor: "pointer", fontFamily: "inherit" }}>Resend</button>
                              )}
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
                    ? "Parents receive an instant SMS from FeeFlow with a receipt download link every time a payment is recorded."
                    : "Upgrade to Max to automatically send SMS receipts to parents the moment a payment is recorded."}
                </div>
              </div>
              {plan !== "max" && <a href="mailto:feeflow254@gmail.com?subject=FeeFlow Max Upgrade" style={{ marginLeft: "auto", padding: "7px 14px", borderRadius: 8, background: "var(--amber)", color: "#1a0f00", fontSize: 12, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>Upgrade →</a>}
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
                <option value="sms_delivered">SMS Delivered</option>
                <option value="sms_queued">SMS Queued</option>
                <option value="sms_failed">SMS Failed</option>
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
              ) : mobileView ? (
                <div className="mobile-record-list">
                  {filteredReceipts.map(r => (
                    <ReceiptMobileCard
                      key={r.id}
                      receipt={r}
                      onPreview={setPreviewRec}
                      onResend={handleResendReceipt}
                    />
                  ))}
                </div>
              ) : (
                <div className="compact-table-wrap">
                  <table className="compact-table receipt-compact-table" style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        {["Student", "Adm", "Class", "Amount", "Method", "Paid on", "Channels", "Type", "Status", "SMS Delivery", ""].map(h => <th key={h} style={{ padding: "10px 14px", fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.7, fontWeight: 600, textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReceipts.map((r, i) => (
                        <tr key={r.id} style={{ borderBottom: i < filteredReceipts.length - 1 ? "1px solid var(--border)" : "none" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td className="cell-name" style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                              <Avatar name={r.studentName} size={28} />
                              <span className="cell-truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", minWidth: 0 }}>{r.studentName}</span>
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
                          <td className="cell-status" style={{ padding: "11px 14px", whiteSpace: "nowrap", width: 96 }}><StatusPill status={r.status} /></td>
                          <td style={{ padding: "11px 14px" }}><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><SmsPill smsStatus={r.smsStatus} channels={r.channels} /><WhatsAppPill channels={r.channels} /></div></td>
                          <td className="cell-actions" style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button className="table-action-btn" onClick={() => setPreviewRec(r)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>Preview</button>
                              {r.status === "failed" && <button className="table-action-btn" onClick={() => handleResendReceipt(r.id)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11.5, background: "var(--red-bg)", border: "1px solid var(--red-border)", color: "var(--red)", cursor: "pointer", fontFamily: "inherit" }}>Resend</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* SMS receipt flow note */}
            <div style={{ marginTop: 14, padding: "14px 16px", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12.5, color: "var(--text3)", lineHeight: 1.7 }}>
              <strong style={{ color: "var(--text2)" }}>How auto-receipts work:</strong> When a payment is recorded, the parent instantly receives a notification via SMS, WhatsApp, and/or Email (based on your school's notification settings) with a secure link to view and download their PDF receipt. No manual action needed.
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreateInv && <CreateInvoiceModal onClose={(refresh = false) => { setShowCreateInv(false); if (refresh) loadInvoices(); }} token={token} schoolName={schoolName} />}
      {showManualRec && <ManualReceiptModal onClose={() => { setShowManualRec(false); }} token={token} schoolName={schoolName} />}
      {previewInv && <InvoicePreview invoice={(() => {
        return { ...previewInv };
      })()} school={schoolName} onClose={() => setPreviewInv(null)} />}
      {previewRec && <ReceiptPreview  receipt={(() => {
        const st = students.find(s => s.id === previewRec.studentId);
        const liveBalance = previewRec.liveBalance ?? st?.outstanding ?? previewRec.balance;
        return { ...previewRec, balance: liveBalance };
      })()} school={schoolName} onClose={() => setPreviewRec(null)} />}
    </>
  );
}
