import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import helmet from "helmet";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
process.env.TZ = process.env.TZ || "Africa/Nairobi";
console.log("Starting FeeFlow...");
console.log("Server timezone -> " + process.env.TZ);

// Chromium concurrency cap - prevents memory exhaustion
let _pdfInFlight = 0;
const PDF_MAX_CONCURRENT = 3;

async function withPdfConcurrency(fn) {
  if (_pdfInFlight >= PDF_MAX_CONCURRENT) {
    throw Object.assign(
      new Error("PDF generation is busy. Please try again in a few seconds."),
      { statusCode: 429 }
    );
  }
  _pdfInFlight++;
  try {
    return await fn();
  } finally {
    _pdfInFlight--;
  }
}

// ─── STRUCTURED LOGGER ────────────────────────────────────────────────────────
// Centralized logging abstraction. Drop-in compatible with Sentry/Logtail/Datadog:
// swap the logger.error() body with your SDK call and structured logs flow through.
// Sensitive fields (phone, credentials, tokens) are never logged.
// reqId is a per-request correlation ID set by the middleware below.
const REDACT = /consumerKey|consumerSecret|passkey|password|token|authorization/i;
const logger = {
  _fmt: (level, ctx, msg, meta) => {
    const safe = meta ? Object.fromEntries(
      Object.entries(meta).filter(([k]) => !REDACT.test(k))
    ) : undefined;
    return JSON.stringify({ ts: new Date().toISOString(), level, ctx, msg, ...(safe || {}), reqId: meta?.reqId });
  },
  info:  (ctx, msg, meta) => process.env.NODE_ENV !== "test" && console.log(logger._fmt("INFO",  ctx, msg, meta)),
  warn:  (ctx, msg, meta) => console.warn(logger._fmt("WARN",  ctx, msg, meta)),
  error: (ctx, msg, meta) => console.error(logger._fmt("ERROR", ctx, msg, meta)),
  // Structured payment event — always emitted regardless of NODE_ENV
  payment: (event, data) => console.log(logger._fmt("PAYMENT", event, event, data)),
};

function safeErrorMessage(e) {
  return String(e?.message || e || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[redacted-phone]")
    .replace(/("(?:[^"]*(?:token|password|authorization|parentPhone|parentEmail|parentName)[^"]*)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
}

process.on("uncaughtException", (error) => {
  logger.error("fatal", "uncaughtException", {
    error: safeErrorMessage(error),
    stack: error?.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error("fatal", "unhandledRejection", {
    error: safeErrorMessage(reason),
    stack: reason?.stack,
  });
});

// ─── SAFARICOM OUTAGE STATE ───────────────────────────────────────────────────
// In-memory flag updated by the health monitor job every 5 minutes.
// Routes read outageState.degraded to suppress retries and show outage messages.
// Also persisted to SystemHealth table so it survives restarts.
const outageState = { degraded: false, degradedSince: null, successRate: 1.0 };

async function setDegradedMode(degraded, rate) {
  outageState.degraded    = degraded;
  outageState.successRate = rate;
  if (degraded && !outageState.degradedSince) outageState.degradedSince = new Date();
  if (!degraded) outageState.degradedSince = null;
  // Persist to DB so the state survives a restart
  prisma.systemHealth.upsert({
    where:  { id: "singleton" },
    create: { id: "singleton", degraded, successRate: rate, degradedSince: outageState.degradedSince, checkedAt: new Date() },
    update: { degraded, successRate: rate, degradedSince: outageState.degradedSince, checkedAt: new Date() },
  }).catch(e => logger.error("health", "Failed to persist outage state", { error: e.message }));
}

// Restore outage state from DB on startup (so a restart doesn't lose the flag)
async function restoreOutageState() {
  try {
    const h = await prisma.systemHealth.findUnique({ where: { id: "singleton" } });
    if (h) { outageState.degraded = h.degraded; outageState.successRate = h.successRate; outageState.degradedSince = h.degradedSince; }
  } catch (e) {
    logger.warn("startup", "Could not restore outage state", { error: safeErrorMessage(e) });
  }
}

// ─── FETCH WITH TIMEOUT (used everywhere external APIs are called) ────────────
function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

// ─── SAFARICOM RESULT CODE MAP ────────────────────────────────────────────────
const SAFARICOM_CODES = {
  0:    { status: "success",            msg: null },
  1:    { status: "insufficient_funds", msg: "Insufficient M-Pesa balance. Please top up and try again." },
  17:   { status: "failed",             msg: "M-Pesa service is temporarily unavailable. Please try again in a few minutes." },
  1001: { status: "failed",             msg: "Unable to complete the payment. Please try again." },
  1019: { status: "failed",             msg: "Transaction expired. Please initiate a new payment." },
  1025: { status: "failed",             msg: "M-Pesa daily transaction limit exceeded. Try a smaller amount or contact Safaricom." },
  1032: { status: "cancelled_by_user",  msg: "You cancelled the payment on your phone. Tap 'Pay Again' whenever you're ready." },
  1037: { status: "timeout",            msg: "The request expired — your phone may have been off or out of signal. Try again." },
  2001: { status: "failed",             msg: "Wrong PIN entered too many times. Please try again." },
};

// ─── LEDGER ACCOUNTING ENGINE ─────────────────────────────────────────────────
// THE ONLY CORRECT WAY TO CALCULATE A BALANCE IN FEEFLOW.
//
// PROBLEM WITH THE OLD SYSTEM:
//   student.fee is mutable. When Transport (5,000) is added to a student who
//   already paid Tuition (50,000 of 75,000), the system sets student.fee = 80,000.
//   But student.paid is still 50,000. So balance = 80,000 - 50,000 = 30,000. ✓
//   BUT: if the admin edits student.fee again, or a new term starts, the
//   calculation silently drifts. student.paid never resets. Invoices use their
//   own createdAt filter which cuts off some payments. The numbers diverge.
//
// CORRECT FORMULA (derived, never stored):
//   totalCharges = SUM(StudentCharge.amount WHERE NOT voided AND termId matches)
//   totalPaid    = SUM(Payment.amount WHERE NOT reversed AND NOT isReversal)
//   credit       = SUM(CreditMemo.remainingAmount WHERE status="available")
//   outstanding  = MAX(0, totalCharges - totalPaid - credit)
//
// This function is called by every route that needs a balance. Never compute
// fee - paid directly. That path is deprecated.
//
function assertLedgerBalanceInvariant(balance) {
  const expected = Math.max(0, Number(balance.totalCharges || 0) - Number(balance.totalPaid || 0) - Number(balance.totalCredit || 0));
  if (Number(balance.outstanding || 0) !== expected) {
    throw Object.assign(new Error("Ledger invariant failed: outstanding must equal max(0, totalCharges - totalPaid - totalCredit)."), {
      statusCode: 500,
      details: { expected, actual: balance.outstanding },
    });
  }
  return balance;
}

async function deriveStudentBalance(studentId, termId = null, tx = prisma) {
  // Parallel fetch: charges + payments + credits
  const [chargeAgg, paymentAgg, creditAgg] = await Promise.all([
    // Total active charges (StudentCharge table — new ledger model)
    tx.studentCharge.aggregate({
      where: {
        studentId,
        voidedAt: null,
        ...(termId ? { termId } : {}),
      },
      _sum: { amount: true },
    }),
    // Total valid payments (exclude reversed and reversal entries)
    tx.payment.aggregate({
      where: {
        studentId,
        reversedAt: null,
        isReversal:  false,
        deletedAt:   null,
      },
      _sum: { amount: true },
    }),
    // Available credits (overpayments from prior terms)
    tx.creditMemo.aggregate({
      where: { studentId, status: "available" },
      _sum: { remainingAmount: true },
    }),
  ]);

  const totalCharges = Number(chargeAgg._sum.amount ?? 0);
  const totalPaid    = Number(paymentAgg._sum.amount ?? 0);
  const totalCredit  = Number(creditAgg._sum.remainingAmount ?? 0);
  const outstanding = Math.max(0, totalCharges - totalPaid - totalCredit);
  const isOverpaid  = totalPaid + totalCredit > totalCharges;
  const creditBalance = Number(creditAgg._sum.remainingAmount ?? 0);

  return assertLedgerBalanceInvariant({
    totalCharges,
    totalPaid,
    totalCredit,
    outstanding,
    isOverpaid,
    creditBalance,
    // Compatibility aliases for API clients; values are ledger-derived.
    paid:            totalPaid,
    fee:             totalCharges,
    balance:         outstanding,
    // Balance derivation source.
    ledgerSource:    "ledger",
  });
}

// Derive balances for multiple students in one DB round-trip (used in stats/reports).
// Returns a Map<studentId, BalanceResult>.
async function deriveStudentBalancesBatch(studentIds, termId = null, tx = prisma) {
  if (!studentIds.length) return new Map();

  const chunks = [];
  for (let i = 0; i < studentIds.length; i += 500) chunks.push(studentIds.slice(i, i + 500));
  const charges = [];
  const payments = [];
  const credits = [];

  await Promise.all(chunks.map(async (chunk) => {
    const [chunkCharges, chunkPayments, chunkCredits] = await Promise.all([
      tx.studentCharge.groupBy({
        by: ["studentId"],
        where: { studentId: { in: chunk }, voidedAt: null, ...(termId ? { termId } : {}) },
        _sum: { amount: true },
      }),
      tx.payment.groupBy({
        by: ["studentId"],
        where: { studentId: { in: chunk }, reversedAt: null, isReversal: false, deletedAt: null },
        _sum: { amount: true },
      }),
      tx.creditMemo.groupBy({
        by: ["studentId"],
        where: { studentId: { in: chunk }, status: "available" },
        _sum: { remainingAmount: true },
      }),
    ]);
    charges.push(...chunkCharges);
    payments.push(...chunkPayments);
    credits.push(...chunkCredits);
  }));

  const chargeMap  = Object.fromEntries(charges.map(r  => [r.studentId, Number(r._sum.amount ?? 0)]));
  const payMap     = Object.fromEntries(payments.map(r  => [r.studentId, Number(r._sum.amount ?? 0)]));
  const creditMap  = Object.fromEntries(credits.map(r   => [r.studentId, Number(r._sum.remainingAmount ?? 0)]));

  return new Map(studentIds.map(id => {
    const chargesVal  = chargeMap[id]  ?? 0;
    const paid        = payMap[id]     ?? 0;
    const credit      = creditMap[id]  ?? 0;
    const outstanding = Math.max(0, chargesVal - paid - credit);
    const isOverpaid  = paid + credit > chargesVal;
    return [id, assertLedgerBalanceInvariant({
      totalCharges: chargesVal, totalPaid: paid, totalCredit: credit,
      outstanding, isOverpaid, creditBalance: credit,
      paid, fee: chargesVal, balance: outstanding,
      ledgerSource: "ledger",
    })];
  }));
}

async function deriveStudentTermBalancesBatch(studentIds, termId, tx = prisma) {
  if (!studentIds.length || !termId) return new Map(studentIds.map(id => [id, {
    currentTermCharges: 0,
    currentTermPaid: 0,
    currentTermOutstanding: 0,
  }]));

  const charges = await tx.studentCharge.findMany({
    where: { studentId: { in: studentIds }, termId, voidedAt: null },
    select: { id: true, studentId: true, amount: true },
  });
  const chargeIds = charges.map(c => c.id);
  const allocationRows = chargeIds.length
    ? await tx.paymentAllocation.groupBy({
        by: ["studentChargeId"],
        where: {
          studentChargeId: { in: chargeIds },
          payment: { reversedAt: null, isReversal: false, deletedAt: null },
        },
        _sum: { amount: true },
      })
    : [];
  const paidByCharge = Object.fromEntries(allocationRows.map(a => [a.studentChargeId, Number(a._sum.amount ?? 0)]));
  const result = new Map(studentIds.map(id => [id, { currentTermCharges: 0, currentTermPaid: 0, currentTermOutstanding: 0 }]));

  for (const charge of charges) {
    const row = result.get(charge.studentId) || { currentTermCharges: 0, currentTermPaid: 0, currentTermOutstanding: 0 };
    row.currentTermCharges += Number(charge.amount || 0);
    row.currentTermPaid += Math.min(Number(charge.amount || 0), paidByCharge[charge.id] || 0);
    result.set(charge.studentId, row);
  }

  for (const row of result.values()) {
    row.currentTermOutstanding = Math.max(0, row.currentTermCharges - row.currentTermPaid);
  }
  return result;
}

async function deriveStudentCurrentTermReceivedBalancesBatch(studentIds, activeTerm, tx = prisma) {
  if (!studentIds.length || !activeTerm?.id) return new Map(studentIds.map(id => [id, {
    currentTermCharges: 0,
    currentTermPaid: 0,
    currentTermBalance: 0,
    currentTermOutstanding: 0,
  }]));

  const [chargeRows, payments] = await Promise.all([
    tx.studentCharge.groupBy({
      by: ["studentId"],
      where: { studentId: { in: studentIds }, termId: activeTerm.id, voidedAt: null },
      _sum: { amount: true },
    }),
    tx.payment.findMany({
      where: {
        studentId: { in: studentIds },
        reversedAt: null,
        isReversal: false,
        deletedAt: null,
      },
      select: {
        studentId: true,
        amount: true,
        termId: true,
        paymentTermId: true,
        receivedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const result = new Map(studentIds.map(id => [id, {
    currentTermCharges: 0,
    currentTermPaid: 0,
    currentTermBalance: 0,
    currentTermOutstanding: 0,
  }]));

  for (const row of chargeRows) {
    const current = result.get(row.studentId);
    current.currentTermCharges = Number(row._sum.amount || 0);
  }

  for (const payment of payments) {
    if (paymentTermKey(payment, [activeTerm]) !== activeTerm.id) continue;
    const current = result.get(payment.studentId);
    if (!current) continue;
    current.currentTermPaid += Number(payment.amount || 0);
  }

  for (const current of result.values()) {
    current.currentTermBalance = current.currentTermCharges - current.currentTermPaid;
    current.currentTermOutstanding = current.currentTermBalance;
  }

  return result;
}

function canonicalChargeType(value) {
  const raw = String(value || "other").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (raw === "transport" || raw === "transport_fee" || raw === "school_transport"
      || raw === "bus_fee" || raw === "bus") return "transport";
  if (raw === "tuition" || raw === "tuition_fee" || raw === "school_fee"
      || raw === "term_fee" || raw === "fees") return "tuition";
  if (raw === "exam" || raw === "exam_fee" || raw === "examination"
      || raw === "examination_fee" || raw === "exams") return "exam";
  if (raw === "lunch" || raw === "lunch_fee" || raw === "meals") return "lunch";
  if (raw === "activity" || raw === "activity_fee" || raw === "activities") return "activity";
  if (raw === "uniform" || raw === "uniform_fee") return "uniform";
  if (raw === "boarding" || raw === "boarding_fee" || raw === "hostel") return "boarding";
  if (raw === "term_tuition_fee" || raw === "tuition_fee_term"
      || raw === "opening_tuition_balance") return "tuition";
  if (raw === "meals_fee") return "lunch";
  if (raw === "transport_fee_term" || raw === "school_transport_fee") return "transport";
  if (raw === "activity_fee_term" || raw === "activities_fee") return "activity";
  if (raw === "uniform_fee_term") return "uniform";
  if (raw === "boarding_fee_term" || raw === "hostel_fee") return "boarding";
  if (raw === "exam_fee_term" || raw === "examination_fee_term") return "exam";
  return raw || "other";
}

function normalizeChargeType(line) {
  if (line.type && line.type !== "other") return canonicalChargeType(line.type);
  return canonicalChargeType(line.typeId || line.typeName || line.type || "other");
}

function normalizeChargeDescription(line) {
  return line.typeName || line.description || line.name || "Fee";
}

function invoiceSnapshotFromLedger(ledgerBefore, newChargesTotal) {
  const newCharges = Number(newChargesTotal || 0);
  const accountTotalCharges = Number(ledgerBefore.totalCharges || 0) + newCharges;
  const totalPaidToDate = Number(ledgerBefore.totalPaid || 0);
  return {
    accountTotalCharges,
    totalPaidToDate,
    totalDueNow: Math.max(0, accountTotalCharges - totalPaidToDate),
    newChargesTotal: newCharges,
    previousOutstanding: Number(ledgerBefore.outstanding || 0),
  };
}

function invoiceSnapshot(invoice) {
  const accountTotalCharges = Number(invoice.accountTotalCharges || 0) || Number(invoice.totalFee || 0);
  const totalPaidToDate = Number(invoice.totalPaidToDate || 0) || Number(invoice.paid || 0);
  const totalDueNow = Number(invoice.totalDueNow || 0) || Number(invoice.balance || 0) || Math.max(0, accountTotalCharges - totalPaidToDate);
  return {
    accountTotalCharges,
    totalPaidToDate,
    totalDueNow,
    newChargesTotal: Number(invoice.newChargesTotal || 0) || Number(invoice.totalFee || 0),
    previousOutstanding: Number(invoice.previousOutstanding || 0),
  };
}

async function createStudentChargeSafe(tx, data) {
  const amount = Number(data.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const type = canonicalChargeType(data.type);
  const description = String(data.description || "Fee").trim() || "Fee";
  const splitCharge = Boolean(data.splitCharge);

  if (!splitCharge) {
    const equivalent = await tx.studentCharge.findFirst({
      where: {
        studentId: data.studentId,
        termId: data.termId || null,
        type,
        description,
        amount,
        voidedAt: null,
        splitCharge: false,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (equivalent) return equivalent;
  }

  const idempotencyKey = data.idempotencyKey || null;
  if (idempotencyKey) {
    const existingByKey = await tx.studentCharge.findFirst({ where: { idempotencyKey } });
    if (existingByKey) return existingByKey;
  }

  try {
    return await tx.studentCharge.create({
      data: {
        studentId: data.studentId,
        userId: data.userId,
        termId: data.termId || null,
        invoiceId: data.invoiceId || null,
        type,
        description,
        amount,
        splitCharge,
        idempotencyKey,
      },
    });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    return tx.studentCharge.findFirst({
      where: {
        studentId: data.studentId,
        termId: data.termId || null,
        type,
        description,
        amount,
        voidedAt: null,
        splitCharge,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }
}

function invoiceIdempotencyKey({ userId, studentId, termId, dueDate, selectedChargeIds, sendDate, channels }) {
  const selectedIds = Array.isArray(selectedChargeIds)
    ? selectedChargeIds.map(id => String(id)).filter(Boolean).sort()
    : [];
  return crypto.createHash("sha256").update(JSON.stringify({
    userId,
    studentId,
    termId: termId || null,
    dueDate: dueDate ? new Date(dueDate).toISOString().slice(0, 10) : null,
    sendDate: sendDate ? new Date(sendDate).toISOString() : null,
    channels: [...(Array.isArray(channels) ? channels : [channels].filter(Boolean))].sort(),
    selectedIds,
  })).digest("hex");
}

async function warnIfDuplicateActiveCharges(tx = prisma) {
  const rows = await tx.studentCharge.findMany({
    where: { voidedAt: null, splitCharge: false },
    select: { studentId: true, termId: true, type: true, amount: true, description: true },
  });
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const key = [row.studentId, row.termId || "", row.type, row.amount, row.description].join("|");
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  if (duplicates > 0) {
    logger.warn("ledger", "Duplicate active StudentCharge rows detected. Run npm run ledger:audit -- --repair.", { duplicates });
  }
}

function normalizeInvoiceLines(feeBreakdown, fallbackAmount = 0) {
  const source = Array.isArray(feeBreakdown) && feeBreakdown.length > 0
    ? feeBreakdown
    : [{ typeName: "Fee", amount: fallbackAmount }];
  return source
    .map(line => ({
      typeName: normalizeChargeDescription(line),
      type: normalizeChargeType(line),
      description: normalizeChargeDescription(line),
      amount: Number(line.amount || 0),
    }))
    .filter(line => Number.isFinite(line.amount) && line.amount > 0);
}

function invoiceLineKey(line, termId) {
  return [
    termId || "",
    canonicalChargeType(line.type || line.typeName || line.description || "other"),
    normalizedInvoiceDescription(line.description || line.typeName || line.name || "Fee"),
    Number(line.amount || 0),
  ].join("|");
}

function normalizedInvoiceDescription(value) {
  return String(value || "Fee").trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueInvoiceLines(lines, termId) {
  const seen = new Set();
  return lines.filter(line => {
    const key = invoiceLineKey(line, termId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function quoteInvoiceCharges({ studentId, userId, termId, selectedChargeIds }, tx = prisma) {
  const ledgerBefore = await deriveStudentBalance(studentId, null, tx);
  const selectedIds = Array.isArray(selectedChargeIds)
    ? selectedChargeIds.map(id => String(id)).filter(Boolean)
    : [];
  const selectedIdsSet = new Set(selectedIds);

  const activeCharges = await tx.studentCharge.findMany({
    where: { studentId, userId, termId: termId || null, voidedAt: null },
    select: { id: true, termId: true, type: true, description: true, amount: true, invoiceId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const filteredCharges = selectedIds.length > 0
    ? activeCharges.filter(c => selectedIdsSet.has(String(c.id)))
    : activeCharges;

  const displaySourceLines = uniqueInvoiceLines(filteredCharges.map(c => ({
    id: c.id,
    typeName: c.description || c.type || "Fee",
    type: canonicalChargeType(c.type || c.description || "other"),
    description: c.description || "Fee",
    amount: Number(c.amount || 0),
  })).filter(line => Number.isFinite(line.amount) && line.amount > 0), termId);

  const dedupedLines = [];
  const annotatedLines = [];

  for (const line of displaySourceLines) {
    const sameTypeAmountCharges = activeCharges.filter(c =>
      (c.termId || null) === (termId || null) &&
      canonicalChargeType(c.type) === line.type &&
      Number(c.amount) === Number(line.amount)
    );
    const existing =
      activeCharges.find(c => {
        const chargeType = canonicalChargeType(c.type);
        return (
          (c.termId || null) === (termId || null) &&
          chargeType === line.type &&
          normalizedInvoiceDescription(c.description) === normalizedInvoiceDescription(line.description) &&
          Number(c.amount) === Number(line.amount)
        );
      }) ||
      activeCharges.find(c =>
        (c.termId || null) === (termId || null) &&
        canonicalChargeType(c.type) === line.type &&
        Number(c.amount) === Number(line.amount) &&
        sameTypeAmountCharges.length === 1
      );
    if (existing) {
      annotatedLines.push({ ...line, id: existing.id, alreadyCharged: true, existingChargeId: existing.id });
    } else {
      dedupedLines.push(line);
      annotatedLines.push({ ...line, id: line.id || null, alreadyCharged: false });
    }
  }

  const dedupedNewCharges = dedupedLines.reduce((s, line) => s + line.amount, 0);
  const displayFeeTotal = annotatedLines.reduce((s, line) => s + line.amount, 0);
  const snapshot = invoiceSnapshotFromLedger(ledgerBefore, dedupedNewCharges);
  return { ledgerBefore, lines: annotatedLines, displayFeeTotal, dedupedLines, dedupedNewCharges, snapshot };
}

// Associate existing StudentCharge rows with an invoice.
// Called inside the invoice creation transaction so charges are always
// consistent with what's on the invoice. Idempotent on invoiceId.
async function createChargesFromInvoice({ invoiceId, studentId, userId, termId, selectedChargeIds }, tx) {
  // Idempotency: skip if charges already exist for this invoice
  const existing = await tx.studentCharge.count({ where: { invoiceId } });
  if (existing > 0) return;

  const quote = await quoteInvoiceCharges({ studentId, userId, termId, selectedChargeIds }, tx);
  let chargeIds = [];

  if (Array.isArray(selectedChargeIds) && selectedChargeIds.length > 0) {
    chargeIds = selectedChargeIds.map(id => String(id)).filter(Boolean);
  } else if (Array.isArray(quote.lines) && quote.lines.length > 0) {
    chargeIds = quote.lines.map(line => line.id).filter(id => id != null);
  }

  if (chargeIds.length === 0) return;

  await tx.studentCharge.updateMany({
    where: {
      id: { in: chargeIds },
      studentId,
      termId: termId || null,
      invoiceId: null,
    },
    data: { invoiceId },
  });
}

// Handle overpayment: if a payment creates a credit, record it as a CreditMemo.
// Called inside payment transactions. Returns the credit amount (0 if no excess).
async function handleOverpayment({ studentId, userId, termId, paymentId, totalCharges, totalPaid }, tx) {
  if (totalPaid <= totalCharges) return 0;
  const excess = totalPaid - totalCharges;
  // Check for an existing available credit memo for this payment (idempotency)
  const existing = await tx.creditMemo.findFirst({ where: { sourcePaymentId: paymentId } });
  if (!existing) {
    await tx.creditMemo.create({
      data: {
        studentId, userId, termId: termId || null,
        sourcePaymentId: paymentId,
        amount: excess, remainingAmount: excess,
        status: "available",
        note: "Auto-generated from overpayment",
      },
    });
  }
  return excess;
}

async function allocatePaymentFIFO(paymentId, tx = prisma, maxAllocationAmount = null) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.reversedAt || payment.isReversal || payment.deletedAt) return { allocated: 0, unallocated: 0 };

  const existing = await tx.paymentAllocation.aggregate({ where: { paymentId }, _sum: { amount: true } });
  if (Number(existing._sum.amount ?? 0) > 0) {
    const allocated = Number(existing._sum.amount ?? 0);
    return { allocated, unallocated: Math.max(0, payment.amount - allocated) };
  }

  const charges = await tx.studentCharge.findMany({
    where: { studentId: payment.studentId, voidedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, amount: true },
  });
  const allocationSums = await tx.paymentAllocation.groupBy({
    by: ["studentChargeId"],
    where: { studentChargeId: { in: charges.map(c => c.id) }, payment: { reversedAt: null, isReversal: false, deletedAt: null } },
    _sum: { amount: true },
  });
  const allocatedByCharge = Object.fromEntries(allocationSums.map(a => [a.studentChargeId, Number(a._sum.amount ?? 0)]));

  let remaining = maxAllocationAmount === null || maxAllocationAmount === undefined
    ? Number(payment.amount)
    : Math.max(0, Math.min(Number(payment.amount), Number(maxAllocationAmount) || 0));
  let allocated = 0;
  for (const charge of charges) {
    if (remaining <= 0) break;
    const unpaid = Math.max(0, Number(charge.amount) - (allocatedByCharge[charge.id] || 0));
    if (unpaid <= 0) continue;
    const amount = Math.min(remaining, unpaid);
    await tx.paymentAllocation.create({ data: { paymentId, studentChargeId: charge.id, amount } });
    remaining -= amount;
    allocated += amount;
  }
  return { allocated, unallocated: Math.max(0, Number(payment.amount) - allocated) };
}

async function activePaymentTerm(userId, tx = prisma) {
  return tx.term.findFirst({ where: { userId, status: "active" }, orderBy: { createdAt: "desc" } });
}

function paymentTermKey(payment, terms = []) {
  if (payment.paymentTermId) return payment.paymentTermId;
  if (payment.termId) return payment.termId;
  const received = new Date(payment.receivedAt || payment.createdAt);
  const match = terms.find(term => {
    const start = term.startDate ? new Date(term.startDate) : null;
    const end = term.endDate ? new Date(term.endDate) : null;
    return start && end && received >= start && received <= end;
  });
  return match?.id || "_legacy";
}

const BANK_STATUS = {
  FULL: "FULL",
  PARTIAL: "PARTIAL",
  OVERPAYMENT: "OVERPAYMENT",
  UNMATCHED: "UNMATCHED",
  DUPLICATE: "DUPLICATE",
  NEEDS_REVIEW: "NEEDS_REVIEW",
};

const MATCH_STATUS = {
  MATCHED: "MATCHED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  UNMATCHED: "UNMATCHED",
  DUPLICATE: "DUPLICATE",
};

function normalizeLookup(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeCompact(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("254")) return digits.slice(-9);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits.slice(-9);
}

function studentBankPaymentReference(student) {
  const adm = normalizeCompact(student?.adm || "").toUpperCase();
  if (adm) return "FF-ADM-" + adm;
  const id = normalizeCompact(student?.id || "").toUpperCase().slice(0, 10);
  return id ? "FF-STU-" + id : "";
}

function invoiceBankPaymentReference(invoice) {
  const n = Number(invoice?.invoiceNo || 0);
  if (!n) return "";
  const created = invoice?.createdAt ? new Date(invoice.createdAt) : new Date();
  const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
  return "INV-" + year + "-" + String(n).padStart(4, "0");
}

const USER_BANK_PAYBILL_SELECT = {
  bankPaybillNumber: true,
  bankAccountNumber: true,
  bankAccountName: true,
  bankName: true,
  bankPaymentInstructions: true,
};

function bankPaybillPayload(user) {
  return {
    bankPaybillNumber: user?.bankPaybillNumber || "",
    bankAccountNumber: user?.bankAccountNumber || "",
    bankAccountName: user?.bankAccountName || "",
    bankName: user?.bankName || "",
    bankPaymentInstructions: user?.bankPaymentInstructions || "",
  };
}

function hasBankPaybillInfo(user) {
  return Object.values(bankPaybillPayload(user)).some(v => String(v || "").trim());
}

function renderBankPaybillRows(user) {
  const info = bankPaybillPayload(user);
  const rows = [
    ["Paybill Number", info.bankPaybillNumber],
    ["Account Number / Business Number", info.bankAccountNumber],
    ["Account Name", info.bankAccountName],
    ["Bank Name", info.bankName],
    ["Instructions", info.bankPaymentInstructions],
  ].filter(([, value]) => String(value || "").trim());
  if (!rows.length) return "";
  return rows.map(([label, value]) => "<div class='bank-info-row'><span>" + escHtml(label) + ":</span><strong>" + escHtml(value) + "</strong></div>").join("");
}

function tokenizeCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { current += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells.map(c => c.trim());
}

function parseCsvRows(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const headers = tokenizeCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = tokenizeCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h || `Column ${i + 1}`, cells[i] ?? ""]));
  });
}

function normalizeExcelCellValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("");
  if (Object.prototype.hasOwnProperty.call(value, "result")) return normalizeExcelCellValue(value.result);
  if (Object.prototype.hasOwnProperty.call(value, "text")) return value.text || "";
  return String(value);
}

async function parseExcelRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headerCount = headerRow.cellCount;
  const headers = [];
  for (let i = 1; i <= headerCount; i += 1) {
    const header = normalizeExcelCellValue(headerRow.getCell(i).value);
    const name = String(header ?? "").trim();
    headers.push(name || `Column ${i}`);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const output = {};
    let hasValue = false;
    for (let i = 1; i <= headers.length; i += 1) {
      const value = normalizeExcelCellValue(row.getCell(i).value);
      if (value !== "" && value !== null && value !== undefined) hasValue = true;
      output[headers[i - 1]] = value ?? "";
    }
    if (hasValue) rows.push(output);
  });
  return rows;
}

async function parsePdfRows(buffer) {
  let pdfModule;
  try {
    pdfModule = await import("pdf-parse");
  } catch {
    throw Object.assign(new Error("PDF statement parsing is not available on this server. Please install pdf-parse or upload CSV/Excel."), { statusCode: 501 });
  }
  let parsed;
  if (typeof pdfModule.default === "function") {
    parsed = await pdfModule.default(buffer);
  } else if (typeof pdfModule.PDFParse === "function") {
    const parser = new pdfModule.PDFParse({ data: buffer });
    try { parsed = await parser.getText(); }
    finally { await parser.destroy?.(); }
  } else {
    throw Object.assign(new Error("PDF statement parsing is not available on this server. Please upload CSV/Excel or a clearer statement PDF."), { statusCode: 501 });
  }
  const text = String(parsed?.text || "").replace(/\u00a0/g, " ");
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const dateRx = /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})\b/;
  const amountRx = /(?:KES|KSH|KSh)?\s*[-+]?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|(?:KES|KSH|KSh)?\s*[-+]?\d+(?:\.\d{1,2})?/g;
  const rows = [];
  for (const line of lines) {
    const date = dateRx.exec(line)?.[1];
    if (!date) continue;
    const amounts = [...line.matchAll(amountRx)]
      .map(m => m[0])
      .filter(v => /\d/.test(v) && !date.includes(v));
    if (!amounts.length) continue;
    const amount = amounts[amounts.length - 1];
    const ref = /\b(?:REF|REFERENCE|TXN|TRANSACTION|FT|TRX|RRN)[:#\s-]*([A-Z0-9-]{5,})\b/i.exec(line)?.[1]
      || /\b([A-Z0-9]{8,})\b/.exec(line)?.[1]
      || "";
    rows.push({
      Date: date,
      Amount: amount,
      "Transaction Ref": ref,
      Narration: line,
      "Payer Name": "",
    });
  }
  return rows;
}

async function parseBankStatementRows(file) {
  if (file.ext === ".xlsx") return parseExcelRows(file.buffer);
  if (file.ext === ".pdf") return parsePdfRows(file.buffer);
  return parseCsvRows(file.buffer);
}

function isPdfStatement(file) {
  return file?.ext === ".pdf" || file?.mime === "application/pdf";
}

function pickColumn(row, names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const target = normalizeCompact(name);
    const found = entries.find(([key]) => normalizeCompact(key) === target || normalizeCompact(key).includes(target));
    if (found && found[1] !== undefined && found[1] !== null && String(found[1]).trim() !== "") return found[1];
  }
  return "";
}

function parseBankAmount(row) {
  const direct = pickColumn(row, ["amount", "paid in", "credit", "deposit", "money in", "receipt amount"]);
  const debit = pickColumn(row, ["debit", "withdrawal", "paid out"]);
  let raw = direct || "";
  if (!raw && debit) raw = "-" + debit;
  const cleaned = String(raw).replace(/,/g, "").replace(/[^\d.-]/g, "");
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function parseBankDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const millis = Math.round(value * 24 * 60 * 60 * 1000);
    const parsed = new Date(excelEpoch + millis);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;
  const isoLike = new Date(raw);
  if (!Number.isNaN(isoLike.getTime())) return isoLike;
  const dmy = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(raw);
  if (dmy) {
    const year = Number(dmy[3].length === 2 ? "20" + dmy[3] : dmy[3]);
    const date = new Date(year, Number(dmy[2]) - 1, Number(dmy[1]));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function normalizeBankRow(row) {
  const paidAt = parseBankDate(pickColumn(row, ["date", "transaction date", "value date", "paid at", "posted date"]));
  const amount = parseBankAmount(row);
  const payerName = String(pickColumn(row, ["payer", "payer name", "customer", "account name", "sender", "name"]) || "").trim();
  const narration = String(pickColumn(row, ["narration", "description", "details", "particulars", "reference details", "remarks"]) || "").trim();
  const transactionRef = String(pickColumn(row, ["transaction ref", "transaction reference", "ref", "reference", "receipt no", "receipt number", "transaction id"]) || "").trim();
  return { paidAt, amount, payerName, narration, transactionRef, rawRowJson: row };
}

function levenshtein(a, b) {
  const left = normalizeLookup(a);
  const right = normalizeLookup(b);
  if (!left || !right) return Math.max(left.length, right.length);
  const dp = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[left.length][right.length];
}

function fuzzyScore(a, b) {
  const left = normalizeLookup(a);
  const right = normalizeLookup(b);
  if (!left || !right) return 0;
  const maxLen = Math.max(left.length, right.length);
  const ratio = 1 - (levenshtein(left, right) / maxLen);
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

function classifyBankPaymentStatus(amount, balance, confidence) {
  if (!confidence) return BANK_STATUS.UNMATCHED;
  if (Number(balance || 0) <= 0) return BANK_STATUS.OVERPAYMENT;
  if (amount === balance) return BANK_STATUS.FULL;
  if (amount < balance) return BANK_STATUS.PARTIAL;
  if (amount > balance) return BANK_STATUS.OVERPAYMENT;
  return BANK_STATUS.NEEDS_REVIEW;
}

function hintBankTransaction({ normalized, students }) {
  const haystack = normalizeLookup([normalized.transactionRef, normalized.payerName, normalized.narration, normalized.phone].filter(Boolean).join(" "));
  const phoneHaystack = normalizePhone([normalized.transactionRef, normalized.payerName, normalized.narration, normalized.phone].join(" "));
  let best = { student: null, confidence: 0, reason: null };

  if (phoneHaystack) {
    for (const student of students) {
      if ([student.parentPhone, student.phone].some(phone => normalizePhone(phone) && normalizePhone(phone) === phoneHaystack)) {
        best = { student, confidence: 0, reason: "Suggested by parent phone - review required" };
        break;
      }
    }
  }
  if (!best.student) {
    for (const student of students) {
      const name = normalizeLookup(student.name);
      if (name && haystack.includes(name)) {
        const parts = name.split(" ").filter(p => p.length >= 2);
        const matchedParts = parts.filter(p => haystack.includes(p));
        const partialPct = parts.length > 0 ? Math.round((matchedParts.length / parts.length) * 100) : 0;
        best = { student, confidence: partialPct, reason: `Suggested by student name (${partialPct}% name match) \u2014 review required` };
        break;
      }
    }
  }
  if (!best.student) {
    for (const student of students) {
      const score = fuzzyScore(student.name, `${normalized.payerName || ""} ${normalized.narration || ""}`);
      if (score >= 78) {
        best = { student, confidence: 0, reason: "Suggested by fuzzy name - review required" };
        break;
      }
    }
  }
  return best;
}

function bankFallbackDuplicateKey(row) {
  return [
    Number(row?.amount || 0),
    row?.paidAt instanceof Date ? row.paidAt.toISOString() : String(row?.paidAt || ""),
    row?.payerName || "",
    row?.narration || "",
  ].join("|");
}

async function buildBankDuplicateContext({ normalizedRows, userId }) {
  const refs = [...new Set(normalizedRows.map(row => row.transactionRef).filter(Boolean))];
  const rowsWithoutRef = normalizedRows.filter(row => !row.transactionRef);
  const fallbackCandidates = [...new Map(rowsWithoutRef.map(row => [bankFallbackDuplicateKey(row), row])).values()];

  const [existingBankRows, existingPaymentRows] = await Promise.all([
    refs.length
      ? prisma.bankTransaction.findMany({ where: { userId, transactionRef: { in: refs } }, select: { transactionRef: true } })
      : Promise.resolve([]),
    refs.length
      ? prisma.payment.findMany({ where: { userId, txnRef: { in: refs } }, select: { txnRef: true } })
      : Promise.resolve([]),
  ]);

  const fallbackDuplicateKeys = new Set();
  const chunkSize = 50;
  for (let i = 0; i < fallbackCandidates.length; i += chunkSize) {
    const chunk = fallbackCandidates.slice(i, i + chunkSize);
    const existingFallbackRows = await prisma.bankTransaction.findMany({
      where: {
        userId,
        OR: chunk.map(row => ({
          amount: row.amount,
          paidAt: row.paidAt,
          payerName: row.payerName || null,
          narration: row.narration || null,
        })),
      },
      select: { amount: true, paidAt: true, payerName: true, narration: true },
    });
    for (const row of existingFallbackRows) fallbackDuplicateKeys.add(bankFallbackDuplicateKey(row));
  }

  return {
    existingBankRefs: new Set(existingBankRows.map(row => row.transactionRef).filter(Boolean)),
    existingPaymentRefs: new Set(existingPaymentRows.map(row => row.txnRef).filter(Boolean)),
    fallbackDuplicateKeys,
  };
}

function matchBankTransaction({ normalized, students, invoices, balances, existingBankRefs = new Set(), existingPaymentRefs = new Set(), fallbackDuplicateKeys = new Set() }) {
  const haystack = normalizeLookup([normalized.transactionRef, normalized.payerName, normalized.narration, normalized.phone].filter(Boolean).join(" "));
  const compactHaystack = normalizeCompact(haystack);
  const normalizedPayer = normalizeLookup(normalized.payerName || "");
  let strong = null;
  const strongCandidates = [];

  for (const invoice of invoices) {
    const ref = normalizeCompact(invoiceBankPaymentReference(invoice));
    if (ref && compactHaystack.includes(ref)) {
      const student = students.find(s => s.id === invoice.studentId);
      if (student) strongCandidates.push({ student, confidence: 100, reason: `Exact invoice ${invoiceBankPaymentReference(invoice)}` });
    }
  }

  for (const student of students) {
    const adm = normalizeCompact(student.adm);
    const bankRef = normalizeCompact(studentBankPaymentReference(student));
    const idRef = normalizeCompact(student.id);
    const parentName = normalizeLookup(student.parentName);
    const studentName = normalizeLookup(student.name);
    const phoneHaystack = normalizePhone([normalized.transactionRef, normalized.payerName, normalized.narration, normalized.phone].join(" "));

    if (bankRef && compactHaystack.includes(bankRef)) {
      strongCandidates.push({ student, confidence: 100, reason: "Exact generated payment reference" });
    } else if (adm && adm.length >= 3 && ((/[a-z]/i.test(adm) && compactHaystack.includes(adm)) || compactHaystack.includes("adm" + adm))) {
      strongCandidates.push({ student, confidence: 100, reason: "Exact admission number" });
    } else if (idRef && compactHaystack.includes(idRef)) {
      strongCandidates.push({ student, confidence: 100, reason: "Exact FeeFlow student reference" });
    } else if (phoneHaystack && [student.parentPhone, student.phone].some(phone => normalizePhone(phone) && normalizePhone(phone) === phoneHaystack)) {
      strongCandidates.push({ student, confidence: 98, reason: "Exact parent phone match" });
    } else if (parentName && parentName === normalizedPayer) {
      strongCandidates.push({ student, confidence: 95, reason: "Exact parent name match" });
    } else if (studentName && studentName === normalizedPayer) {
      strongCandidates.push({ student, confidence: 95, reason: "Exact student name match" });
    } else if (parentName && normalizedPayer.includes(parentName)) {
      strongCandidates.push({ student, confidence: 92, reason: "Parent name appears in payment description" });
    } else if (studentName && normalizedPayer.includes(studentName)) {
      strongCandidates.push({ student, confidence: 92, reason: "Student name appears in payment description" });
    }
  }

  const normalizedRef = normalizeLookup(normalized.transactionRef || "");
  if (normalizedRef && normalizedRef.length >= 4) {
    for (const student of students) {
      const studentName = normalizeLookup(student.name);
      const parentName = normalizeLookup(student.parentName);
      const studentParts = studentName ? studentName.split(" ").filter(p => p.length >= 2) : [];
      const parentParts = parentName ? parentName.split(" ").filter(p => p.length >= 2) : [];

      // Full-name matches can auto-match only when unique across the school.
      const studentFullMatch = studentParts.length >= 2 && studentParts.every(part => normalizedRef.includes(part));
      const parentFullMatch = parentParts.length >= 2 && parentParts.every(part => normalizedRef.includes(part));

      if (studentFullMatch) {
        const duplicateCount = students.filter(s => {
          const n = normalizeLookup(s.name);
          const parts = n.split(" ").filter(p => p.length >= 2);
          return parts.length >= 2 && parts.every(part => normalizedRef.includes(part));
        }).length;
        if (duplicateCount === 1) {
          strongCandidates.push({ student, confidence: 97, reason: "Full student name in account reference (unique)" });
        } else {
          strongCandidates.push({ student, confidence: 55, reason: `Full student name in account reference but ${duplicateCount} students share this name \u2014 review required` });
        }
      } else if (parentFullMatch) {
        const siblingCount = students.filter(s => {
          const n = normalizeLookup(s.parentName);
          const parts = n ? n.split(" ").filter(p => p.length >= 2) : [];
          return parts.length >= 2 && parts.every(part => normalizedRef.includes(part));
        }).length;
        if (siblingCount === 1) {
          strongCandidates.push({ student, confidence: 93, reason: "Full parent name in account reference (unique)" });
        } else {
          strongCandidates.push({ student, confidence: 50, reason: `Full parent name in account reference but ${siblingCount} students share this parent \u2014 review required` });
        }
      } else if (studentParts.length >= 1 && studentParts.some(part => normalizedRef.includes(part))) {
        const matchedParts = studentParts.filter(part => normalizedRef.includes(part));
        const partialScore = Math.round(50 + (matchedParts.length / studentParts.length) * 30);
        strongCandidates.push({ student, confidence: partialScore, reason: `Partial student name in account reference (${matchedParts.join(", ")}) \u2014 review required` });
      } else if (parentParts.length >= 1 && parentParts.some(part => normalizedRef.includes(part))) {
        const matchedParts = parentParts.filter(part => normalizedRef.includes(part));
        const partialScore = Math.round(45 + (matchedParts.length / parentParts.length) * 30);
        strongCandidates.push({ student, confidence: partialScore, reason: `Partial parent name in account reference (${matchedParts.join(", ")}) \u2014 review required` });
      } else if (studentName && fuzzyScore(studentName, normalizedRef) >= 82) {
        strongCandidates.push({ student, confidence: 78, reason: "Fuzzy student name match in account reference \u2014 review required" });
      } else if (parentName && fuzzyScore(parentName, normalizedRef) >= 82) {
        strongCandidates.push({ student, confidence: 75, reason: "Fuzzy parent name match in account reference \u2014 review required" });
      }
    }
  }

  const uniqueStrongStudentIds = [...new Set(strongCandidates.map(c => c.student.id))];
  if (uniqueStrongStudentIds.length > 1) {
    const hint = hintBankTransaction({ normalized, students });
    const balance = hint.student ? Number(balances.get(hint.student.id)?.outstanding || 0) : 0;
    return {
      matchedStudentId: null,
      suggestedStudentId: hint.student?.id || null,
      suggestedReason: hint.reason || null,
      matchConfidence: 0,
      matchReason: "Multiple strong candidate students found — review required",
      requiredBalance: balance,
      paymentStatus: BANK_STATUS.NEEDS_REVIEW,
      matchStatus: MATCH_STATUS.NEEDS_REVIEW,
    };
  }

  if (uniqueStrongStudentIds.length === 1) {
    strong = strongCandidates.find(c => c.student.id === uniqueStrongStudentIds[0]);
  }

  const hint = strong ? strong : hintBankTransaction({ normalized, students });
  const existingByRef = normalized.transactionRef ? existingBankRefs.has(normalized.transactionRef) : false;
  const existingPaymentByRef = normalized.transactionRef ? existingPaymentRefs.has(normalized.transactionRef) : false;
  const fallbackDuplicate = !normalized.transactionRef ? fallbackDuplicateKeys.has(bankFallbackDuplicateKey(normalized)) : false;

  if (existingByRef || existingPaymentByRef || fallbackDuplicate) {
    return {
      matchedStudentId: strong?.student?.id || null,
      suggestedStudentId: !strong ? (hint.student?.id || null) : null,
      suggestedReason: !strong ? (hint.reason || null) : null,
      matchConfidence: strong?.confidence || 0,
      matchReason: strong?.reason || hint.reason,
      requiredBalance: hint.student ? Number(balances.get(hint.student.id)?.outstanding || 0) : 0,
      paymentStatus: BANK_STATUS.DUPLICATE,
      matchStatus: MATCH_STATUS.DUPLICATE,
    };
  }

  const balance = (strong?.student || hint.student) ? Number(balances.get((strong?.student || hint.student).id)?.outstanding || 0) : 0;
  if (!strong) {
    return {
      matchedStudentId: null,
      suggestedStudentId: hint.student?.id || null,
      suggestedReason: hint.reason || null,
      matchConfidence: 0,
      matchReason: hint.reason || "No valid student payment reference found",
      requiredBalance: balance,
      paymentStatus: BANK_STATUS.NEEDS_REVIEW,
      matchStatus: hint.student ? MATCH_STATUS.NEEDS_REVIEW : MATCH_STATUS.UNMATCHED,
    };
  }

  return {
    matchedStudentId: strong.student.id,
    suggestedStudentId: null,
    suggestedReason: null,
    matchConfidence: strong.confidence,
    matchReason: strong.reason,
    requiredBalance: balance,
    paymentStatus: classifyBankPaymentStatus(normalized.amount, balance, strong.confidence),
    matchStatus: strong.confidence >= 95 ? MATCH_STATUS.MATCHED : MATCH_STATUS.NEEDS_REVIEW,
  };
}

async function matchC2bPaybillTransaction({ userId, billRefNumber, payerName, narration, amount }) {
  const students = await prisma.student.findMany({ where: { userId }, select: { id: true, name: true, adm: true, cls: true, parentName: true, parentPhone: true }, take: 2000 });
  const invoices = await prisma.invoice.findMany({ where: { userId }, select: { id: true, invoiceNo: true, studentId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 500 });
  const balances = await deriveStudentBalancesBatch(students.map(s => s.id));
  return matchBankTransaction({
    normalized: {
      transactionRef: billRefNumber || "",
      payerName: payerName || "",
      narration: narration || "",
      amount,
      phone: null,
      paidAt: new Date(),
    },
    students,
    invoices,
    balances,
    existingBankRefs: new Set(),
    existingPaymentRefs: new Set(),
    fallbackDuplicateKeys: new Set(),
  });
}

async function matchMpesaEvent({ userId, billRefNumber, payerName, narration, amount, phone }) {
  const students = await prisma.student.findMany({ where: { userId }, select: { id: true, name: true, adm: true, cls: true, parentName: true, parentPhone: true, phone: true }, take: 2000 });
  const invoices = await prisma.invoice.findMany({ where: { userId }, select: { id: true, invoiceNo: true, studentId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 500 });
  const balances = await deriveStudentBalancesBatch(students.map(s => s.id));
  return matchBankTransaction({
    normalized: {
      transactionRef: billRefNumber || "",
      payerName: payerName || "",
      narration: narration || "",
      amount,
      phone: phone || "",
      paidAt: new Date(),
    },
    students,
    invoices,
    balances,
    existingBankRefs: new Set(),
    existingPaymentRefs: new Set(),
    fallbackDuplicateKeys: new Set(),
  });
}

function serializeBankTransaction(txn, studentsById = new Map()) {
  const student = txn.matchedStudentId ? studentsById.get(txn.matchedStudentId) : null;
  const suggested = txn.suggestedStudentId ? studentsById.get(txn.suggestedStudentId) : null;
  return {
    id: txn.id,
    uploadId: txn.uploadId,
    transactionRef: txn.transactionRef || "",
    amount: txn.amount,
    paidAt: txn.paidAt,
    payerName: txn.payerName || "",
    narration: txn.narration || "",
    matchedStudentId: txn.matchedStudentId || "",
    suggestedStudent: student ? { id: student.id, name: student.name, adm: student.adm, cls: student.cls } : null,
    suggestedStudentId: txn.suggestedStudentId || "",
    reviewHintStudent: suggested ? { id: suggested.id, name: suggested.name, adm: suggested.adm, cls: suggested.cls } : null,
    suggestedReason: txn.suggestedReason || "",
    bankPaymentReference: student ? studentBankPaymentReference(student) : "",
    matchConfidence: txn.matchConfidence || 0,
    matchReason: txn.matchReason || "",
    requiredBalance: txn.requiredBalance || 0,
    paymentStatus: txn.paymentStatus,
    createdReceiptId: txn.createdReceiptId || null,
    createdPaymentId: txn.createdPaymentId || null,
    overpaymentAmount: txn.paymentStatus === BANK_STATUS.OVERPAYMENT ? Math.max(0, Number(txn.amount || 0) - Number(txn.requiredBalance || 0)) : 0,
  };
}
if (!process.env.JWT_SECRET) {
  console.error("FATAL startup failure before listen: JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY && process.env.NODE_ENV === "production") {
  console.error("FATAL startup failure before listen: ENCRYPTION_KEY is not set in production. Refusing to start.");
  process.exit(1);
}
if (!process.env.BACKEND_URL && process.env.NODE_ENV === "production") {
  console.error("FATAL startup failure before listen: BACKEND_URL is required for public logo URLs.");
  process.exit(1);
}

const app    = express();
app.set("trust proxy", 1);
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
const LOGO_DIR = path.join(UPLOAD_ROOT, "logos");
fs.mkdirSync(LOGO_DIR, { recursive: true });
const SUPABASE_STORAGE_BUCKET = (process.env.SUPABASE_STORAGE_BUCKET || "school-logos").trim();
let supabaseClient = null;

// Fixed document theme colors (do not vary by school branding)
const DOC_PRIMARY = "#0B1F3A"; // dark navy
const DOC_ACCENT  = "#0EA5E9"; // bright blue
const DOC_SUCCESS = "#10B981"; // success green
const DOC_DANGER  = "#EF4444"; // danger/red for overdue/failed

const USER_BRANDING_SELECT = {
  schoolLogoUrl: true,
  schoolLogoPath: true,
  schoolTagline: true,
  schoolPrimaryColor: true,
  schoolSecondaryColor: true,
};

// ─── REQUEST CORRELATION ID + STRUCTURED REQUEST LOGGER ──────────────────────
// Every request gets a unique reqId so logs from callback → balance update →
// receipt can all be correlated by searching for the same reqId in your log tool.
// Redacts JWT and long base64url tokens from logged paths.
// Matches any path segment of 40+ chars containing only base64url characters
// (A-Z a-z 0-9 _ - .) which covers JWTs, hex tokens, and signed tokens.
// The reqId and ip are preserved for full traceability.
function redactPathTokens(path) {
  return String(path || "").replace(
    /\/[A-Za-z0-9_\-.]{40,}/g,
    "/[token]"
  );
}

app.use((req, _res, next) => {
  req.reqId = crypto.randomUUID();
  if (process.env.NODE_ENV !== "test")
    logger.info("http", `${req.method} ${redactPathTokens(req.path)}`, { reqId: req.reqId, ip: req.ip });
  next();
});

// ─── ENCRYPTION ──────────────────────────────────────────────────────────────
const _rawEncKey = process.env.ENCRYPTION_KEY || "";
if (!_rawEncKey || _rawEncKey.length < 32) {
  if (process.env.NODE_ENV === "production") {
    // Hard fail -- never boot production with a missing or weak key.
    // M-Pesa credentials stored in DB would be encrypted with a known
    // or weak key, making them trivially recoverable.
    console.error("FATAL: ENCRYPTION_KEY environment variable is missing or shorter than 32 characters. Server will not start.");
    process.exit(1);
  } else {
    // Development warning -- allow boot but make it obvious
    console.warn("[DEV WARNING] ENCRYPTION_KEY is not set or is too short. Using insecure default. NEVER deploy this to production.");
  }
}
const ENC_KEY = (_rawEncKey || "feeflow_default_key_32chars_pad!!").slice(0, 32);
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY), iv);
  return iv.toString("hex") + ":" + cipher.update(text, "utf8", "hex") + cipher.final("hex");
}

// AES-256-GCM - authenticated encryption. Prefix "gcm:" distinguishes from CBC.
function encryptGCM(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(ENC_KEY);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "gcm:" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptGCM(text) {
  if (!text) return null;
  try {
    const [, ivHex, tagHex, encHex] = text.split(":");
    if (!ivHex || !tagHex || !encHex) return null;
    const key = Buffer.from(ENC_KEY);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(encHex, "hex"), undefined, "utf8") + decipher.final("utf8");
  } catch { return null; }
}

function decrypt(text) {
  if (!text) return null;
  if (text.startsWith("gcm:")) return decryptGCM(text);
  try {
    const [ivHex, encrypted] = text.split(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
    return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
  } catch { return null; }
}

async function migrateCbcCredentialsToGcm() {
  const users = await prisma.user.findMany({
    where: { mpesaConfigured: true },
    select: { id: true, mpesaConsumerKey: true, mpesaConsumerSecret: true, mpesaPasskey: true },
  });
  let migrated = 0;
  for (const user of users) {
    const needsMigration = [user.mpesaConsumerKey, user.mpesaConsumerSecret, user.mpesaPasskey]
      .some(v => v && !v.startsWith("gcm:"));
    if (!needsMigration) continue;
    const ck = decrypt(user.mpesaConsumerKey);
    const cs = decrypt(user.mpesaConsumerSecret);
    const pk = decrypt(user.mpesaPasskey);
    if (!ck || !cs || !pk) continue;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        mpesaConsumerKey: encryptGCM(ck),
        mpesaConsumerSecret: encryptGCM(cs),
        mpesaPasskey: encryptGCM(pk),
      },
    });
    migrated++;
  }
  if (migrated > 0) logger.info("startup", `Migrated ${migrated} school(s) to GCM encryption`);
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Build allowed origins from environment variables and static list.
// ALLOWED_ORIGINS can be a comma-separated list for production multi-domain setups.
const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
const defaultAllowedOrigins = [
  "https://api.feeflowafrica.co.ke",
  "https://www.feeflowafrica.co.ke",
  "https://feeflowafrica.co.ke",
  // Old Render subdomain removed -- custom domain is now live.
  // Add back temporarily via ALLOWED_ORIGINS env var if needed during migration.
  "http://localhost:5173",
  "http://localhost:3000",
];
const envAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins].map(o => o.replace(/\/+$/, "")))];

app.use((req, res, next) => cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const ol = origin.replace(/\/+$/, "").toLowerCase();
    const isAllowed = allowedOrigins.some(o => o.toLowerCase() === ol);
    if (isAllowed) return callback(null, true);
    if (!isDev) logger.warn("cors", "Blocked origin", { origin, allowed: allowedOrigins, reqId: req.reqId });
    callback(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "PUT"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
})(req, res, next));

app.use("/uploads/proofs", (_req, res) => {
  res.status(404).json({ message: "Not found" });
});

const uploadStaticHeaders = (res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (res.req?.path?.endsWith(".svg")) {
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
  }
};

app.use("/uploads/logos", express.static(LOGO_DIR, {
  fallthrough: true,
  maxAge: "30d",
  immutable: true,
  setHeaders: uploadStaticHeaders,
}));

app.use("/uploads/logos", (req, res) => {
  logger.warn("uploads", "missing_logo_file", { path: redactPathTokens(req.path), reqId: req.reqId });
  res.status(404).json({ message: "Logo file not found" });
});

app.use("/uploads", express.static(UPLOAD_ROOT, {
  fallthrough: true,
  maxAge: "30d",
  immutable: true,
  setHeaders: uploadStaticHeaders,
}));

app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "blob:", "cdnjs.cloudflare.com", "fonts.googleapis.com", "app.posthog.com", "us-assets.i.posthog.com", "eu-assets.i.posthog.com"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "blob:", "cdnjs.cloudflare.com", "fonts.googleapis.com", "app.posthog.com", "us-assets.i.posthog.com", "eu-assets.i.posthog.com"],
      scriptSrcAttr: ["'self'", "'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:       ["'self'", "fonts.gstatic.com"],
      imgSrc:        ["'self'", "data:", "blob:", "https:", process.env.BACKEND_URL || ""].filter(Boolean),
      workerSrc:     ["'self'", "blob:"],
      connectSrc:    ["'self'", "app.posthog.com", "us.i.posthog.com", "eu.i.posthog.com"],
      frameSrc:      ["'none'"],
      objectSrc:     ["'none'"],
    },
  },
}));

// ─── RATE LIMITERS ────────────────────────────────────────────────────────────
// Philosophy: defence in depth. Each payment surface has its own limiter so a
// retry storm on the parent portal doesn't consume the admin dashboard's quota.

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 6,
  message: { message: "Too many registration attempts. Please try again in an hour." },
  standardHeaders: true, legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  message: { message: "Too many requests. Please slow down." },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => /^\/api\/payments\/c2b\/(?:confirm|validate)\/[a-f0-9]{64}$/.test(req.path),
});

const c2bWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: (req) => req.params.c2bToken || ipKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => false,
  message: { ResultCode: 1, ResultDesc: "Rate limit exceeded" },
});

// Admin STK push — authenticated, 10 pushes/min per school (generous but safe)
const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many PDF requests. Please wait a minute and try again." },
});

const bankSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  message: { message: "Too many submission attempts. Please wait 15 minutes and try again." },
});

const adminStkLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  keyGenerator: (req) => req.userId || ipKeyGenerator(req),
  message: { message: "Too many STK push requests. Please wait a minute before trying again." },
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res, _next, options) => {
    logger.warn("rate-limit", "Admin STK spike", { userId: req.userId, reqId: req.reqId });
    res.status(429).json(options.message);
  },
});

// Polling endpoint — parent portal polls /status every 5s; allow 60/min per IP
const pollLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  keyGenerator: ipKeyGenerator,
  message: { error: "Polling too fast. Please slow down." },
  standardHeaders: true, legacyHeaders: false,
  skip: () => false,
  validate: { xForwardedForHeader: false },
});

// Retry-eligibility check — lightweight endpoint, allow 30/min per IP
const retryCheckLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  keyGenerator: ipKeyGenerator,
  message: { eligible: false, reason: "rate_limited", message: "Too many requests. Please wait a moment." },
  standardHeaders: true, legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

app.use("/api/auth/login",                authLimiter);
app.use("/api/auth/register",             authLimiter);
app.use("/api/auth/start-registration",   registrationLimiter);
app.use("/api/auth/verify-registration-token", authLimiter);
app.use("/api/auth/complete-registration", authLimiter);
app.use("/api/auth/forgot-password",      authLimiter);
app.use("/api/auth/verify-reset-code",    authLimiter);
app.use("/api/",                          generalLimiter);

const publicApiPaths = [
  /^\/auth\/register$/,
  /^\/auth\/start-registration$/,
  /^\/auth\/verify-registration-token$/,
  /^\/auth\/complete-registration$/,
  /^\/auth\/login$/,
  /^\/auth\/forgot-password$/,
  /^\/auth\/verify-reset-code$/,
  /^\/staff\/invite\/verify$/,
  /^\/staff\/accept-invite$/,
  /^\/sms\/delivery$/,
  /^\/payments\/c2b\/confirm$/,
  /^\/payments\/c2b\/confirm\/[a-f0-9]{64}$/,
  /^\/payments\/c2b\/validate$/,
  /^\/payments\/c2b\/validate\/[a-f0-9]{64}$/,
  /^\/mpesa\/callback\/[^/]+$/,
  /^\/mpesa\/stk-cb\/[^/]+\/[^/]+$/,
  /^\/pay\/[^/]+$/,
  /^\/pay\/[^/]+\/status$/,
  /^\/pay\/[^/]+\/stk-status\/[^/]+$/,
  /^\/pay\/[^/]+\/retry-eligible$/,
  /^\/portal\/[^/]+$/,
  /^\/support\/public$/,
  /^\/billing\/mpesa\/callback\/[^/]+$/,
];

function isPublicApiPath(path) {
  return publicApiPaths.some((pattern) => pattern.test(path));
}

app.use("/api", async (req, res, next) => {
  if (isPublicApiPath(req.path)) return next();
  return requireAuth(req, res, next);
});

// Support endpoints (public & authenticated)
app.post('/api/support/public', async (req, res) => {
  try {
    const { name, email, phone, message } = req.body || {};
    if (!name || !email || !phone || !message) return res.status(400).json({ message: 'Missing required fields' });
    const safeHtml = renderEmailLayout({
      schoolName: 'FeeFlow Support',
      title: escHtml('New public support request'),
      bodyHtml: '<p><strong>Name:</strong> ' + escHtml(name) + '</p>'
        + '<p><strong>Email:</strong> ' + escHtml(email) + '</p>'
        + '<p><strong>Phone:</strong> ' + escHtml(phone) + '</p>'
        + '<p><strong>Message:</strong><br>' + escHtml(message) + '</p>',
      ctaText: 'Reply',
      link: 'mailto:feeflow254@gmail.com',
    });
    await sendEmail('feeflow254@gmail.com', 'Support: public request', safeHtml, { replyTo: email });
    res.json({ message: 'Support request submitted' });
  } catch (e) { return apiError(res, e, 'submit public support'); }
});

// Authenticated support endpoint moved later (after requireAuth)

// ----------- ZOD SCHEMAS ─────────────────────────────────────────────────────
const createStudentSchema = z.object({
  name: z.string().min(1).max(100),
  fee: z.number().nonnegative(),
  parentPhone: z.string().min(10),
});

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  schoolName: z.string().optional(),
});

const registrationStartSchema = z.object({ email: z.string().email() });
const registrationTokenSchema = z.object({ token: z.string().min(32) });
const completeRegistrationSchema = z.object({
  token: z.string().min(32),
  name: z.string().min(1).max(100),
  password: z.string().min(6, "Password must be at least 6 characters"),
  schoolName: z.string().optional(),
});

const forgotPasswordSchema = z.object({ email: z.string().email() });
const verifyResetCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit reset code"),
});
const resetPasswordSchema = z.object({
  resetToken: z.string().min(20),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});
const staffInviteSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().optional(),
  email: z.string().email(),
  jobTitle: z.string().max(100).optional(),
  permissions: z.array(z.string()).default([]),
});
const staffUpdateSchema = staffInviteSchema.partial().extend({
  status: z.enum(["invited", "active", "disabled"]).optional(),
});
const staffAcceptInviteSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(6, "Password must be at least 6 characters"),
});
const paymentReportQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  studentId: z.string().optional(),
  className: z.string().optional(),
  method: z.enum(["all", "mpesa", "manual", "cash", "bank"]).optional().default("all"),
  status: z.enum(["all", "valid", "reversed", "deleted"]).optional().default("valid"),
});
const bankApprovalSchema = z.object({
  transactionIds: z.array(z.string()).optional(),
  confirmOverpayment: z.boolean().optional().default(false),
});
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a valid hex color like #003366").optional().nullable();
const brandingSchema = z.object({
  schoolTagline: z.string().max(160).optional().nullable(),
  schoolPrimaryColor: colorSchema,
  schoolSecondaryColor: colorSchema,
});

// ─── PLAN LIMITS ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free: { students: 300, mpesa: false, invoices: false, receipts: false },
  pro:  { students: 800, mpesa: true,  invoices: true,  receipts: false },
  max:  { students: Infinity, mpesa: true, invoices: true, receipts: true },
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const STAFF_PERMISSIONS = new Set([
  "students.view", "students.create", "students.edit", "students.delete",
  "payments.view", "payments.create", "payments.reverse",
  "invoices.view", "invoices.create", "invoices.send",
  "receipts.view", "reports.view", "terms.manage",
  "settings.view", "settings.edit", "mpesa.view", "mpesa.edit", "staff.manage",
]);

const SENSITIVE_AUDIT_KEYS = /password|token|secret|passkey|consumer|credential|authorization/i;
function scrubAuditValue(value) {
  if (Array.isArray(value)) return value.map(scrubAuditValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_AUDIT_KEYS.test(key))
      .map(([key, val]) => [key, scrubAuditValue(val)]));
  }
  return value;
}

async function logAudit(req, { action, entityType = null, entityId = null, metadata = {}, schoolOwnerId = null, actorUserId = null, actorStaffId = null }) {
  try {
    const ownerId = schoolOwnerId || req?.ownerUserId || req?.userId || actorUserId;
    if (!ownerId || !action) return;
    await prisma.auditLog.create({
      data: {
        schoolOwnerId: ownerId,
        actorUserId: actorUserId ?? (req?.userType === "owner" ? req.userId : null),
        actorStaffId: actorStaffId ?? req?.staffId ?? null,
        action,
        entityType,
        entityId: entityId ? String(entityId) : null,
        metadataJson: scrubAuditValue(metadata || {}),
        ipAddress: req?.ip || null,
        userAgent: req?.headers?.["user-agent"] || null,
      },
    });
  } catch (e) {
    logger.warn("audit", "Audit write failed", { error: e.message, action });
  }
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signPublicLink({ id, ownerUserId, purpose, expiresInDays, secret }) {
  if (!secret) throw new Error(`${purpose.toUpperCase()}_LINK_SECRET is required`);
  return jwt.sign({ id, ownerUserId, purpose }, secret, { expiresIn: `${expiresInDays}d` });
}

function verifyPublicLink(token, purpose, secret) {
  if (!secret) throw Object.assign(new Error(`${purpose.toUpperCase()}_LINK_SECRET is not configured`), { statusCode: 503 });
  const payload = jwt.verify(token, secret);
  if (payload.purpose !== purpose || !payload.id || !payload.ownerUserId) {
    throw Object.assign(new Error("Invalid public link"), { statusCode: 401 });
  }
  return payload;
}

function invoiceLinkToken(invoice) {
  return signPublicLink({ id: invoice.id, ownerUserId: invoice.userId, purpose: "invoice", expiresInDays: 30, secret: process.env.INVOICE_LINK_SECRET || process.env.JWT_SECRET });
}

function receiptLinkToken(receipt) {
  return signPublicLink({ id: receipt.id, ownerUserId: receipt.userId, purpose: "receipt", expiresInDays: 90, secret: process.env.RECEIPT_LINK_SECRET || process.env.JWT_SECRET });
}

function isMaxPlan(user) {
  return (user?.plan || "free").toLowerCase() === "max" && (!user.planExpiry || new Date() <= new Date(user.planExpiry));
}

function effectivePlan(user) {
  const plan = (user?.plan || "free").toLowerCase();
  if (plan !== "free" && user?.planExpiry && new Date() > new Date(user.planExpiry)) return "free";
  return PLAN_LIMITS[plan] ? plan : "free";
}

function planFeatures(plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  return {
    mpesa: Boolean(limits.mpesa),
    invoices: Boolean(limits.invoices),
    receipts: Boolean(limits.receipts),
    students: limits.students === Infinity ? null : limits.students,
    staff: plan === "max",
  };
}

async function normalizeUserPlan(user, tx = prisma) {
  if (!user) return null;
  const plan = effectivePlan(user);
  if (plan !== user.plan) {
    await tx.user.update({ where: { id: user.id }, data: { plan: "free", planExpiry: null } });
    return { ...user, plan: "free", planExpiry: null };
  }
  return user;
}

function backendPublicBaseUrl() {
  const configured = (process.env.BACKEND_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("BACKEND_URL is required for public logo URLs");
  }
  return "http://localhost:3000";
}

function frontendPublicBaseUrl() {
  const configured = (process.env.FRONTEND_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("FRONTEND_URL is required for staff invite links");
  }
  return "http://localhost:3000";
}

function isBadStoredLogoUrl(url) {
  if (!url) return true;
  const value = String(url).trim();
  if (value.startsWith("/uploads/")) return true;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.pathname.startsWith("/uploads/logos/")) return true;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (process.env.NODE_ENV === "production" && host.includes("localhost")) return true;
    const frontend = process.env.FRONTEND_URL ? new URL(process.env.FRONTEND_URL) : null;
    if (frontend && parsed.origin === frontend.origin) return true;
    return false;
  } catch {
    return true;
  }
}

function publicUploadUrl(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const rel = path.relative(UPLOAD_ROOT, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return backendPublicBaseUrl() + "/uploads/" + rel.replace(/\\/g, "/");
}

function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && SUPABASE_STORAGE_BUCKET);
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

function publicSupabaseLogoUrl(objectPath) {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data } = client.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(objectPath);
  return data?.publicUrl || null;
}

function isSupabaseBucketMissing(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("bucket not found") || message.includes("bucket_not_found");
}

async function ensureSupabaseLogoBucket(client) {
  const { error } = await client.storage.createBucket(SUPABASE_STORAGE_BUCKET, {
    public: true,
    fileSizeLimit: 2 * 1024 * 1024,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  });
  if (error && !String(error.message || "").toLowerCase().includes("already exists")) {
    throw Object.assign(new Error("Could not create Supabase logo bucket '" + SUPABASE_STORAGE_BUCKET + "': " + error.message), { statusCode: 502 });
  }
  logger.info("branding", "Supabase logo bucket ready", { bucket: SUPABASE_STORAGE_BUCKET });
}

async function uploadLogoToSupabase({ userId, logoFile }) {
  const client = getSupabaseClient();
  if (!client) throw Object.assign(new Error("Supabase Storage is not configured. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET."), { statusCode: 503 });
  const stored = await optimizeLogoFile(logoFile);
  const suffix = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const objectPath = `${userId}/${suffix}-${logoFile.safeBase}.${stored.ext}`;
  const uploadOptions = {
    contentType: stored.mime,
    upsert: false,
    cacheControl: "2592000",
  };
  let { error } = await client.storage.from(SUPABASE_STORAGE_BUCKET).upload(objectPath, stored.buffer, uploadOptions);
  if (isSupabaseBucketMissing(error)) {
    logger.warn("branding", "Supabase logo bucket missing; attempting to create it", { bucket: SUPABASE_STORAGE_BUCKET });
    await ensureSupabaseLogoBucket(client);
    ({ error } = await client.storage.from(SUPABASE_STORAGE_BUCKET).upload(objectPath, stored.buffer, uploadOptions));
  }
  if (error) throw Object.assign(new Error("Could not upload logo to persistent storage: " + error.message), { statusCode: 502 });
  const publicUrl = publicSupabaseLogoUrl(objectPath);
  if (!publicUrl) throw Object.assign(new Error("Could not create public logo URL."), { statusCode: 502 });
  return { publicUrl, objectPath, ...stored };
}

async function fetchRemoteLogoDataUri(user, url) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
    if (!allowed.has(contentType)) throw new Error("Unsupported logo content type");
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > 2 * 1024 * 1024) throw new Error("Remote logo is larger than 2MB");
    const detected = sniffImage(buffer) || mimeTypeFromExtension(new URL(url).pathname);
    if (!detected) throw new Error("Remote logo is not a supported image");
    return "data:" + detected.mime + ";base64," + buffer.toString("base64");
  } catch (error) {
    logger.warn("branding", "remote_logo_fetch_failed", { userId: user?.id, url, error: error.message });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getPublicLogoUrl(user) {
  if (!user) return null;
  const stored = user.schoolLogoUrl ? String(user.schoolLogoUrl).trim() : "";
  if (stored && !isBadStoredLogoUrl(stored)) return stored;
  const safePath = safeLogoPath(user.schoolLogoPath);
  if (safePath && fs.existsSync(safePath)) return publicUploadUrl(safePath);
  return null;
}

async function getLogoDataUri(user) {
  const storedLogoUrl = user?.schoolLogoUrl ? String(user.schoolLogoUrl).trim() : "";
  if (storedLogoUrl && !isBadStoredLogoUrl(storedLogoUrl) && /^https?:\/\//i.test(storedLogoUrl)) {
    return fetchRemoteLogoDataUri(user, storedLogoUrl);
  }
  if (!user?.schoolLogoPath) return null;
  const safePath = safeLogoPath(user.schoolLogoPath);
  if (!safePath) {
    logger.warn("branding", "logo_path_invalid", { userId: user.id, schoolLogoPath: user.schoolLogoPath });
    logger.info("branding", "logo_fallback_used", { userId: user.id, reason: "invalid_schoolLogoPath" });
    return null;
  }

  logger.info("branding", "logo_path_present", { userId: user.id, schoolLogoPath: safePath });
  try {
    await fsp.access(safePath, fs.constants.R_OK);
    const buffer = await fsp.readFile(safePath);
    const detected = sniffImage(buffer) || mimeTypeFromExtension(safePath);
    if (!detected) {
      logger.warn("branding", "logo_invalid_image", { userId: user.id, schoolLogoPath: safePath });
      logger.info("branding", "logo_fallback_used", { userId: user.id, reason: "invalid_image" });
      return null;
    }
    const dataUri = "data:" + detected.mime + ";base64," + buffer.toString("base64");
    logger.info("branding", "logo_data_uri_generated", { userId: user.id, mime: detected.mime, size: buffer.length });
    return dataUri;
  } catch (error) {
    logger.warn("branding", "logo_file_read_failed", { userId: user.id, schoolLogoPath: safePath, error: error.message });
    logger.info("branding", "logo_fallback_used", { userId: user.id, reason: "read_error" });
    return null;
  }
}

function mimeTypeFromExtension(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return { ext: "png", mime: "image/png" };
  if (ext === ".jpg" || ext === ".jpeg") return { ext: "jpg", mime: "image/jpeg" };
  if (ext === ".webp") return { ext: "webp", mime: "image/webp" };
  return null;
}

function brandingPayload(user, { includeInternal = false } = {}) {
  const logoUrl = getPublicLogoUrl(user);
  const payload = {
    schoolLogoUrl: logoUrl || null,
    schoolTagline: user?.schoolTagline || null,
    schoolPrimaryColor: user?.schoolPrimaryColor || null,
    schoolSecondaryColor: user?.schoolSecondaryColor || null,
  };
  if (includeInternal) payload.schoolLogoPath = user?.schoolLogoPath || null;
  return payload;
}

async function repairStoredLogoUrl(user) {
  if (!user?.id) return user;
  const repaired = getPublicLogoUrl(user);
  const current = user.schoolLogoUrl || null;
  if (repaired && repaired !== current) {
    await prisma.user.update({ where: { id: user.id }, data: { schoolLogoUrl: repaired } }).catch(e => {
      logger.warn("branding", "Could not repair stored logo URL", { userId: user.id, error: e.message });
    });
    return { ...user, schoolLogoUrl: repaired };
  }
  if (!repaired && current && isBadStoredLogoUrl(current)) {
    await prisma.user.update({ where: { id: user.id }, data: { schoolLogoUrl: null } }).catch(e => {
      logger.warn("branding", "Could not clear bad stored logo URL", { userId: user.id, error: e.message });
    });
    return { ...user, schoolLogoUrl: null };
  }
  return user;
}

function safeLogoPath(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  return resolved === LOGO_DIR || resolved.startsWith(LOGO_DIR + path.sep) ? resolved : null;
}

async function deleteLogoFile(filePath) {
  const safePath = safeLogoPath(filePath);
  if (!safePath) return;
  await fsp.unlink(safePath).catch(() => {});
}

function sanitizeBaseName(filename) {
  return path.basename(String(filename || "logo")).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "logo";
}

function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}

function sniffSvg(buffer) {
  const head = buffer.toString("utf8", 0, Math.min(buffer.length, 512)).replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml\b[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return { ext: "svg", mime: "image/svg+xml" };
  return null;
}

function parseMultipartLogo(buffer, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || "");
  if (!boundaryMatch) throw Object.assign(new Error("Invalid upload form data."), { statusCode: 400 });
  const boundary = Buffer.from("--" + boundaryMatch[1].replace(/^"|"$/g, ""));
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    const next = buffer.indexOf(boundary, cursor + boundary.length);
    if (next === -1) break;
    let part = buffer.subarray(cursor + boundary.length, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > -1) {
      const headers = part.subarray(0, headerEnd).toString("latin1");
      const body = part.subarray(headerEnd + 4);
      if (/name="logo"/i.test(headers) && /filename="/i.test(headers)) {
        const filename = /filename="([^"]*)"/i.exec(headers)?.[1] || "logo";
        const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || "";
        return { filename, mime, buffer: body };
      }
    }
    cursor = next;
  }
  throw Object.assign(new Error("Logo file is required."), { statusCode: 400 });
}

function logoUploadMiddleware(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return res.status(400).json({ message: "Upload must be multipart/form-data." });
  const maxBytes = 2 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  req.on("data", chunk => {
    total += chunk.length;
    if (total > maxBytes + 64 * 1024) req.destroy(Object.assign(new Error("Logo must be 2MB or smaller."), { statusCode: 413 }));
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const parsed = parseMultipartLogo(Buffer.concat(chunks), contentType);
      if (parsed.buffer.length > maxBytes) throw Object.assign(new Error("Logo must be 2MB or smaller."), { statusCode: 413 });
      const detected = sniffImage(parsed.buffer) || sniffSvg(parsed.buffer);
      if (detected?.ext === "svg") {
        throw Object.assign(new Error("SVG files are not allowed for logos. Please upload a PNG, JPG, or WebP image."), { statusCode: 400 });
      }
      const allowedMimes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
      if (!detected || !allowedMimes.has(parsed.mime)) throw Object.assign(new Error("Only PNG, JPG, JPEG, and WEBP images are allowed."), { statusCode: 400 });
      if (parsed.mime !== detected.mime && !(parsed.mime === "image/jpg" && detected.mime === "image/jpeg")) throw Object.assign(new Error("File content does not match its image type."), { statusCode: 400 });
      req.logoFile = { ...parsed, detected, safeBase: sanitizeBaseName(parsed.filename) };
      next();
    } catch (e) {
      res.status(e.statusCode || 400).json({ message: e.message || "Invalid logo upload." });
    }
  });
  req.on("error", e => res.status(e.statusCode || 400).json({ message: e.message || "Upload failed." }));
}

function parseMultipartFile(buffer, contentType, fieldName) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("Upload boundary missing."), { statusCode: 400 });
  const boundary = Buffer.from("--" + (match[1] || match[2]));
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    const next = buffer.indexOf(boundary, cursor + boundary.length);
    if (next === -1) break;
    let part = buffer.subarray(cursor + boundary.length, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > -1) {
      const headers = part.subarray(0, headerEnd).toString("latin1");
      const body = part.subarray(headerEnd + 4);
      const name = /name="([^"]+)"/i.exec(headers)?.[1];
      if (name === fieldName && /filename="/i.test(headers)) {
        const filename = /filename="([^"]*)"/i.exec(headers)?.[1] || "statement";
        const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || "";
        return { filename, mime, buffer: body };
      }
    }
    cursor = next;
  }
  throw Object.assign(new Error("Bank statement file is required."), { statusCode: 400 });
}

function statementUploadMiddleware(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return res.status(400).json({ message: "Upload must be multipart/form-data." });
  const maxBytes = 10 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  req.on("data", chunk => {
    total += chunk.length;
    if (total > maxBytes + 64 * 1024) req.destroy(Object.assign(new Error("Statement must be 10MB or smaller."), { statusCode: 413 }));
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const parsed = parseMultipartFile(Buffer.concat(chunks), contentType, "statement");
      if (parsed.buffer.length > maxBytes) throw Object.assign(new Error("Statement must be 10MB or smaller."), { statusCode: 413 });
      const ext = path.extname(parsed.filename || "").toLowerCase();
      const allowedMimes = new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/pdf", "application/octet-stream", ""]);
      if (![".csv", ".xlsx", ".pdf"].includes(ext) || !allowedMimes.has(parsed.mime)) throw Object.assign(new Error("Only CSV, Excel (.xlsx), and PDF statements are supported."), { statusCode: 400 });
      req.statementFile = { ...parsed, ext };
      next();
    } catch (e) {
      res.status(e.statusCode || 400).json({ message: e.message || "Invalid statement upload." });
    }
  });
  req.on("error", e => res.status(e.statusCode || 400).json({ message: e.message || "Upload failed." }));
}

// Parse a multipart/form-data buffer into fields and files (simple parser)
function parseMultipartForm(buffer, contentType) {
  const match = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("Upload boundary missing."), { statusCode: 400 });
  const boundary = Buffer.from("--" + (match[1] || match[2]));
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    const next = buffer.indexOf(boundary, cursor + boundary.length);
    if (next === -1) break;
    let part = buffer.subarray(cursor + boundary.length, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > -1) {
      const headers = part.subarray(0, headerEnd).toString("latin1");
      const body = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^\"]+)"/i.exec(headers);
      const filenameMatch = /filename="([^\"]*)"/i.exec(headers);
      const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      const name = nameMatch ? nameMatch[1] : null;
      const filename = filenameMatch ? filenameMatch[1] : null;
      const mime = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : null;
      parts.push({ name, filename, mime, buffer: body });
    }
    cursor = next;
  }
  const fields = {};
  const files = {};
  for (const p of parts) {
    if (p.filename) files[p.name] = { filename: p.filename, mime: p.mime, buffer: p.buffer };
    else fields[p.name] = p.buffer.toString("utf8");
  }
  return { fields, files };
}

function proofUploadMiddleware(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return res.status(400).json({ message: "Upload must be multipart/form-data." });
  const maxBytes = 5 * 1024 * 1024; // 5MB
  const chunks = [];
  let total = 0;
  req.on("data", chunk => {
    total += chunk.length;
    if (total > maxBytes + 64 * 1024) req.destroy(Object.assign(new Error("Proof must be 5MB or smaller."), { statusCode: 413 }));
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const parsed = parseMultipartForm(Buffer.concat(chunks), contentType);
      const file = parsed.files["proof"] || null;
      if (file && file.filename && file.buffer.length > 0) {
        if (file.buffer.length > maxBytes) throw Object.assign(new Error("Proof must be 5MB or smaller."), { statusCode: 413 });
        const ext = path.extname(file.filename || "").toLowerCase();
        const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
        const allowedMimes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf", "application/octet-stream", ""]);
        if (!allowed.has(ext) || !allowedMimes.has(file.mime || "")) throw Object.assign(new Error("Only PNG, JPG, JPEG, WEBP and PDF proofs are allowed."), { statusCode: 400 });
        req.proofFile = { ...file, ext, safeBase: sanitizeBaseName(file.filename) };
      } else {
        req.proofFile = null;
      }
      req.multipartForm = parsed; // expose fields and files
      next();
    } catch (e) {
      res.status(e.statusCode || 400).json({ message: e.message || "Invalid proof upload." });
    }
  });
  req.on("error", e => res.status(e.statusCode || 400).json({ message: e.message || "Upload failed." }));
}

async function optimizeLogoFile(logoFile) {
  try {
    const sharp = (await import("sharp")).default;
    const buffer = await sharp(logoFile.buffer, { limitInputPixels: 4096 * 4096 })
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    return { buffer, ext: "webp", mime: "image/webp" };
  } catch {
    // Sharp is optional in this deployment. The strict 2MB cap and magic-byte
    // validation still keep PDFs and public pages lightweight when it is absent.
    return { buffer: logoFile.buffer, ext: logoFile.detected.ext, mime: logoFile.detected.mime };
  }
}

function renderBrandLogo(userOrData, className = "school-logo") {
  const logoSrc = userOrData?.schoolLogoDataUri || getPublicLogoUrl(userOrData);
  return logoSrc
    ? "<img class='" + className + "' src='" + escHtml(logoSrc) + "' alt='School logo'>"
    : "<div class='" + className + " logo-fallback'>" + escHtml((userOrData?.schoolName || "S").slice(0, 1).toUpperCase()) + "</div>";
}

function renderPdfBrandLogo(userOrData, className = "school-logo") {
  if (userOrData?.schoolLogoDataUri) {
    return "<img class='" + className + "' src='" + escHtml(userOrData.schoolLogoDataUri) + "' alt='School logo'>";
  }
  if (userOrData?.schoolLogoUrl) {
    return "<img class='" + className + "' src='" + escHtml(userOrData.schoolLogoUrl) + "' alt='School logo'>";
  }
  return "<div class='" + className + " logo-fallback'>" + escHtml((userOrData?.schoolName || "S").slice(0, 1).toUpperCase()) + "</div>";
}

const requireAuth = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
  try {
    const payload = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    if ((payload.userType || "owner") === "staff") {
      const staff = await prisma.staffUser.findUnique({
        where: { id: payload.staffId },
        include: { owner: { select: { id: true, plan: true, planExpiry: true, passwordChangedAt: true } } },
      });
      if (!staff || staff.status !== "active" || staff.ownerUserId !== payload.ownerUserId) {
        return res.status(401).json({ message: "Invalid or inactive staff session" });
      }
      if (!isMaxPlan(staff.owner)) return res.status(403).json({ message: "Staff access requires the school owner's Max plan." });
      req.userType = "staff";
      req.userId = staff.ownerUserId;
      req.ownerUserId = staff.ownerUserId;
      req.staffId = staff.id;
      req.staff = staff;
      req.permissions = Array.isArray(staff.permissions) ? staff.permissions : [];
      return next();
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(401).json({ message: "Invalid or expired token" });
    if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    const normalizedUser = await normalizeUserPlan(user);
    req.userId = payload.userId;
    req.ownerUserId = payload.userId;
    req.userType = "owner";
    req.user = normalizedUser;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const requirePermission = (permission) => async (req, res, next) => {
  if (req.userType === "owner") return next();
  if (!req.staff || req.staff.status !== "active") return res.status(403).json({ message: "Staff account is inactive." });
  const owner = await prisma.user.findUnique({ where: { id: req.ownerUserId } });
  if (!isMaxPlan(owner)) return res.status(403).json({ message: "Staff access requires the school owner's Max plan." });
  if (permission === "staff.manage" && !req.permissions.includes("staff.manage")) {
    return res.status(403).json({ message: "You do not have permission to manage staff." });
  }
  if (!req.permissions.includes(permission)) {
    return res.status(403).json({ message: "You do not have permission to perform this action.", permission });
  }
  next();
};

const requireAnyPermission = (permissions) => async (req, res, next) => {
  if (req.userType === "owner") return next();
  if (!req.staff || req.staff.status !== "active") return res.status(403).json({ message: "Staff account is inactive." });
  const owner = await prisma.user.findUnique({ where: { id: req.ownerUserId } });
  if (!isMaxPlan(owner)) return res.status(403).json({ message: "Staff access requires the school owner's Max plan." });
  if (!permissions.some(permission => req.permissions.includes(permission))) {
    return res.status(403).json({ message: "You do not have permission to perform this action.", permissions });
  }
  next();
};

// Authenticated support endpoint (requires valid session)
app.post('/api/support/authenticated', requireAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ message: 'Message is required' });
    const user = req.user || (await prisma.user.findUnique({ where: { id: req.userId } }));
    const safeHtml = renderEmailLayout({
      schoolName: user?.schoolName || 'FeeFlow Account',
      title: escHtml('Authenticated support request'),
      bodyHtml: '<p><strong>Account:</strong> ' + escHtml(user?.email || user?.name || String(req.userId)) + '</p>'
        + '<p><strong>User name:</strong> ' + escHtml(user?.name || '') + '</p>'
        + '<p><strong>Message:</strong><br>' + escHtml(message) + '</p>',
      ctaText: 'Reply',
      link: 'mailto:feeflow254@gmail.com',
    });
    await sendEmail('feeflow254@gmail.com', 'Support: authenticated request', safeHtml, { replyTo: user?.email });
    res.json({ message: 'Support request submitted' });
  } catch (e) { return apiError(res, e, 'submit authenticated support'); }
});

const requireOwner = (req, res, next) => {
  if (req.userType !== "owner") return res.status(403).json({ message: "Owner account required." });
  next();
};

// Platform-admin gate for FeeFlow's own internal admin dashboard (not school-facing).
// Must run AFTER requireAuth, since it relies on req.user being populated.
// Staff accounts can never be platform admins — only an owner-type account with
// isPlatformAdmin=true on the User row (set manually, there is no self-serve UI for this).
const requirePlatformAdmin = (req, res, next) => {
  if (req.userType !== "owner" || !req.user?.isPlatformAdmin) {
    return res.status(403).json({ message: "Not authorized." });
  }
  next();
};

const requireMaxPlan = async (req, res, next) => {
  try {
    const user = await normalizeUserPlan(req.user || await prisma.user.findUnique({ where: { id: req.userId } }));
    if (!isMaxPlan(user)) return res.status(403).json({ message: "Staff management requires Max plan." });
    req.user = user;
    next();
  } catch (e) { return apiError(res, e, "max plan check", req); }
};

const requirePlan = (feature) => async (req, res, next) => {
  try {
    const user = await normalizeUserPlan(await prisma.user.findUnique({ where: { id: req.userId } }));
    let plan = user?.plan || "free";

    if (!PLAN_LIMITS[plan]?.[feature]) {
      return res.status(403).json({
        message: "This feature requires a Pro or Max plan. You are on " + plan.toUpperCase() + ".",
        upgradeRequired: true, feature,
      });
    }
    req.user = user;
    next();
  } catch (e) { return apiError(res, e, "plan check"); }
};

// BUG FIX: pick() now includes mpesaConfigured so the frontend can show
// whether M-Pesa is set up, without leaking encrypted credentials.
function pick(u) {
  const plan = effectivePlan(u);
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    schoolName: u.schoolName,
    plan,
    planExpiry: plan === "free" ? null : u.planExpiry,
    features: planFeatures(plan),
    ...brandingPayload(u),
    ...bankPaybillPayload(u),
    mpesaConfigured: u.mpesaConfigured || false,
    whatsappEnabled: u.whatsappEnabled || false,
    isPlatformAdmin: u.isPlatformAdmin || false,
  };
}

// ─── STRUCTURED ERROR HANDLER ─────────────────────────────────────────────────
// Use: return apiError(res, e, "context", req)
// reqId from req enables cross-log correlation in Sentry/Logtail/Datadog.
function apiError(res, e, context = "", req = null) {
  logger.error(context || "api", safeErrorMessage(e), { reqId: req?.reqId, code: e?.code });

  if (e?.code === "P2002") return res.status(409).json({ message: "This record already exists — a duplicate was detected." });
  if (e?.code === "P2025") return res.status(404).json({ message: "The record you are trying to update no longer exists." });
  if (e?.code === "P2003") return res.status(400).json({ message: "This action references a record that does not exist. Please refresh." });
  if (e?.code === "P2016") return res.status(404).json({ message: "Record not found. It may have been deleted." });
  if (e?.code?.startsWith("P1")) return res.status(503).json({ message: "Cannot connect to the database. Please try again." });
  if (e?.name === "AbortError") return res.status(504).json({ message: "The request timed out. Please try again." });
  if (e?.message?.includes("fetch")) return res.status(502).json({ message: "Could not reach an external service. Please try again." });
  if (e?.name === "JsonWebTokenError") return res.status(401).json({ message: "Your session is invalid. Please log in again." });
  if (e?.name === "TokenExpiredError")  return res.status(401).json({ message: "Your session has expired. Please log in again." });
  if (e?.statusCode) return res.status(e.statusCode).json({ message: e.message });
  if (e?.message?.includes("required")) return res.status(400).json({ message: e.message });

  const ctx = context ? context + ": " : "";
  return res.status(500).json({ message: ctx + "An unexpected error occurred. Please try again." });
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  return res.status(400).json({ message: "Registration now requires email verification. Start with your email address." });
});

app.post("/api/auth/start-registration", async (req, res) => {
  const parsed = registrationStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const email = parsed.data.email.toLowerCase().trim();
  const generic = { message: "Check your email to continue registration." };
  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.json(generic);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.preRegistrationVerification.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });

    await prisma.preRegistrationVerification.create({
      data: { email, tokenHash, expiresAt },
    });

    const link = `${process.env.FRONTEND_URL || "http://localhost:4173"}/register?token=${encodeURIComponent(token)}`;
    const emailHtml = renderEmailLayout({
      schoolName: "FeeFlow",
      schoolLogoUrl: null,
      schoolTagline: null,
      title: "Finish your FeeFlow registration",
      bodyHtml: `
        <p>Click the button below to finish registering your FeeFlow account for <strong>${escHtml(email)}</strong>.</p>
        <p style="margin: 24px 0;"><a href="${escHtml(link)}" style="display:inline-block;padding:12px 24px;border-radius:8px;background:${DOC_PRIMARY};color:#ffffff;text-decoration:none;font-weight:600;">Complete registration</a></p>
        <p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>
      `,
      ctaText: "Complete registration",
      link,
      accent: DOC_PRIMARY,
    });

    await sendEmail(email, "Finish your FeeFlow registration", emailHtml).catch((emailError) => {
      logger.warn("registration", "Verification email failed", { email, error: emailError.message });
    });

    if (!existingUser) {
      await logAudit(req, { action: "registration_started", entityType: "pre_registration", metadata: { email } });
    }

    return res.json(generic);
  } catch (e) {
    return apiError(res, e, "start registration");
  }
});

app.get("/api/auth/verify-registration-token", async (req, res) => {
  const parsed = registrationTokenSchema.safeParse({ token: String(req.query.token || "") });
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const tokenHash = hashToken(parsed.data.token);
  try {
    const record = await prisma.preRegistrationVerification.findFirst({
      where: { tokenHash },
      orderBy: { createdAt: "desc" },
    });
    if (!record) return res.status(400).json({ message: "Registration link is invalid or has expired." });
    if (record.usedAt || record.expiresAt <= new Date()) {
      await prisma.preRegistrationVerification.update({ where: { id: record.id }, data: { attempts: record.attempts + 1 } }).catch(() => {});
      return res.status(400).json({ message: "Registration link is invalid or has expired." });
    }
    return res.json({ valid: true, email: record.email });
  } catch (e) {
    return apiError(res, e, "verify registration token");
  }
});

app.post("/api/auth/complete-registration", async (req, res) => {
  const parsed = completeRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const { token, name, password, schoolName } = parsed.data;
  const tokenHash = hashToken(token);
  try {
    const record = await prisma.preRegistrationVerification.findFirst({
      where: { tokenHash },
      orderBy: { createdAt: "desc" },
    });
    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      if (record) await prisma.preRegistrationVerification.update({ where: { id: record.id }, data: { attempts: record.attempts + 1 } }).catch(() => {});
      return res.status(400).json({ message: "Registration link is invalid or has expired." });
    }

    const email = record.email.toLowerCase().trim();
    if (await prisma.user.findUnique({ where: { email } })) {
      await prisma.preRegistrationVerification.update({ where: { id: record.id }, data: { attempts: record.attempts + 1, usedAt: new Date() } }).catch(() => {});
      return res.status(400).json({ message: "Registration link is invalid or has expired." });
    }

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: await bcrypt.hash(password, 10),
        schoolName,
        plan: "free",
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });

    await prisma.preRegistrationVerification.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await logAudit(req, { action: "registration_completed", entityType: "user", entityId: user.id, schoolOwnerId: user.id, actorUserId: user.id, metadata: { email } });
    const authToken = jwt.sign({ userId: user.id, userType: "owner", ownerUserId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    return res.status(201).json({ token: authToken, user: pick(user) });
  } catch (e) {
    return apiError(res, e, "complete registration");
  }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const email = parsed.data.email.toLowerCase().trim();
  const { password } = parsed.data;
  try {
    const user = await repairStoredLogoUrl(await normalizeUserPlan(await prisma.user.findUnique({ where: { email } })));
    if (user && (await bcrypt.compare(password, user.password))) {
      const token = jwt.sign({ userId: user.id, userType: "owner", ownerUserId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
      await logAudit(req, { action: "login_success", entityType: "user", entityId: user.id, schoolOwnerId: user.id, actorUserId: user.id });
      return res.json({ token, user: pick(user) });
    }

    const staff = await prisma.staffUser.findUnique({ where: { email }, include: { owner: true } });
    if (!staff || staff.status !== "active" || !staff.passwordHash || !(await bcrypt.compare(password, staff.passwordHash))) {
      if (user) await logAudit(req, { action: "login_failure", entityType: "user", entityId: user.id, schoolOwnerId: user.id, actorUserId: user.id, metadata: { reason: "bad_credentials" } });
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const owner = await repairStoredLogoUrl(staff.owner);
    if (!isMaxPlan(owner)) return res.status(403).json({ message: "Staff login requires the school owner's Max plan." });
    await prisma.staffUser.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
    const token = jwt.sign({ userType: "staff", ownerUserId: staff.ownerUserId, staffId: staff.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    await logAudit(req, { action: "login_success", entityType: "staff", entityId: staff.id, schoolOwnerId: staff.ownerUserId, actorStaffId: staff.id });
    res.json({ token, user: { ...pick(owner), userType: "staff", staffId: staff.id, staffName: staff.name, permissions: staff.permissions || [] } });
  } catch (e) { return apiError(res, e, "login"); }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await repairStoredLogoUrl(await normalizeUserPlan(await prisma.user.findUnique({ where: { id: req.userId } })));
    if (!user) return res.status(404).json({ message: "Not found" });
    const responseUser = req.userType === "staff"
      ? { ...pick(user), userType: "staff", staffId: req.staffId, staffName: req.staff?.name, permissions: req.permissions || [] }
      : { ...pick(user), userType: "owner" };
    res.json(responseUser);
  } catch (e) { return apiError(res, e, "get me"); }
});

app.post("/api/auth/refresh", requireAuth, async (req, res) => {
  try {
    const user = await repairStoredLogoUrl(await normalizeUserPlan(await prisma.user.findUnique({ where: { id: req.userId } })));
    if (!user) return res.status(404).json({ message: "Not found" });
    const token = req.userType === "staff"
      ? jwt.sign({ userType: "staff", ownerUserId: req.ownerUserId, staffId: req.staffId }, process.env.JWT_SECRET, { expiresIn: "30d" })
      : jwt.sign({ userId: user.id, userType: "owner", ownerUserId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    const responseUser = req.userType === "staff"
      ? { ...pick(user), userType: "staff", staffId: req.staffId, staffName: req.staff?.name, permissions: req.permissions || [] }
      : { ...pick(user), userType: "owner" };
    res.json({ token, user: responseUser });
  } catch (e) { return apiError(res, e, "refresh auth"); }
});

app.patch("/api/auth/profile", requireAuth, requirePermission("settings.edit"), async (req, res) => {
  const { name, phone, schoolName } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(name && { name }),
        ...(phone !== undefined && { phone }),
        ...(schoolName !== undefined && { schoolName }),
      },
    });
    res.json(pick(user));
  } catch (e) { return apiError(res, e, "update profile"); }
});

app.patch("/api/settings/notifications", requireAuth, requirePermission("settings.edit"), async (req, res) => {
  const updateData = {};
  if (typeof req.body?.whatsappEnabled === "boolean") {
    updateData.whatsappEnabled = req.body.whatsappEnabled;
  }
  if (!Object.keys(updateData).length) return res.status(400).json({ message: "No notification setting supplied" });
  try {
    const user = await prisma.user.update({ where: { id: req.userId }, data: updateData });
    await logAudit(req, { action: "notification_settings_updated", entityType: "settings", entityId: req.userId, metadata: updateData });
    res.json({ message: "Notification settings updated", user: pick(user) });
  } catch (e) { return apiError(res, e, "update notification settings", req); }
});

app.get("/api/internal/wa-queue-status", requireAuth, requireOwner, (req, res) => {
  res.json({
    queueLength: waQueue.length,
    running: waQueueRunning,
    totalEnqueued: waTotalEnqueued,
    totalSent: waTotalSent,
    totalFailed: waTotalFailed,
    delayMs: WA_DELAY_MS,
    estimatedSecondsRemaining: Math.ceil((waQueue.length * WA_DELAY_MS) / 1000),
  });
});

// School branding is workspace identity, not FeeFlow platform branding.
// Logo uploads are stored with generated names and returned as public URLs only;
// internal filesystem paths stay server-side.
app.get("/api/settings/branding", requireAuth, requirePermission("settings.view"), async (req, res) => {
  try {
    const user = await repairStoredLogoUrl(await prisma.user.findUnique({ where: { id: req.userId } }));
    if (!user) return res.status(404).json({ message: "School account not found" });
    res.json({
      schoolName: user.schoolName || "School",
      ...brandingPayload(user),
    });
  } catch (e) { return apiError(res, e, "get branding", req); }
});

app.patch("/api/settings/branding", requireAuth, requirePermission("settings.edit"), async (req, res) => {
  const parsed = brandingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  try {
    const clean = {
      schoolTagline: parsed.data.schoolTagline?.trim() || null,
      schoolPrimaryColor: parsed.data.schoolPrimaryColor || null,
      schoolSecondaryColor: parsed.data.schoolSecondaryColor || null,
    };
    const user = await prisma.user.update({ where: { id: req.userId }, data: clean });
    await logAudit(req, { action: "school_branding_updated", entityType: "user", entityId: user.id, metadata: clean });
    res.json({ message: "School branding updated", branding: brandingPayload(user), user: pick(user) });
  } catch (e) { return apiError(res, e, "update branding", req); }
});

app.post("/api/settings/logo", requireAuth, requirePermission("settings.edit"), logoUploadMiddleware, async (req, res) => {
  try {
    const current = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!current) return res.status(404).json({ message: "School account not found" });

    let stored;
    let nextLogoPath = null;
    if (isSupabaseConfigured()) {
      stored = await uploadLogoToSupabase({ userId: req.userId, logoFile: req.logoFile });
    } else if (process.env.NODE_ENV === "production") {
      return res.status(503).json({ message: "Persistent logo storage is not configured. Add Supabase Storage environment variables and try again." });
    } else {
      const optimized = await optimizeLogoFile(req.logoFile);
      const suffix = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
      const filename = `${req.userId}-${suffix}-${req.logoFile.safeBase}.${optimized.ext}`;
      const filePath = path.join(LOGO_DIR, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(LOGO_DIR + path.sep)) return res.status(400).json({ message: "Invalid upload path" });
      await fsp.writeFile(resolved, optimized.buffer, { flag: "wx" });
      stored = { ...optimized, publicUrl: publicUploadUrl(resolved), objectPath: null };
      nextLogoPath = resolved;
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { schoolLogoPath: nextLogoPath, schoolLogoUrl: stored.publicUrl },
    });
    if (current.schoolLogoPath && current.schoolLogoPath !== nextLogoPath) await deleteLogoFile(current.schoolLogoPath);
    await logAudit(req, { action: "school_logo_uploaded", entityType: "user", entityId: user.id, metadata: { mime: stored.mime, bytes: stored.buffer.length, storage: stored.objectPath ? "supabase" : "local" } });
    res.json({ message: "School logo uploaded", branding: brandingPayload(user), user: pick(user) });
  } catch (e) { return apiError(res, e, "upload logo", req); }
});

app.delete("/api/settings/logo", requireAuth, requirePermission("settings.edit"), async (req, res) => {
  try {
    const current = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!current) return res.status(404).json({ message: "School account not found" });
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { schoolLogoUrl: null, schoolLogoPath: null },
    });
    await deleteLogoFile(current.schoolLogoPath);
    await logAudit(req, { action: "school_logo_removed", entityType: "user", entityId: user.id });
    res.json({ message: "School logo removed", branding: brandingPayload(user), user: pick(user) });
  } catch (e) { return apiError(res, e, "remove logo", req); }
});

app.patch("/api/auth/email", requireAuth, requirePermission("settings.edit"), async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and current password required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    // BUG FIX: guard against null user before bcrypt.compare
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Current password is incorrect" });
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists && exists.id !== req.userId) return res.status(400).json({ message: "Email already in use" });
    const updated = await prisma.user.update({ where: { id: req.userId }, data: { email } });
    res.json(pick(updated));
  } catch (e) { return apiError(res, e, "change email"); }
});

app.patch("/api/auth/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both passwords required" });
  if (newPassword.length < 6) return res.status(400).json({ message: "Min 6 characters" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    // BUG FIX: guard against null user before bcrypt.compare
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ message: "Current password is incorrect" });
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        password: await bcrypt.hash(newPassword, 10),
        passwordChangedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
      },
    });
    res.json({ message: "Password updated" });
  } catch (e) { return apiError(res, e, "change password"); }
});

// ─── M-PESA CREDENTIALS (per-school) ─────────────────────────────────────────
app.patch("/api/auth/mpesa", requireAuth, requirePermission("mpesa.edit"), async (req, res) => {
  const { consumerKey, consumerSecret, shortcode, passkey } = req.body;
  if (!consumerKey || !consumerSecret || !shortcode || !passkey)
    return res.status(400).json({ message: "All M-Pesa fields are required" });
  try {
    const existingUser = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!existingUser) return res.status(404).json({ message: "School account not found" });
    const c2bToken = crypto.randomBytes(32).toString("hex");
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        mpesaConsumerKey:    encryptGCM(consumerKey),
        mpesaConsumerSecret: encryptGCM(consumerSecret),
        mpesaShortcode:      shortcode,
        mpesaPasskey:        encryptGCM(passkey),
        mpesaConfigured:     true,
        c2bCallbackToken:    existingUser.c2bCallbackToken ?? c2bToken,
      },
    });
    logAudit(req, { action: "mpesa_credentials_updated", entityType: "settings", entityId: req.userId, metadata: { shortcode } });
    res.json({ message: "M-Pesa credentials saved" });
  } catch (e) { return apiError(res, e, "save M-Pesa credentials"); }
});

app.get("/api/settings/mpesa-callback-urls", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.mpesaConfigured || !user?.c2bCallbackToken) {
      return res.status(400).json({ message: "Save your M-Pesa credentials first to generate callback URLs." });
    }
    const base = process.env.BACKEND_URL || "http://localhost:3000";
    const token = user.c2bCallbackToken;
    res.json({
      confirmUrl: `${base}/api/payments/c2b/confirm/${token}`,
      validateUrl: `${base}/api/payments/c2b/validate/${token}`,
      instructions: "Paste these exact URLs into your Daraja C2B webhook configuration. Do not share them publicly.",
    });
  } catch (e) {
    return apiError(res, e, "get M-Pesa callback URLs", req);
  }
});

app.patch("/api/auth/bank-paybill", requireAuth, requirePermission("mpesa.edit"), async (req, res) => {
  const clean = {
    bankPaybillNumber: String(req.body?.bankPaybillNumber || "").trim() || null,
    bankAccountNumber: String(req.body?.bankAccountNumber || "").trim() || null,
    bankAccountName: String(req.body?.bankAccountName || "").trim() || null,
    bankName: String(req.body?.bankName || "").trim() || null,
    bankPaymentInstructions: String(req.body?.bankPaymentInstructions || "").trim() || null,
  };
  try {
    const user = await prisma.user.update({ where: { id: req.userId }, data: clean });
    logAudit(req, { action: "bank_paybill_settings_updated", entityType: "settings", entityId: req.userId, metadata: { hasBankPaybillInfo: hasBankPaybillInfo(user) } });
    res.json({ message: "Bank / Paybill info saved", user: pick(user), ...bankPaybillPayload(user) });
  } catch (e) { return apiError(res, e, "save bank paybill info", req); }
});

app.patch("/api/auth/sms", requireAuth, async (req, res) => {
  res.status(403).json({ message: "SMS credentials are now managed centrally by the administrator." });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
// Reset codes are stored as bcrypt hashes in PasswordResetToken. The API returns
// generic forgot-password responses so attackers cannot enumerate school owners.
app.post("/api/auth/forgot-password", async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const email = parsed.data.email.toLowerCase().trim();
  const generic = { message: "If your email is registered, you will receive a reset code." };
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json(generic);

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await prisma.passwordResetToken.create({ data: { userId: user.id, email, codeHash: await bcrypt.hash(code, 10), expiresAt } });
    await logAudit(req, { action: "password_reset_requested", entityType: "user", entityId: user.id, schoolOwnerId: user.id, actorUserId: user.id });

    const emailHtml = "<div style='font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px'>"
      + "<h2 style='color:#003366'>Password Reset - FeeFlow</h2>"
      + "<p>Hi " + user.name + ",</p>"
      + "<p>You requested a password reset for your FeeFlow account.</p>"
      + "<div style='background:#f0f4f8;padding:20px;border-radius:8px;text-align:center;margin:20px 0'>"
      + "<p style='margin:0;font-size:24px;font-weight:bold;color:#003366;letter-spacing:3px'>" + code + "</p></div>"
      + "<p>This code will expire in 15 minutes.</p>"
      + "<p>If you didn't request this, please ignore this email.</p>"
      + "<hr style='border:none;border-top:1px solid #eee;margin:30px 0'>"
      + "<p style='color:#666;font-size:12px'>Sent by FeeFlow Fee Management Platform</p></div>";

    try {
      await sendEmail(email, "Password Reset Code - FeeFlow", emailHtml);
    } catch (emailError) {
      logger.error("auth", "Failed to send password reset email", {
        error: safeErrorMessage(emailError),
        reqId: req.reqId,
      });
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, email, usedAt: null },
        data: { usedAt: new Date() },
      }).catch(() => {});
    }
    return res.json(generic);
  } catch (e) { return apiError(res, e, "forgot password"); }
});

app.post("/api/auth/verify-reset-code", async (req, res) => {
  const parsed = verifyResetCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const email = parsed.data.email.toLowerCase().trim();
  const { code } = parsed.data;
  try {
    const resetData = await prisma.passwordResetToken.findFirst({ where: { email, usedAt: null }, orderBy: { createdAt: "desc" } });
    if (!resetData) return res.status(400).json({ message: "Invalid or expired code" });
    if (new Date() > resetData.expiresAt) {
      await prisma.passwordResetToken.update({ where: { id: resetData.id }, data: { usedAt: new Date() } });
      return res.status(400).json({ message: "Code expired. Please request a new code." });
    }
    if (resetData.attempts >= 5) {
      await prisma.passwordResetToken.update({ where: { id: resetData.id }, data: { usedAt: new Date() } });
      return res.status(400).json({ message: "Too many incorrect attempts. Please request a new code." });
    }
    if (!(await bcrypt.compare(code, resetData.codeHash))) {
      await prisma.passwordResetToken.update({ where: { id: resetData.id }, data: { attempts: { increment: 1 } } });
      return res.status(400).json({ message: "Invalid code" });
    }
    const resetToken = jwt.sign({ resetId: resetData.id, userId: resetData.userId, email, purpose: "password_reset" }, process.env.JWT_SECRET, { expiresIn: "15m" });
    res.json({ resetToken });
  } catch (e) { return apiError(res, e, "verify reset code"); }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const { resetToken, newPassword } = parsed.data;
  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    if (decoded.purpose !== "password_reset") return res.status(400).json({ message: "Invalid reset token" });
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(400).json({ message: "Invalid reset token" });
    const resetData = await prisma.passwordResetToken.findFirst({
      where: { id: decoded.resetId, userId: user.id, email: decoded.email, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!resetData) return res.status(400).json({ message: "Invalid or expired reset token" });
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          password: await bcrypt.hash(newPassword, 10),
          passwordChangedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
        },
      });
      await tx.passwordResetToken.update({ where: { id: resetData.id }, data: { usedAt: new Date() } });
    });
    await logAudit(req, { action: "password_reset_completed", entityType: "user", entityId: user.id, schoolOwnerId: user.id, actorUserId: user.id });
    res.json({
      message: "Password reset successfully",
      token: jwt.sign({ userId: user.id, userType: "owner", ownerUserId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" }),
    });
  } catch (jwtError) {
    if (jwtError.name === "JsonWebTokenError" || jwtError.name === "TokenExpiredError")
      return res.status(400).json({ message: "Invalid or expired reset token" });
    return apiError(res, jwtError, "reset password");
  }
});

// ─── TERMS ────────────────────────────────────────────────────────────────────
app.get("/api/staff", requireAuth, requireOwner, requireMaxPlan, async (req, res) => {
  try {
    const staff = await prisma.staffUser.findMany({
      where: { ownerUserId: req.userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, phone: true, email: true, jobTitle: true, permissions: true, status: true, invitedAt: true, inviteExpiresAt: true, lastLoginAt: true, createdAt: true, updatedAt: true },
    });
    res.json(staff);
  } catch (e) { return apiError(res, e, "list staff", req); }
});

app.post("/api/staff/invite", requireAuth, requireOwner, requireMaxPlan, async (req, res) => {
  const parsed = staffInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  try {
    const permissions = parsed.data.permissions.filter(p => STAFF_PERMISSIONS.has(p));
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const staff = await prisma.staffUser.create({
      data: { ownerUserId: req.userId, name: parsed.data.name, phone: parsed.data.phone || null, email: parsed.data.email.toLowerCase().trim(), jobTitle: parsed.data.jobTitle || null, permissions, status: "invited", inviteTokenHash: hashToken(inviteToken), inviteExpiresAt },
    });
    const link = new URL("/staff/accept", frontendPublicBaseUrl()).toString() + "?token=" + inviteToken;
    await sendEmail(staff.email, "FeeFlow staff invitation", "<p>You have been invited to FeeFlow.</p><p><a href='" + link + "'>Create your password</a></p><p>This link expires in 48 hours.</p>").catch(e => logger.warn("staff", "Invite email failed", { error: e.message }));
    await logAudit(req, { action: "staff_invited", entityType: "staff", entityId: staff.id, metadata: { email: staff.email, permissions } });
    res.status(201).json({ id: staff.id, email: staff.email, status: staff.status, inviteExpiresAt, inviteLink: process.env.NODE_ENV === "production" ? undefined : link });
  } catch (e) { return apiError(res, e, "invite staff", req); }
});

app.get("/api/staff/invite/verify", async (req, res) => {
  const parsed = registrationTokenSchema.safeParse({ token: String(req.query.token || "") });
  if (!parsed.success) return res.status(400).json({ message: "Invitation token is required." });
  try {
    const staff = await prisma.staffUser.findFirst({
      where: { inviteTokenHash: hashToken(parsed.data.token), status: "invited", inviteExpiresAt: { gt: new Date() } },
      select: { email: true, name: true, jobTitle: true, inviteExpiresAt: true },
    });
    if (!staff) return res.status(400).json({ message: "Invalid or expired invitation link." });
    res.json({ email: staff.email, name: staff.name, jobTitle: staff.jobTitle, inviteExpiresAt: staff.inviteExpiresAt });
  } catch (e) { return apiError(res, e, "verify staff invite", req); }
});

app.post("/api/staff/accept-invite", async (req, res) => {
  const parsed = staffAcceptInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  try {
    const staff = await prisma.staffUser.findFirst({ where: { inviteTokenHash: hashToken(parsed.data.token), status: "invited", inviteExpiresAt: { gt: new Date() } }, include: { owner: true } });
    if (!staff) return res.status(400).json({ message: "Invalid or expired invitation link." });
    if (!isMaxPlan(staff.owner)) return res.status(403).json({ message: "Staff access requires the school owner's Max plan." });
    await prisma.staffUser.update({ where: { id: staff.id }, data: { passwordHash: await bcrypt.hash(parsed.data.password, 10), status: "active", inviteTokenHash: null, inviteExpiresAt: null } });
    await logAudit(req, { action: "staff_invite_accepted", entityType: "staff", entityId: staff.id, schoolOwnerId: staff.ownerUserId, actorStaffId: staff.id });
    res.json({ message: "Staff account activated. You can now log in." });
  } catch (e) { return apiError(res, e, "accept staff invite", req); }
});

app.patch("/api/staff/:id", requireAuth, requireOwner, requireMaxPlan, async (req, res) => {
  const parsed = staffUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  try {
    const existing = await prisma.staffUser.findFirst({ where: { id: req.params.id, ownerUserId: req.userId } });
    if (!existing) return res.status(404).json({ message: "Staff member not found" });
    const data = parsed.data;
    const staff = await prisma.staffUser.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.phone !== undefined && { phone: data.phone || null }),
        ...(data.email !== undefined && { email: data.email.toLowerCase().trim() }),
        ...(data.jobTitle !== undefined && { jobTitle: data.jobTitle || null }),
        ...(data.permissions !== undefined && { permissions: data.permissions.filter(p => STAFF_PERMISSIONS.has(p)) }),
        ...(data.status !== undefined && { status: data.status, ...(data.status === "disabled" && { inviteTokenHash: null, inviteExpiresAt: null }) }),
      },
    });
    await logAudit(req, { action: "staff_updated", entityType: "staff", entityId: staff.id, metadata: { permissions: staff.permissions } });
    if (data.permissions !== undefined) await logAudit(req, { action: "role_permission_changed", entityType: "staff", entityId: staff.id, metadata: { permissions: staff.permissions } });
    res.json({ id: staff.id, name: staff.name, phone: staff.phone, email: staff.email, jobTitle: staff.jobTitle, permissions: staff.permissions, status: staff.status, inviteExpiresAt: staff.inviteExpiresAt, lastLoginAt: staff.lastLoginAt });
  } catch (e) { return apiError(res, e, "update staff", req); }
});

app.post("/api/staff/:id/resend-invite", requireAuth, requireOwner, requireMaxPlan, async (req, res) => {
  try {
    const existing = await prisma.staffUser.findFirst({ where: { id: req.params.id, ownerUserId: req.userId } });
    if (!existing) return res.status(404).json({ message: "Staff member not found" });
    if (existing.status === "active") return res.status(400).json({ message: "This staff member is already active." });

    const inviteToken = crypto.randomBytes(32).toString("hex");
    const inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const staff = await prisma.staffUser.update({
      where: { id: existing.id },
      data: { status: "invited", inviteTokenHash: hashToken(inviteToken), inviteExpiresAt },
    });
    const link = (process.env.FRONTEND_URL || backendPublicBaseUrl()) + "/staff/accept?token=" + inviteToken;
    await sendEmail(staff.email, "FeeFlow staff invitation", "<p>You have been invited to FeeFlow.</p><p><a href='" + link + "'>Create your password</a></p><p>This link expires in 48 hours.</p>").catch(e => logger.warn("staff", "Invite resend email failed", { error: e.message }));
    await logAudit(req, { action: "staff_invite_resent", entityType: "staff", entityId: staff.id, metadata: { email: staff.email } });
    res.json({ message: "Invite resent", inviteExpiresAt, inviteLink: process.env.NODE_ENV === "production" ? undefined : link });
  } catch (e) { return apiError(res, e, "resend staff invite", req); }
});

app.delete("/api/staff/:id", requireAuth, requireOwner, requireMaxPlan, async (req, res) => {
  try {
    const staff = await prisma.staffUser.findFirst({ where: { id: req.params.id, ownerUserId: req.userId } });
    if (!staff) return res.status(404).json({ message: "Staff member not found" });
    await prisma.staffUser.update({ where: { id: staff.id }, data: { status: "disabled", inviteTokenHash: null, inviteExpiresAt: null } });
    await logAudit(req, { action: "staff_removed", entityType: "staff", entityId: staff.id });
    res.json({ message: "Staff member disabled" });
  } catch (e) { return apiError(res, e, "remove staff", req); }
});

function normalizeClassFees(feeUpdates) {
  if (!feeUpdates || typeof feeUpdates !== "object" || Array.isArray(feeUpdates)) return null;
  const classFees = {};
  for (const [rawClass, rawAmount] of Object.entries(feeUpdates)) {
    const cls = String(rawClass || "").trim();
    if (!cls) continue;
    const amount = safeNumber(rawAmount);
    classFees[cls] = Number.isFinite(amount) ? amount : 0;
  }
  return classFees;
}

function normalizedClassName(cls) {
  return String(cls || "").trim();
}

function classFeeForTerm(term, cls) {
  const fees = term?.classFees && typeof term.classFees === "object" ? term.classFees : {};
  const amount = Number(fees[normalizedClassName(cls)] || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

async function assignTermChargesForExistingStudents({ userId, termId, classFees }) {
  const fees = classFees && typeof classFees === "object" ? classFees : {};
  const students = await prisma.student.findMany({
    where: { userId, deletedAt: null },
    select: { id: true, name: true, adm: true, cls: true },
    orderBy: { createdAt: "asc" },
  });
  const missingClassFeeStudents = [];
  let createdCount = 0;
  let skippedExistingCount = 0;

  logger.info("terms", "Applying saved class fees to students", { userId, termId, studentsFound: students.length, classFeeCount: Object.keys(fees).length });

  for (let i = 0; i < students.length; i += 500) {
    const batch = students.slice(i, i + 500);
    const existingCharges = await prisma.studentCharge.findMany({
      where: { userId, termId, type: "tuition", voidedAt: null, studentId: { in: batch.map(s => s.id) } },
      select: { studentId: true },
    });
    const alreadyCharged = new Set(existingCharges.map(c => c.studentId));
    skippedExistingCount += alreadyCharged.size;

    const rows = [];
    for (const student of batch) {
      if (alreadyCharged.has(student.id)) continue;
      const cls = normalizedClassName(student.cls);
      const amount = safeNumber(fees[cls]);
      if (amount <= 0) {
        missingClassFeeStudents.push({ studentId: student.id, name: student.name, adm: student.adm, cls: student.cls || "" });
        continue;
      }
      rows.push({
        studentId: student.id,
        userId,
        termId,
        type: "tuition",
        description: "Term tuition fee",
        amount,
        idempotencyKey: `term:${termId}:student:${student.id}:tuition`,
      });
    }

    if (rows.length > 0) {
      const result = await prisma.studentCharge.createMany({ data: rows, skipDuplicates: true });
      createdCount += result.count;
      skippedExistingCount += rows.length - result.count;
    }
  }

  logger.info("terms", "Finished applying saved class fees", {
    userId,
    termId,
    studentsFound: students.length,
    chargesCreated: createdCount,
    skippedExistingCount,
    missingClassFeeStudents: missingClassFeeStudents.length,
  });

  return { termId, createdCount, skippedExistingCount, missingClassFeeStudents };
}

async function reconcileTermTuitionCharges(tx, { userId, termId, classFees }) {
  const fees = classFees && typeof classFees === "object" ? classFees : {};
  const students = await tx.student.findMany({
    where: { userId, deletedAt: null },
    select: { id: true, name: true, adm: true, cls: true },
    orderBy: { createdAt: "asc" },
  });
  const existingCharges = await tx.studentCharge.findMany({
    where: { userId, termId, type: "tuition", voidedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const tuitionByStudent = new Map();
  for (const charge of existingCharges) {
    if (!tuitionByStudent.has(charge.studentId)) tuitionByStudent.set(charge.studentId, charge);
  }

  let updatedCount = 0;
  let createdCount = 0;
  let skippedExistingCount = 0;
  const missingClassFeeStudents = [];

  for (const student of students) {
    const cls = normalizedClassName(student.cls);
    const amount = safeNumber(fees[cls]);
    if (amount <= 0) {
      missingClassFeeStudents.push({ studentId: student.id, name: student.name, adm: student.adm, cls: student.cls || "" });
      continue;
    }

    const existing = tuitionByStudent.get(student.id);
    if (existing) {
      // Accounting-sensitive: update the existing charge row in place so any
      // PaymentAllocation rows remain attached to the same ledger obligation.
      if (Number(existing.amount) !== amount || existing.description !== "Term tuition fee") {
        await tx.studentCharge.update({
          where: { id: existing.id },
          data: { amount, description: "Term tuition fee", idempotencyKey: existing.idempotencyKey || `term:${termId}:student:${student.id}:tuition` },
        });
        updatedCount += 1;
      } else {
        skippedExistingCount += 1;
      }
      continue;
    }

    await createStudentChargeSafe(tx, {
      studentId: student.id,
      userId,
      termId,
      type: "tuition",
      description: "Term tuition fee",
      amount,
      idempotencyKey: `term:${termId}:student:${student.id}:tuition`,
    });
    createdCount += 1;
  }

  return { updatedCount, createdCount, skippedExistingCount, missingClassFeeStudents };
}

async function applySavedClassFeesToTerm({ userId, termId }) {
  const term = await prisma.term.findFirst({ where: { id: termId, userId } });
  if (!term) return null;
  return assignTermChargesForExistingStudents({ userId, termId: term.id, classFees: term.classFees || {} });
}

async function createActiveTermChargeForStudent(tx, { userId, studentId, term, cls, amount }) {
  const feeAmount = Number(amount || 0) > 0 ? Number(amount || 0) : classFeeForTerm(term, cls);
  if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
    logger.warn("terms", "Student created without active term class fee", { userId, studentId, termId: term?.id, cls: normalizedClassName(cls) });
    return null;
  }
  return createStudentChargeSafe(tx, {
    studentId,
    userId,
    termId: term.id,
    type: "tuition",
    description: "Term tuition fee",
    amount: feeAmount,
    idempotencyKey: `term:${term.id}:student:${studentId}:tuition`,
  });
}

app.post("/api/terms", requireAuth, requirePermission("terms.manage"), async (req, res) => {
  const { name, startDate, endDate, feeUpdates } = req.body;
  if (!name || !startDate || !endDate) return res.status(400).json({ message: "name, startDate and endDate required" });
  try {
    const activeClasses = await prisma.student.findMany({
      where: { userId: req.userId, deletedAt: null },
      select: { cls: true },
      distinct: ["cls"],
    });
    const classFees = normalizeClassFees(feeUpdates);
    if (!classFees || Object.keys(classFees).length === 0) {
      return res.status(400).json({ message: "Please set a fee for every class before starting the term." });
    }
    const classes = Object.keys(classFees);
    for (const cls of classes) {
      const amount = safeNumber(classFees[cls]);
      if (amount < 0) {
        return res.status(400).json({ message: "Class fees cannot be negative." });
      }
    }
    for (const row of activeClasses) {
      const cls = normalizedClassName(row.cls);
      if (cls && !classes.includes(cls)) {
        return res.status(400).json({ message: "Please set a fee for every class before starting the term." });
      }
    }

    const term = await prisma.$transaction(async (tx) => {
      await tx.term.updateMany({ where: { userId: req.userId, status: "active" }, data: { status: "closed" } });
      return tx.term.create({
        data: { name, startDate: new Date(startDate), endDate: new Date(endDate), status: "active", userId: req.userId, classFees },
      });
    });
    logger.info("terms", "Term created", { userId: req.userId, termId: term.id, classFeeCount: classes.length, reqId: req.reqId });
    logAudit(req, { action: "term_created", entityType: "term", entityId: term.id, metadata: { name: term.name, classFeeCount: classes.length } });
    let feeApplication = null;
    try {
      feeApplication = await assignTermChargesForExistingStudents({ userId: req.userId, termId: term.id, classFees });
      if (feeApplication.missingClassFeeStudents.length) {
        logger.warn("terms", "Some students had no matching class fee", { termId: term.id, userId: req.userId, missingCount: feeApplication.missingClassFeeStudents.length, reqId: req.reqId });
      }
    } catch (chargeError) {
      logger.error("terms", "Failed to assign charges after term creation", { error: chargeError.message, termId: term.id, userId: req.userId, reqId: req.reqId });
    }
    res.status(201).json({ ...term, feeApplication });
  } catch (e) { return apiError(res, e, "create term"); }
});

async function handlePatchTerm(req, res) {
  const { name, startDate, endDate } = req.body;
  const rawFees = req.body.feeUpdates ?? req.body.classFees;
  if (!name || !startDate || !endDate) return res.status(400).json({ message: "name, startDate and endDate required" });
  if (new Date(endDate) <= new Date(startDate)) return res.status(400).json({ message: "End date must be after start date." });

  const classFees = normalizeClassFees(rawFees);
  if (!classFees || Object.keys(classFees).length === 0) {
    return res.status(400).json({ message: "Please set class fees before saving the term." });
  }
  for (const [cls, amount] of Object.entries(classFees)) {
    if (safeNumber(amount) < 0) return res.status(400).json({ message: `Class fee for ${cls} cannot be negative.` });
  }

  try {
    const existing = await prisma.term.findFirst({ where: { id: req.params.termId, userId: req.userId } });
    if (!existing) return res.status(404).json({ message: "Term not found" });
    if (existing.status !== "active") return res.status(400).json({ message: "Only the current active term can be edited for now." });

    const result = await prisma.$transaction(async (tx) => {
      const term = await tx.term.update({
        where: { id: existing.id },
        data: { name: String(name).trim(), startDate: new Date(startDate), endDate: new Date(endDate), classFees },
      });
      const feeApplication = await reconcileTermTuitionCharges(tx, { userId: req.userId, termId: existing.id, classFees });
      return { term, feeApplication };
    });

    await logAudit(req, { action: "term_updated", entityType: "term", entityId: existing.id, metadata: { feeApplication: result.feeApplication } });
    res.json(result);
  } catch (e) { return apiError(res, e, "update term", req); }
}

app.patch("/api/terms/:termId", requireAuth, requirePermission("terms.manage"), handlePatchTerm);
// Backward-compatible alias for any stale frontend bundle that used the older
// edit path. The canonical route remains PATCH /api/terms/:termId.
app.patch("/api/terms/edit/:termId", requireAuth, requirePermission("terms.manage"), handlePatchTerm);

app.post("/api/terms/:termId/apply-fees", requireAuth, requirePermission("terms.manage"), async (req, res) => {
  try {
    const result = await applySavedClassFeesToTerm({ userId: req.userId, termId: req.params.termId });
    if (!result) return res.status(404).json({ message: "Term not found" });
    res.json({
      termId: req.params.termId,
      createdCount: result.createdCount,
      skippedExistingCount: result.skippedExistingCount,
      missingClassFeeStudents: result.missingClassFeeStudents,
    });
  } catch (e) { return apiError(res, e, "apply term fees", req); }
});

async function buildTermReportData(userId, termId) {
  const term = await prisma.term.findFirst({ where: { id: termId, userId } });
  if (!term) return null;

  const [charges, students] = await Promise.all([
    prisma.studentCharge.findMany({
      where: { userId, termId: term.id, voidedAt: null },
      select: { id: true, studentId: true, amount: true },
    }),
    prisma.student.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, adm: true, cls: true, parentName: true, parentPhone: true },
      orderBy: [{ cls: "asc" }, { name: "asc" }],
    }),
  ]);
    const chargeIds = charges.map(c => c.id);
    const allocations = chargeIds.length
      ? await prisma.paymentAllocation.findMany({
          where: {
            studentChargeId: { in: chargeIds },
            payment: { reversedAt: null, isReversal: false, deletedAt: null },
          },
          select: { amount: true, studentChargeId: true },
        })
      : [];

    const chargesByStudent = {};
    const chargeToStudent = {};
    for (const charge of charges) {
      const amount = Number(charge.amount || 0);
      chargesByStudent[charge.studentId] = (chargesByStudent[charge.studentId] || 0) + amount;
      chargeToStudent[charge.id] = charge.studentId;
    }
    const paidByStudent = {};
    for (const allocation of allocations) {
      const studentId = chargeToStudent[allocation.studentChargeId];
      if (studentId) paidByStudent[studentId] = (paidByStudent[studentId] || 0) + Number(allocation.amount || 0);
    }

    const rows = students.map(student => {
      const termCharges = safeNumber(chargesByStudent[student.id]);
      const termPaid = Math.min(termCharges, safeNumber(paidByStudent[student.id]));
      const termBalance = Math.max(0, termCharges - termPaid);
      const status = termCharges <= 0 ? "no_charges" : termBalance <= 0 ? "fully_paid" : termPaid > 0 ? "partial" : "unpaid";
      return {
        id: student.id,
        name: student.name,
        adm: student.adm,
        bankPaymentReference: studentBankPaymentReference(student),
        cls: student.cls,
        parentName: student.parentName,
        parentPhone: student.parentPhone,
        termCharges,
        termPaid,
        termBalance,
        status,
      };
    });

    const totalExpected = rows.reduce((sum, row) => sum + safeNumber(row.termCharges), 0);
    const totalCollected = rows.reduce((sum, row) => sum + safeNumber(row.termPaid), 0);
    const totalRemaining = Math.max(0, totalExpected - totalCollected);
    const collectionRate = totalExpected > 0 ? (totalCollected / totalExpected) * 100 : 0;

  return {
    term,
    summary: {
      totalExpected,
      totalCollected,
      totalRemaining,
      collectionRate,
      fullyPaidCount: rows.filter(row => row.status === "fully_paid").length,
      partialCount: rows.filter(row => row.status === "partial").length,
      unpaidCount: rows.filter(row => row.status === "unpaid").length,
      noChargeCount: rows.filter(row => row.status === "no_charges").length,
    },
    students: rows,
  };
}

app.get("/api/terms/:termId/report", requireAuth, requireAnyPermission(["reports.view", "terms.manage"]), async (req, res) => {
  try {
    const data = await buildTermReportData(req.userId, req.params.termId);
    if (!data) return res.status(404).json({ message: "Term not found" });
    res.json(data);
  } catch (e) { return apiError(res, e, "get term report", req); }
});

app.get("/api/terms/:termId/report/pdf", requireAuth, requireAnyPermission(["reports.view", "terms.manage"]), pdfLimiter, async (req, res) => {
  try {
    const [data, user] = await Promise.all([
      buildTermReportData(req.userId, req.params.termId),
      prisma.user.findUnique({ where: { id: req.userId }, select: { schoolName: true, ...USER_BRANDING_SELECT } }),
    ]);
    if (!data || !user) return res.status(404).json({ message: "Term not found" });
    const logoSrc = await getLogoDataUri(user);
    const html = renderTermReportPdfHtml({ ...data, user: { ...user, schoolLogoDataUri: logoSrc, schoolLogoUrl: null } });
    const pdf = await generatePdfFromHtml(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"Term-Report-" + pdfFilePart(data.term.name, "term") + ".pdf\"");
    res.send(pdf);
  } catch (e) { return apiError(res, e, "term report pdf", req); }
});

app.get("/api/terms", requireAuth, requirePermission("reports.view"), async (req, res) => {
  try {
    const terms = await prisma.term.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(terms);
  } catch (e) { return apiError(res, e, "get terms"); }
});

// ─── STUDENTS ─────────────────────────────────────────────────────────────────
function recomputeOverdue(students, termStartDate) {
  if (!termStartDate) return students;
  const termStart = new Date(termStartDate).getTime();
  const now       = Date.now();
  return students.map(s => {
    if ((s.outstanding ?? 0) <= 0) return { ...s, daysOverdue: 0 };
    const days = Math.max(0, Math.floor((now - termStart) / (1000 * 60 * 60 * 24)));
    return { ...s, daysOverdue: days };
  });
}

app.get("/api/students", requireAuth, requirePermission("students.view"), async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId, deletedAt: null }, orderBy: { createdAt: "desc" } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const studentIds = students.map(s => s.id);
    const [lifetimeBalances, termBalances] = await Promise.all([
      deriveStudentBalancesBatch(studentIds),
      deriveStudentCurrentTermReceivedBalancesBatch(studentIds, activeTerm),
    ]);
    const payload = students.map(s => {
      const lifetime = lifetimeBalances.get(s.id) || {};
      const term = termBalances.get(s.id) || {};
      const { fee: _legacyFee, paid: _legacyPaid, ...publicStudent } = s;
      return {
        ...publicStudent,
        bankPaymentReference: studentBankPaymentReference(s),
        currentTermCharges: term.currentTermCharges ?? 0,
        currentTermPaid: term.currentTermPaid ?? 0,
        currentTermBalance: term.currentTermBalance ?? term.currentTermOutstanding ?? 0,
        currentTermOutstanding: term.currentTermOutstanding ?? 0,
        lifetimeCharges: lifetime.totalCharges ?? 0,
        lifetimePaid: lifetime.totalPaid ?? 0,
        lifetimeCredit: lifetime.totalCredit ?? 0,
        lifetimeOutstanding: lifetime.outstanding ?? 0,
        creditBalance: lifetime.creditBalance ?? 0,
        totalCharges: term.currentTermCharges ?? 0,
        totalPaid: term.currentTermPaid ?? 0,
        outstanding: term.currentTermOutstanding ?? 0,
      };
    });
    res.json(recomputeOverdue(payload, activeTerm?.startDate));
  } catch (e) { return apiError(res, e, "get students"); }
});

app.get("/api/students/unpaid", requireAuth, requirePermission("students.view"), async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId, deletedAt: null } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const balances = await deriveStudentCurrentTermReceivedBalancesBatch(students.map(s => s.id), activeTerm);
    const updated = recomputeOverdue(students.map(s => {
      const b = balances.get(s.id) || {};
      return { ...s, totalCharges: b.currentTermCharges ?? 0, totalPaid: b.currentTermPaid ?? 0, currentTermBalance: b.currentTermBalance ?? b.currentTermOutstanding ?? 0, outstanding: b.currentTermOutstanding ?? 0 };
    }), activeTerm?.startDate);
    res.json(
      updated.filter(s => s.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, 5)
        .map((s, i) => ({
          rank: i + 1, name: s.name, cls: s.cls,
          bal: "KES " + s.outstanding.toLocaleString(),
          days: s.daysOverdue > 0 ? s.daysOverdue + " days overdue" : "Pending",
        }))
    );
  } catch (e) { return apiError(res, e, "get unpaid students"); }
});

app.get("/api/admin/student-charges", requireAuth, requirePermission("reports.view"), async (req, res) => {
  try {
    const { studentId } = req.query;
    const rows = await prisma.studentCharge.findMany({
      where: {
        userId: req.userId,
        ...(studentId ? { studentId: String(studentId) } : {}),
      },
      orderBy: [{ studentId: "asc" }, { createdAt: "asc" }],
    });
    const students = await prisma.student.findMany({
      where: { userId: req.userId, id: { in: [...new Set(rows.map(r => r.studentId))] } },
      select: { id: true, name: true, adm: true, cls: true },
    });
    const studentMap = Object.fromEntries(students.map(s => [s.id, s]));
    res.json(rows.map(c => ({
      studentName: studentMap[c.studentId]?.name || "Unknown",
      adm: studentMap[c.studentId]?.adm || "",
      className: studentMap[c.studentId]?.cls || "",
      studentId: c.studentId,
      chargeId: c.id,
      termId: c.termId,
      invoiceId: c.invoiceId,
      type: c.type,
      description: c.description,
      amount: c.amount,
      createdAt: c.createdAt,
      voidedAt: c.voidedAt,
    })));
  } catch (e) { return apiError(res, e, "audit student charges"); }
});

app.get("/api/students/:id/payments", requireAuth, requirePermission("students.view"), async (req, res) => {
  try {
    const student = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const [payments, terms, charges, ledgerBalance, activeTerm] = await Promise.all([
      prisma.payment.findMany({ where: { studentId: req.params.id, deletedAt: null }, orderBy: { createdAt: "desc" } }),
      prisma.term.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }),
      prisma.studentCharge.findMany({ where: { studentId: req.params.id, voidedAt: null } }),
      deriveStudentBalance(req.params.id),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const chargeIds = charges.map(c => c.id);
    const allocations = chargeIds.length
      ? await prisma.paymentAllocation.findMany({
          where: {
            studentChargeId: { in: chargeIds },
            payment: { reversedAt: null, isReversal: false, deletedAt: null },
          },
          include: { payment: true },
        })
      : [];

    // Group charges by termId for fast lookup
    const chargesByTerm = {};
    let legacyCharges = 0;
    for (const c of charges) {
      const key = c.termId || "_legacy";
      chargesByTerm[key] = (chargesByTerm[key] || 0) + c.amount;
      if (!c.termId) legacyCharges += c.amount;
    }
    const totalLedgerCharges = charges.reduce((s, c) => s + c.amount, 0);

    // DERIVED balance: sum ALL valid payments (not term-scoped — payments apply globally)
    const totalValidPaid = payments
      .filter(p => !p.reversedAt && !p.isReversal)
      .reduce((s, p) => s + p.amount, 0);

    const chargeTermById = Object.fromEntries(charges.map(c => [c.id, c.termId || "_legacy"]));
    const allocatedByCharge = {};
    const allocatedByTerm = {};
    const paymentsByReceivedTerm = {};
    for (const p of payments.filter(p => !p.reversedAt && !p.isReversal)) {
      const termKey = paymentTermKey(p, terms);
      if (!paymentsByReceivedTerm[termKey]) paymentsByReceivedTerm[termKey] = [];
      paymentsByReceivedTerm[termKey].push({
        id: p.id, amount: Number(p.amount || 0), method: p.method || "manual",
        txnRef: p.txnRef || null, feeBreakdown: p.feeBreakdown || [],
        createdAt: p.createdAt, receivedAt: p.receivedAt || p.createdAt, reversedAt: p.reversedAt || null,
        isReversal: p.isReversal,
        time: new Date(p.receivedAt || p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      });
    }
    for (const allocation of allocations) {
      allocatedByCharge[allocation.studentChargeId] = (allocatedByCharge[allocation.studentChargeId] || 0) + Number(allocation.amount || 0);
      const termKey = chargeTermById[allocation.studentChargeId];
      if (!termKey || termKey === "_legacy") continue;
      allocatedByTerm[termKey] = (allocatedByTerm[termKey] || 0) + Number(allocation.amount || 0);
    }

    const termSummaries = terms.map(term => {
      const termCharges = chargesByTerm[term.id] || 0;
      const termAllocated = Math.min(termCharges, allocatedByTerm[term.id] || 0);
      const termPaid = (paymentsByReceivedTerm[term.id] || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const effectiveFee = termCharges;
      const termPayments = (paymentsByReceivedTerm[term.id] || []).sort((a, b) => new Date(b.receivedAt || b.createdAt) - new Date(a.receivedAt || a.createdAt));

      return {
        termId: term.id, termName: term.name, status: term.status,
        startDate: term.startDate, endDate: term.endDate,
        totalCharges: effectiveFee,
        totalPaid: termPaid,
        allocatedToCharges: termAllocated,
        outstanding: Math.max(0, effectiveFee - termAllocated),
        cleared: effectiveFee > 0 && Math.max(0, effectiveFee - termAllocated) <= 0,
        charges: chargesByTerm[term.id]
          ? charges.filter(c => c.termId === term.id).map(c => ({
              id: c.id, type: c.type, description: c.description, amount: c.amount, createdAt: c.createdAt,
              allocatedAmount: allocatedByCharge[c.id] || 0,
              canVoid: Number(allocatedByCharge[c.id] || 0) <= 0,
            }))
          : [],
        payments: termPayments,
      };
    }).filter(t => t.payments.length > 0 || t.charges.length > 0 || t.status === "active");

    const currentTermSummary = activeTerm
      ? termSummaries.find(t => t.termId === activeTerm.id) || {
          termId: activeTerm.id,
          termName: activeTerm.name,
          status: activeTerm.status,
          startDate: activeTerm.startDate,
          endDate: activeTerm.endDate,
          totalCharges: 0,
          totalPaid: 0,
          outstanding: 0,
          cleared: false,
          charges: [],
          payments: [],
        }
      : null;
    const currentTermCharges = safeNumber(currentTermSummary?.totalCharges);
    const currentTermPaid = safeNumber(currentTermSummary?.totalPaid);
    // Keep the profile's current-term widget separate from lifetime/FIFO
    // allocation accounting: term balance is charges minus payments this term.
    const currentTermBalance = currentTermCharges - currentTermPaid;
    const currentTermDaysOverdue = currentTermBalance > 0 && activeTerm?.startDate
      ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / (1000 * 60 * 60 * 24)))
      : 0;

    res.json({
      student: {
        id: student.id, name: student.name, adm: student.adm, cls: student.cls,
        bankPaymentReference: studentBankPaymentReference(student),
        parentEmail: student.parentEmail || null, parentName: student.parentName || null,
        parentPhone: student.parentPhone || null,
        // Ledger-derived — never from student.fee/paid fields directly
        currentTermName: currentTermSummary?.termName || null,
        currentTermCharges,
        currentTermPaid,
        currentTermBalance,
        currentTermOutstanding: currentTermBalance,
        totalCharges: ledgerBalance.totalCharges,
        totalPaid:    ledgerBalance.totalPaid,
        totalCredit:  ledgerBalance.totalCredit,
        creditBalance: ledgerBalance.creditBalance,
        outstanding: ledgerBalance.outstanding,
        daysOverdue: currentTermDaysOverdue,
        ledgerSource: "ledger",
      },
      termSummaries,
      hasUnpaidPastTerm: termSummaries.some(t => t.status === "closed" && !t.cleared && t.outstanding > 0),
      allTermsCleared:   termSummaries.length > 0 && termSummaries.every(t => t.cleared),
    });
  } catch (e) { return apiError(res, e, "get student payments", req); }
});

function generateAdm(schoolName, studentName, totalCount) {
  const schoolInitials = (schoolName || "FF").split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 3).map(w => w[0].toUpperCase()).join("");
  const nameInitials   = (studentName || "ST").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const seq = String(totalCount + 1).padStart(3, "0");
  return (schoolInitials || "FF") + "-" + (nameInitials || "ST") + "-" + seq;
}

function normalizeStudentFeeRows(rows) {
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows)) throw Object.assign(new Error("feeBreakdown must be an array."), { statusCode: 400 });
  return rows.map((row, index) => {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw Object.assign(new Error(`Fee row ${index + 1} must have a positive amount.`), { statusCode: 400 });
    }
    const type = canonicalChargeType(row.type || row.typeId || row.typeName || "other");
    const description = String(row.description || row.typeName || row.name || row.type || "Fee").trim() || "Fee";
    return {
      id: row.id ? String(row.id) : null,
      type,
      typeName: row.typeName || description,
      description,
      amount,
    };
  });
}

async function studentWithLedgerPayload(studentId, tx = prisma) {
  const [student, activeTerm, lifetime] = await Promise.all([
    tx.student.findUnique({ where: { id: studentId } }),
    tx.term.findFirst({ where: { userId: (await tx.student.findUnique({ where: { id: studentId }, select: { userId: true } }))?.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    deriveStudentBalance(studentId, null, tx),
  ]);
  const termMap = activeTerm ? await deriveStudentCurrentTermReceivedBalancesBatch([studentId], activeTerm, tx) : new Map();
  const term = termMap.get(studentId) || { currentTermCharges: 0, currentTermPaid: 0, currentTermOutstanding: 0 };
  return {
    ...student,
    ...lifetime,
    totalCharges: lifetime.totalCharges,
    totalPaid: lifetime.totalPaid,
    outstanding: lifetime.outstanding,
    lifetimeCharges: lifetime.totalCharges,
    lifetimePaid: lifetime.totalPaid,
    lifetimeOutstanding: lifetime.outstanding,
    currentTermCharges: term.currentTermCharges || 0,
    currentTermPaid: term.currentTermPaid || 0,
    currentTermBalance: term.currentTermBalance || 0,
    currentTermOutstanding: term.currentTermOutstanding || 0,
    creditBalance: lifetime.creditBalance || 0,
  };
}

app.post("/api/students", requireAuth, requirePermission("students.create"), async (req, res) => {
  const { name, cls, fee, paid, parentEmail, parentName, parentPhone, feeBreakdown } = req.body;
  if (!name)        return res.status(400).json({ message: "Student name is required" });
  if (!parentPhone) return res.status(400).json({ message: "Parent phone is required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });

    // BLOCK: no students without an active term
    const activeTerm = await prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } });
    if (!activeTerm) return res.status(403).json({
      message: "You must create an active term before adding students. Go to Dashboard → New Term to get started.",
      code: "NO_ACTIVE_TERM",
    });

    const parsedFee = classFeeForTerm(activeTerm, cls);
    const parsed = createStudentSchema.safeParse({ name, fee: parsedFee, parentPhone });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });

    // DUPLICATE: block same name + same parent phone combination
    const duplicate = await prisma.student.findFirst({
      where: { userId: req.userId, deletedAt: null, parentPhone: parentPhone.trim(), name: { equals: name.trim(), mode: "insensitive" } },
    });
    if (duplicate) return res.status(409).json({
      message: `A student named "${duplicate.name}" with this parent phone already exists (Adm: ${duplicate.adm}). Please check for duplicates before adding.`,
      code: "DUPLICATE_STUDENT",
      existing: { id: duplicate.id, name: duplicate.name, adm: duplicate.adm, cls: duplicate.cls },
    });

    const count = await prisma.student.count({ where: { userId: req.userId, deletedAt: null } });
    const limit = PLAN_LIMITS[user?.plan || "free"].students;
    if (count >= limit) return res.status(403).json({ message: "Student limit reached (" + limit + "). Upgrade to add more.", upgradeRequired: true });

    let adm = generateAdm(user?.schoolName, name, count);
    const admExists = await prisma.student.findFirst({ where: { userId: req.userId, adm } });
    if (admExists) adm = generateAdm(user?.schoolName, name, count + Math.floor(Math.random() * 50) + 1);

    const parsedPaid  = parseFloat(paid) || 0;
    const daysOverdue = (parsedPaid < parsedFee && activeTerm)
      ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / (1000 * 60 * 60 * 24))) : 0;

    let missingClassFeeWarning = false;
    const student = await prisma.$transaction(async (tx) => {
      const st = await tx.student.create({
        data: { name, adm: adm?.trim() || "", cls: cls || "", fee: parsedFee, paid: parsedPaid, parentEmail: parentEmail || null, parentName: parentName || null, parentPhone: parentPhone || null, daysOverdue, userId: req.userId },
      });
      const charge = await createActiveTermChargeForStudent(tx, { userId: req.userId, studentId: st.id, term: activeTerm, cls: st.cls, amount: parsedFee });
      missingClassFeeWarning = !charge;
      if (parsedPaid > 0) {
        const p = await tx.payment.create({ data: { amount: parsedPaid, method: "manual", txnRef: null, feeBreakdown: feeBreakdown || [], termId: activeTerm.id, paymentTermId: activeTerm.id, receivedAt: new Date(), studentId: st.id, userId: req.userId } });
        await allocatePaymentFIFO(p.id, tx);
        await handleOverpayment({ studentId: st.id, userId: req.userId, termId: activeTerm.id, paymentId: p.id, totalCharges: parsedFee, totalPaid: parsedPaid }, tx);
      }
      return st;
    });
    const [balance, termBalanceMap] = await Promise.all([
      deriveStudentBalance(student.id),
      deriveStudentCurrentTermReceivedBalancesBatch([student.id], activeTerm),
    ]);
    logAudit(req, { action: "student_created", entityType: "student", entityId: student.id, metadata: { name: student.name, adm: student.adm, cls: student.cls } });
    const termBalance = termBalanceMap.get(student.id) || { currentTermCharges: 0, currentTermPaid: 0, currentTermOutstanding: 0 };
    res.status(201).json({
      ...student,
      ...balance,
      currentTermCharges: termBalance.currentTermCharges || 0,
      currentTermPaid: termBalance.currentTermPaid || 0,
      currentTermBalance: termBalance.currentTermBalance || 0,
      currentTermOutstanding: termBalance.currentTermOutstanding || 0,
      lifetimeCharges: balance.totalCharges || 0,
      lifetimePaid: balance.totalPaid || 0,
      lifetimeOutstanding: balance.outstanding || 0,
      totalCharges: termBalance.currentTermCharges || 0,
      totalPaid: termBalance.currentTermPaid || 0,
      outstanding: termBalance.currentTermOutstanding || 0,
      ...(missingClassFeeWarning ? { warning: "No active term fee is set for this student's class, so no term charge was created." } : {}),
    });
  } catch (e) {
    if (e.code === "P2002") return res.status(400).json({ message: "Admission number conflict — please try again" });
    return apiError(res, e, "create student");
  }
});

// ─── BULK IMPORT — 3 queries total, no loops, handles 500 students in <1s ─────
app.post("/api/students/import", requireAuth, requirePermission("students.create"), async (req, res) => {
  const { students: incoming } = req.body;
  if (!Array.isArray(incoming) || incoming.length === 0)
    return res.status(400).json({ message: "No students provided." });
  if (incoming.length > 500)
    return res.status(400).json({ message: "Maximum 500 students per import." });

  try {
    const [user, existingCount, activeTerm] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId } }),
      prisma.student.count({ where: { userId: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);

    const limit = PLAN_LIMITS[user?.plan || "free"].students;
    if (existingCount >= limit)
      return res.status(403).json({ message: "Student limit reached (" + limit + "). Upgrade to add more.", upgradeRequired: true });

    const slotsLeft        = limit - existingCount;
    const toImport         = incoming.slice(0, slotsLeft);
    const skippedPlanLimit = incoming.length - toImport.length;

    const errors  = [];
    const warnings = [];
    const records = [];
    const usedAdm = new Set();

    for (let i = 0; i < toImport.length; i++) {
      const sourceRow = toImport[i];
      if (!sourceRow.name?.trim())        { errors.push({ row: i + 2, reason: "Missing name" });        continue; }
      if (!sourceRow.parentPhone?.trim()) { errors.push({ row: i + 2, reason: "Missing parent phone" }); continue; }

      const rowClass = sourceRow.cls?.trim() || "";
      const parsedFee  = classFeeForTerm(activeTerm, rowClass);
      if (parsedFee <= 0) warnings.push({ row: i + 2, reason: "No active term fee is set for this student's class, so no term charge will be created." });
      const parsedPaid = Math.max(0, Math.min(parseFloat(sourceRow.paid) || 0, parsedFee));
      const daysOverdue = (parsedPaid < parsedFee && activeTerm)
        ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / 86400000))
        : 0;

      // Use sequential number only for bulk import adm — avoids initials collisions
      // e.g. FF-001, FF-002 ... FF-500. Clean, unique, guaranteed.
      const seq = String(existingCount + records.length + 1).padStart(4, "0");
      const schoolInitials = (user?.schoolName || "FF").split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 3).map(w => w[0].toUpperCase()).join("") || "FF";
      const adm = schoolInitials + "-" + seq;
      usedAdm.add(adm);

      records.push({
        name:        sourceRow.name.trim(),
        adm:         adm?.trim() || "",
        cls:         rowClass,
        fee:         parsedFee,
        paid:        parsedPaid,
        parentPhone: sourceRow.parentPhone?.trim() || null,
        parentName:  sourceRow.parentName?.trim()  || null,
        parentEmail: sourceRow.parentEmail?.trim() || null,
        daysOverdue,
        userId:      req.userId,
      });
    }

    if (records.length === 0)
      return res.status(400).json({ message: "No valid students to import.", errors });

    // ── QUERY 1: insert all students in one shot ──────────────────────────────
    const importedAt = new Date();
    await prisma.student.createMany({ data: records, skipDuplicates: true });

    // ── QUERY 2: fetch back only the students we just created ─────────────────
    // Use userId + createdAt >= importedAt + adm in our known set.
    // This is precise: we know the adm values we generated, so match on those.
    const admSet = records.map(r => r.adm).filter(Boolean);
    const created = await prisma.student.findMany({
      where: { userId: req.userId, adm: { in: admSet } },
      select: { id: true, fee: true, paid: true, adm: true, cls: true },
    });
    if (activeTerm && created.some(({ fee }) => fee > 0)) {
      await prisma.$transaction(async (tx) => {
        for (const { id, fee, cls } of created.filter(({ fee }) => fee > 0)) {
          await createActiveTermChargeForStudent(tx, { userId: req.userId, studentId: id, term: activeTerm, cls, amount: fee });
        }
      });
    }

    // ── QUERY 3: insert all opening-balance payments in one shot ──────────────
    const paymentRecords = created
      .filter(({ paid }) => paid > 0)
      .map(({ id, paid }) => ({
        amount:      paid,
        method:      "manual",
        txnRef:      null,
        feeBreakdown: [],
        studentId:   id,
        userId:      req.userId,
        termId:      activeTerm?.id || null,
        paymentTermId: activeTerm?.id || null,
        receivedAt:  importedAt,
      }));
    if (paymentRecords.length > 0) {
      await prisma.payment.createMany({ data: paymentRecords });
      const createdPayments = await prisma.payment.findMany({
        where: { userId: req.userId, studentId: { in: created.map(st => st.id) }, createdAt: { gte: importedAt } },
        select: { id: true },
      });
      for (const p of createdPayments) await prisma.$transaction(tx => allocatePaymentFIFO(p.id, tx));
    }

    res.json({
      imported: records.length,
      skipped:  errors.length + skippedPlanLimit,
      errors,
      warnings,
      ...(skippedPlanLimit > 0 && { message: skippedPlanLimit + " students not imported — plan limit reached." }),
    });
  } catch (e) {
    console.error("bulk import:", e);
    res.status(500).json({ message: "Import failed: " + e.message });
  }
});


app.patch("/api/students/:id", requireAuth, requirePermission("students.edit"), async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    const { name, cls, parentEmail, parentName, parentPhone, fee, paid, termId } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ message: "Student name is required." });
    if (parentPhone !== undefined && !String(parentPhone).trim()) return res.status(400).json({ message: "Parent phone is required." });
    const feeRows = normalizeStudentFeeRows(req.body.feeBreakdown);
    const activeTerm = await prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } });
    const before = await deriveStudentBalance(s.id);
    const requestedPaid = paid !== undefined ? parseFloat(paid) : undefined;
    if (requestedPaid !== undefined && requestedPaid < before.totalPaid) {
      return res.status(400).json({ message: "Payments are immutable. Reverse a payment instead of lowering paid totals." });
    }

    await prisma.$transaction(async (tx) => {
      const st = await tx.student.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined        && { name: String(name).trim() }),
          ...(cls !== undefined         && { cls }),
          ...(parentEmail !== undefined && { parentEmail }),
          ...(parentName !== undefined  && { parentName }),
          ...(parentPhone !== undefined && { parentPhone }),
          ...(termId !== undefined      && { termId }),
        },
      });

      if (feeRows !== undefined) {
        const editTermId = activeTerm?.id || null;
        const activeCharges = await tx.studentCharge.findMany({
          where: { studentId: s.id, userId: req.userId, termId: editTermId, voidedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        const chargeIds = activeCharges.map(c => c.id);
        const allocations = chargeIds.length
          ? await tx.paymentAllocation.findMany({
              where: {
                studentChargeId: { in: chargeIds },
                payment: { reversedAt: null, isReversal: false, deletedAt: null },
              },
            })
          : [];
        const allocatedByCharge = allocations.reduce((acc, a) => {
          acc[a.studentChargeId] = (acc[a.studentChargeId] || 0) + Number(a.amount || 0);
          return acc;
        }, {});
        const byId = new Map(activeCharges.map(c => [c.id, c]));
        const usedChargeIds = new Set();

        for (const row of feeRows) {
          let charge = row.id ? byId.get(row.id) : null;
          if (!charge) {
            charge = activeCharges.find(c =>
              !usedChargeIds.has(c.id) &&
              c.type === row.type &&
              c.description.toLowerCase() === row.description.toLowerCase()
            );
          }

          if (charge) {
            // Accounting-sensitive: update existing charge rows rather than
            // replacing them so allocations remain attached and auditable.
            await tx.studentCharge.update({
              where: { id: charge.id },
              data: { type: row.type, description: row.description, amount: row.amount },
            });
            usedChargeIds.add(charge.id);
          } else {
            const created = await createStudentChargeSafe(tx, {
              studentId: s.id,
              userId: req.userId,
              termId: editTermId,
              type: row.type,
              description: row.description,
              amount: row.amount,
            });
            if (created?.id) usedChargeIds.add(created.id);
          }
        }

        for (const charge of activeCharges) {
          if (usedChargeIds.has(charge.id)) continue;
          if (Number(allocatedByCharge[charge.id] || 0) > 0) {
            throw Object.assign(new Error(`Cannot remove "${charge.description}" because payments are already allocated to it.`), { statusCode: 400 });
          }
          await tx.studentCharge.update({
            where: { id: charge.id },
            data: { voidedAt: new Date(), voidedBy: req.userId, voidReason: "Student fee breakdown edit" },
          });
        }
      } else if (fee !== undefined) {
        const requestedFee = parseFloat(fee);
        const delta = requestedFee - before.totalCharges;
        if (Number.isFinite(delta) && delta > 0) {
          await createStudentChargeSafe(tx, { studentId: s.id, userId: req.userId, termId: activeTerm?.id || null, type: "adjustment", description: "Fee adjustment", amount: delta });
        }
      }
      if (requestedPaid !== undefined && requestedPaid > before.totalPaid) {
        const amount = requestedPaid - before.totalPaid;
        const p = await tx.payment.create({ data: { amount, method: "manual", txnRef: null, feeBreakdown: [], termId: activeTerm?.id || null, paymentTermId: activeTerm?.id || null, receivedAt: new Date(), studentId: s.id, userId: req.userId } });
        await allocatePaymentFIFO(p.id, tx);
      }
      return st;
    });
    const updated = await studentWithLedgerPayload(s.id);
    logAudit(req, { action: "student_updated", entityType: "student", entityId: s.id });
    res.json(updated);
  } catch (e) {
    if (e?.statusCode) return res.status(e.statusCode).json({ message: e.message });
    return apiError(res, e, "update student");
  }
});

app.delete("/api/students/:id", requireAuth, requirePermission("students.delete"), async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    // BUG FIX: also delete related invoices and receipts so we don't leave
    // orphaned records that could break receipt/invoice lookups.
    await prisma.student.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    logAudit(req, { action: "student_deleted", entityType: "student", entityId: s.id, metadata: { name: s.name, adm: s.adm } });
    res.json({ message: "Deleted" });
  } catch (e) { return apiError(res, e, "delete student"); }
});

// ─── STATS ────────────────────────────────────────────────────────────────────
// ─── STATS (dashboard) ────────────────────────────────────────────────────────
// WHY: The old route summed student.fee and student.paid — both mutable fields
// that drift over time. Adding a transport fee mid-term changes student.fee but
// doesn't restate all prior calculations, causing the dashboard to show wrong
// totals. Now all figures are derived from the immutable ledger.
app.get("/api/stats", requireAuth, requirePermission("reports.view"), async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId, deletedAt: null } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);

    const studentIds = students.map(s => s.id);

    // Derive all balances in ONE batch query — never from student.fee/paid fields
    const balances = await deriveStudentCurrentTermReceivedBalancesBatch(studentIds, activeTerm);

    // Rebuild recomputeOverdue using ledger-derived outstanding, not fee-paid
    const enriched = students.map(s => {
      const b = balances.get(s.id) || { currentTermCharges: 0, currentTermPaid: 0, currentTermOutstanding: 0 };
      const totalCharges = Number(b.currentTermCharges || 0);
      const totalPaid = Number(b.currentTermPaid || 0);
      const outstanding = Number(b.currentTermOutstanding || 0);
      const daysOverdue = outstanding > 0 && activeTerm
        ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / 86400000))
        : 0;
      return { ...s, totalCharges, totalPaid, outstanding, currentTermCharges: totalCharges, currentTermPaid: totalPaid, currentTermBalance: outstanding, currentTermOutstanding: outstanding, daysOverdue };
    });

    // Aggregate from ledger-derived values — mathematically consistent with
    // what individual student views show, guaranteed to match reports.
    const totalCharges   = enriched.reduce((s, st) => s + (st.totalCharges || 0), 0);
    const totalCollected = enriched.reduce((s, st) => s + (st.totalPaid || 0), 0);
    const totalArrears   = enriched.reduce((s, st) => s + Math.max(0, st.outstanding || 0), 0);
    const fullyPaid      = enriched.filter(s => s.totalCharges > 0 && s.outstanding <= 0).length;
    const partial        = enriched.filter(s => s.totalPaid > 0 && s.outstanding > 0).length;
    const unpaid         = enriched.filter(s => s.totalPaid === 0 && s.totalCharges > 0).length;
    const noCharges      = enriched.filter(s => s.totalCharges === 0).length;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayPayments = await prisma.payment.findMany({
      where: { userId: req.userId, receivedAt: { gte: today }, reversedAt: null, isReversal: false, deletedAt: null },
      include: { student: true },
    });
    const collectedToday = todayPayments.reduce((s, p) => s + p.amount, 0);

    const recentRaw = await prisma.payment.findMany({
      where: { userId: req.userId, reversedAt: null, isReversal: false, deletedAt: null },
      orderBy: { receivedAt: "desc" }, take: 10, include: { student: true },
    });
    const recentPayments = recentRaw.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (p.student?.cls || "") + " · " + (p.student?.adm || ""),
      txn: p.txnRef || "—", method: p.method || "manual",
      amount: "KES " + Number(p.amount).toLocaleString(),
      time: new Date(p.receivedAt || p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    }));

    const topUnpaid = enriched
      .filter(s => s.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 5)
      .map((s, i) => ({
        rank: i + 1, name: s.name, cls: s.cls,
        bal: "KES " + s.outstanding.toLocaleString(),
        days: s.daysOverdue > 0 ? s.daysOverdue + "d overdue" : "Pending",
      }));

    const collectedPct = totalCharges > 0 ? Math.min(100, Math.round((totalCollected / totalCharges) * 100)) : 0;
    const arrearsPct   = totalCharges > 0 ? Math.round((totalArrears   / totalCharges) * 100) : 0;
    const paidPct      = enriched.length > 0 ? Math.round((fullyPaid / enriched.length) * 100) : 0;
    const problemPct   = enriched.length > 0 ? Math.round(((partial + unpaid) / enriched.length) * 100) : 0;

    res.json({
      totalCollected, totalArrears, collectedToday, paymentsToday: todayPayments.length,
      totalStudents: enriched.length, fullyPaid, partial, unpaid, noCharges, recentPayments, topUnpaid,
      // Expose ledger totals for accounting reports
      totalCharges,
      items: [
        { label: "Collected this term", value: "KES " + safeNumber(totalCollected).toLocaleString(), sub: "Payments received in " + (activeTerm?.name || "current period"), progress: collectedPct, badge: collectedPct + "% collected", badgeBg: "var(--green-bg)", badgeColor: "var(--green)", iconBg: "var(--green-bg)", iconBorder: "var(--green-border)", iconColor: "var(--green)", iconPath: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", valueColor: null, progressClass: "" },
        { label: "Outstanding this term", value: "KES " + safeNumber(totalArrears).toLocaleString(), sub: (unpaid + partial) + " students with active-term balances", progress: arrearsPct, badge: (unpaid + partial) + " students", badgeBg: "var(--red-bg)", badgeColor: "var(--red)", iconBg: "var(--red-bg)", iconBorder: "var(--red-border)", iconColor: "var(--red)", iconPath: "M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z", valueColor: "var(--red)", progressClass: "bad" },
        { label: "Fully paid this term", value: fullyPaid, sub: "Out of " + enriched.length + " students (" + paidPct + "%)", progress: paidPct, badge: null, badgeBg: null, badgeColor: null, iconBg: "var(--green-bg)", iconBorder: "var(--green-border)", iconColor: "var(--green)", iconPath: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", valueColor: null, progressClass: "" },
        { label: "Unpaid / Partial this term", value: unpaid + partial, sub: partial + " partial, " + unpaid + " not started, " + noCharges + " no charges", progress: problemPct, badge: (unpaid + partial) + " students", badgeBg: "var(--red-bg)", badgeColor: "var(--red)", iconBg: "var(--red-bg)", iconBorder: "var(--red-border)", iconColor: "var(--red)", iconPath: "M10 9H6M10 13H6m10 4H6M20 6H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2z", valueColor: "var(--red)", progressClass: "warn" },
      ],
    });
  } catch (e) { return apiError(res, e, "get stats", req); }
});

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────
app.get("/api/payments/recent", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({ where: { userId: req.userId, deletedAt: null }, orderBy: { receivedAt: "desc" }, take: 30, include: { student: true } });
    res.json(payments.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (p.student?.cls || "") + " · " + (p.student?.adm || ""),
      txn: p.txnRef || "—", amount: "KES " + Number(p.amount).toLocaleString(), method: p.method,
      rawAmount: p.amount,
      time: new Date(p.receivedAt || p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    })));
  } catch (e) { return apiError(res, e, "get recent payments"); }
});

app.get("/api/payments", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const take = Math.min(Number(req.query.limit || 50), 200);
    const cursor = req.query.cursor ? { id: req.query.cursor } : undefined;
    const payments = await prisma.payment.findMany({
      where: { userId: req.userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take,
      ...(cursor ? { cursor, skip: 1 } : {}),
      include: { student: true },
    });
    const payload = payments.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (p.student?.cls || "") + " · " + (p.student?.adm || ""),
      txn: p.txnRef || "—", amount: "KES " + Number(p.amount).toLocaleString(),
      method: p.method || "manual", feeBreakdown: p.feeBreakdown || [], rawAmount: p.amount,
      time: new Date(p.receivedAt || p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      createdAt: p.createdAt, receivedAt: p.receivedAt || p.createdAt, studentId: p.studentId,
    }));
    res.setHeader("X-Total-Count", payload.length.toString());
    if (payload.length === take) res.setHeader("X-Next-Cursor", payload[payload.length - 1].id);
    res.json(payload);
  } catch (e) { return apiError(res, e, "get all payments"); }
});

app.get("/api/payments/report/pdf", requireAuth, requireAnyPermission(["payments.view", "reports.view"]), pdfLimiter, async (req, res) => {
  const parsed = paymentReportQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  try {
    const q = parsed.data;
    const where = { userId: req.userId };
    if (q.startDate || q.endDate) {
      where.receivedAt = {};
      if (q.startDate) {
        const start = new Date(q.startDate);
        if (Number.isNaN(start.getTime())) return res.status(400).json({ message: "Invalid startDate." });
        where.receivedAt.gte = start;
      }
      if (q.endDate) {
        const end = new Date(q.endDate);
        if (Number.isNaN(end.getTime())) return res.status(400).json({ message: "Invalid endDate." });
        end.setHours(23, 59, 59, 999);
        where.receivedAt.lte = end;
      }
    }
    if (q.studentId) where.studentId = q.studentId;
    if (q.method !== "all") where.method = q.method === "manual" ? { in: ["manual", "cash"] } : q.method;
    if (q.status === "valid") Object.assign(where, { reversedAt: null, deletedAt: null, isReversal: false });
    if (q.status === "reversed") where.OR = [{ reversedAt: { not: null } }, { isReversal: true }];
    if (q.status === "deleted") where.deletedAt = { not: null };

    const studentWhere = { deletedAt: null, userId: req.userId };
    if (q.className) studentWhere.cls = q.className;
    const payments = await prisma.payment.findMany({
      where: { ...where, student: { is: studentWhere } },
      orderBy: { receivedAt: "desc" },
      include: { student: { select: { id: true, name: true, adm: true, cls: true, parentName: true, parentPhone: true } } },
    });
    const [user, selectedStudent] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId }, select: { schoolName: true, ...USER_BRANDING_SELECT } }),
      q.studentId ? prisma.student.findFirst({ where: { id: q.studentId, userId: req.userId }, select: { name: true } }) : null,
    ]);
    const validPayments = payments.filter(p => !p.deletedAt && !p.reversedAt && !p.isReversal);
    const reversedDeleted = payments.filter(p => p.deletedAt || p.reversedAt || p.isReversal);
    const sum = list => list.reduce((total, p) => total + Math.abs(Number(p.amount || 0)), 0);
    const manualMethods = new Set(["manual", "cash"]);
    const summary = {
      count: payments.length,
      totalAmount: sum(validPayments),
      mpesaTotal: sum(validPayments.filter(p => p.method === "mpesa")),
      manualTotal: sum(validPayments.filter(p => manualMethods.has(p.method || "manual"))),
      reversedDeletedTotal: sum(reversedDeleted),
    };
    const schoolLogoDataUri = await getLogoDataUri(user);
    const html = renderPaymentsReportPdfHtml({
      user: { ...user, schoolLogoDataUri, schoolLogoUrl: null },
      payments,
      summary,
      filters: { ...q, studentName: selectedStudent?.name || "" },
    });
    const pdf = await generatePdfFromHtml(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"Payments-Report.pdf\"");
    res.send(pdf);
  } catch (e) { return apiError(res, e, "payments report pdf", req); }
});

app.post("/api/payments", requireAuth, requirePermission("payments.create"), async (req, res) => {
  const { studentId, amount, txnRef, method, feeBreakdown, confirmOverpayment } = req.body;
  if (!studentId || !amount) return res.status(400).json({ message: "studentId and amount required" });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ message: "Amount must be a positive number" });

  // Duplicate txnRef protection — scoped per school (unique_txnref_per_school constraint)
  if (txnRef) {
    const existing = await prisma.payment.findFirst({ where: { txnRef, userId: req.userId } });
    if (existing) return res.status(409).json({ message: "This transaction reference has already been recorded." });
  }

  try {
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    // CASHIER CONFLICT DETECTION (optimistic locking)
    if (req.body.clientVersion !== undefined && req.body.clientVersion !== student.version) {
      return res.status(409).json({
        message: "Another payment was recorded for this student while you were working. Please refresh the student's record and try again.",
        conflict: true, currentVersion: student.version,
      });
    }

    // Derive pre-payment balance from ledger — not from student.fee/paid
    const preLb   = await deriveStudentBalance(studentId);
    const outstandingBefore = Number(preLb.outstanding || 0);
    const excess   = Math.max(0, parsedAmount - outstandingBefore);
    if (excess > 0 && confirmOverpayment !== true) {
      return res.json({
        requiresConfirmation: true,
        overpayAmount: excess,
        outstanding: outstandingBefore,
        enteredAmount: parsedAmount,
        message: "This payment exceeds the student balance by KES " + fmtKE(excess) + ". Proceed and store extra as credit?",
      });
    }
    const newPaid  = preLb.totalPaid + parsedAmount;
    const daysOverdue = parsedAmount >= outstandingBefore ? 0 : student.daysOverdue;
    const activeTerm  = await activePaymentTerm(req.userId);

    // ATOMIC: payment + balance + ledger + student version bump — all or nothing
    const { payment } = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          amount: parsedAmount,
          txnRef: txnRef || null,
          method: method || "cash",
          termId: activeTerm?.id || null,
          paymentTermId: activeTerm?.id || null,
          receivedAt: new Date(),
          feeBreakdown: feeBreakdown || [],
          studentId, userId: req.userId,
          overpaymentAmount: excess,
          version: 1,
        },
        include: { student: true },
      });
      await tx.student.update({
        where: { id: studentId },
        data: { daysOverdue, version: { increment: 1 } },
      });
      await allocatePaymentFIFO(p.id, tx, outstandingBefore);
      // Append-only ledger entry — uses ledger-derived balanceBefore, not student.paid
      await tx.balanceLedger.create({
        data: {
          studentId, userId: req.userId,
          paymentId: p.id,
          delta:         parsedAmount,
          balanceBefore: preLb.totalPaid,        // from ledger, not student.paid
          balanceAfter:  newPaid,
          source: "payment",
          note: method || "cash",
        },
      });
      if (excess > 0) {
        await tx.creditMemo.create({
          data: {
            studentId, userId: req.userId,
            termId: activeTerm?.id || null,
            sourcePaymentId: p.id,
            amount: excess, remainingAmount: excess,
            status: "available",
            note: "Auto-generated from overpayment (manual payment)",
          },
        });
      }
      return { payment: p };
    });

    // Overpayment audit
    if (excess > 0) {
      logger.warn("payment", "Overpayment → CreditMemo created", {
        studentId, excess,
        ledgerCharges: preLb.totalCharges,
        newTotalPaid: newPaid,
        userId: req.userId, reqId: req.reqId,
      });
      logAudit(req, { action: "overpayment_detected", entityType: "payment", metadata: { studentId, excess, newPaid, totalCharges: preLb.totalCharges } });
      logAudit(req, { action: "overpayment_confirmed", entityType: "payment", entityId: payment.id, metadata: { studentId, enteredAmount: parsedAmount, outstanding: outstandingBefore, overpayAmount: excess } });
    }

    const postLb = await deriveStudentBalance(studentId);
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (PLAN_LIMITS[user?.plan]?.receipts) {
      autoSendReceipt({ payment, student: { ...student, daysOverdue }, user }).catch(e => logger.error("receipt", e.message));
    }

    logger.payment("manual_payment_recorded", { userId: req.userId, studentId, amount: parsedAmount, method: method || "cash", txnRef: txnRef || null, reqId: req.reqId });
    logAudit(req, { action: "payment_added", entityType: "payment", entityId: payment.id, metadata: { studentId, amount: parsedAmount, method: method || "cash", txnRef: txnRef || null, overpayment: excess } });

    res.status(201).json({
      id: payment.id, name: payment.student?.name,
      initials: (payment.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (payment.student?.cls || "") + " · " + (payment.student?.adm || ""),
      txn: payment.txnRef || "—", method: payment.method, feeBreakdown: payment.feeBreakdown,
      amount: "KES " + Number(payment.amount).toLocaleString(), rawAmount: payment.amount,
      time: "Just now", createdAt: payment.createdAt, receivedAt: payment.receivedAt || payment.createdAt, studentId: payment.studentId,
      updatedStudent: {
        id: studentId,
        // Return ledger-derived figures so the frontend never uses stale legacy fields.
        totalPaid:   postLb.totalPaid,
        totalCharges: postLb.totalCharges,
        outstanding: postLb.outstanding,
        creditBalance: postLb.creditBalance,
        daysOverdue,
        version:     student.version + 1,
      },
      overpayment: excess > 0
        ? { amount: excess, message: `KES ${excess.toLocaleString()} exceeds the student's balance. A credit memo has been created and will apply to future fees.` }
        : null,
    });
  } catch (e) { return apiError(res, e, "create payment", req); }
});

// ─── PAYMENT REVERSAL (replaces hard delete) ──────────────────────────────────
// WHY: Permanently deleting a payment destroys the audit trail and makes it
// impossible to reconcile historical totals. Instead we:
//   1. Set reversedAt + reversedBy + reversalReason on the original payment row
//   2. Create a companion payment row (isReversal=true, negative-equivalent)
//      so the ledger stays balanced and reports stay correct
//   3. Keep the deprecated student cache fields untouched
//   4. Write to BalanceLedger for the consistency job
// The UI still shows "Delete" because accountants expect that language, but
// the financial record is never destroyed.
app.delete("/api/payments/:id", requireAuth, requirePermission("payments.reverse"), async (req, res) => {
  const { reason } = req.body; // optional short reason from UI
  try {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, userId: req.userId, reversedAt: null },
    });
    if (!payment) return res.status(404).json({ message: "Payment not found or already reversed." });

    const student = await prisma.student.findUnique({ where: { id: payment.studentId } });
    // Derive pre-reversal balance from ledger — not student.paid
    const preLb   = await deriveStudentBalance(payment.studentId);
    const newPaid = Math.max(0, preLb.totalPaid - payment.amount);

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: req.params.id },
        data: {
          reversedAt:     new Date(),
          reversedBy:     req.userId,
          reversalReason: reason || "Deleted by cashier",
          version:        { increment: 1 },
        },
      });
      await tx.payment.create({
        data: {
          amount:           payment.amount,
          txnRef:           null,
          method:           payment.method,
          termId:           payment.termId || null,
          paymentTermId:    payment.paymentTermId || payment.termId || null,
          receivedAt:       new Date(),
          feeBreakdown:     payment.feeBreakdown || [],
          studentId:        payment.studentId,
          userId:           req.userId,
          isReversal:       true,
          originalPaymentId: payment.id,
          overpaymentAmount: 0,
        },
      });
      await tx.student.update({ where: { id: payment.studentId }, data: { version: { increment: 1 } } });
      // Ledger entry with ledger-derived balanceBefore — not student.paid
      await tx.balanceLedger.create({
        data: {
          studentId: payment.studentId,
          userId:    req.userId,
          paymentId: payment.id,
          delta:         -payment.amount,
          balanceBefore: preLb.totalPaid,      // from ledger
          balanceAfter:  newPaid,
          source:    "reversal",
          note:      reason || "Deleted by cashier",
        },
      });
      // Void any CreditMemo that was created from this payment
      await tx.creditMemo.updateMany({
        where: { sourcePaymentId: payment.id, status: "available" },
        data:  { status: "voided", note: "Voided — source payment reversed" },
      });
    });

    logger.payment("payment_reversed", { userId: req.userId, paymentId: payment.id, amount: payment.amount, studentId: payment.studentId, reqId: req.reqId });
    logAudit(req, { action: "payment_reversed", entityType: "payment", entityId: payment.id, metadata: { amount: payment.amount, studentId: payment.studentId, reason: reason || null } });

    const postLb = await deriveStudentBalance(payment.studentId);
    res.json({ message: "Payment reversed", studentId: payment.studentId, amount: payment.amount, newPaid: postLb.totalPaid, updatedStudent: { id: payment.studentId, totalPaid: postLb.totalPaid, totalCharges: postLb.totalCharges, outstanding: postLb.outstanding, creditBalance: postLb.creditBalance } });
  } catch (e) { return apiError(res, e, "reverse payment", req); }
});

app.get("/api/payments/unmatched", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const list = await prisma.unmatchedPayment.findMany({
      where: {
        userId: req.userId,
        OR: [{ source: "c2b" }, { source: null }],
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(list.map(p => {
      const storedPhone = isSha256Hex(p.phone) ? null : p.phone;
      return {
        id: p.id,
        phone: storedPhone || extractC2bPayerPhone(p.rawSafaricomMetadata) || null,
        phoneHiddenByProvider: isSha256Hex(p.phone) || isSha256Hex(findC2bPhoneCandidate(p.rawSafaricomMetadata)),
        senderName: p.senderName || null,
        billRefNumber: p.billRefNumber || null,
        txn: p.txnRef || "—",
        amount: "KES " + Number(p.amount).toLocaleString(),
        rawAmount: p.amount,
        time: new Date(p.transactionDate || p.createdAt).toLocaleString("en-KE"),
        transactionDate: p.transactionDate || null,
        rawSafaricomMetadata: p.rawSafaricomMetadata || null,
        matchStatus: p.matchStatus || "UNMATCHED",
        matchConfidence: p.matchConfidence || 0,
        matchReason: p.matchReason || null,
        suggestedStudentId: p.suggestedStudentId || null,
        suggestedReason: p.suggestedReason || null,
      };
    }));
  } catch (e) { return apiError(res, e, "get unmatched payments"); }
});

app.post("/api/payments/unmatched/:id/assign", requireAuth, requirePermission("payments.create"), async (req, res) => {
  const { studentId } = req.body;
  if (!studentId) return res.status(400).json({ message: "studentId required" });
  try {
    const unmatched = await prisma.unmatchedPayment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!unmatched) return res.status(404).json({ message: "Unmatched payment not found" });
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const preLb = await deriveStudentBalance(studentId);
    const activeTerm = await activePaymentTerm(req.userId);
    let createdPayment;
    await prisma.$transaction(async (tx) => {
      const excess = Math.max(0, Number(unmatched.amount || 0) - Number(preLb.outstanding || 0));
      const p = await tx.payment.create({ data: { amount: unmatched.amount, txnRef: unmatched.txnRef, method: "mpesa", feeBreakdown: [], termId: activeTerm?.id || null, paymentTermId: activeTerm?.id || null, receivedAt: new Date(), overpaymentAmount: excess, studentId, userId: req.userId } });
      createdPayment = p;
      await allocatePaymentFIFO(p.id, tx, preLb.outstanding);
      if (excess > 0) {
        await tx.creditMemo.create({ data: { studentId, userId: req.userId, termId: activeTerm?.id || null, sourcePaymentId: p.id, amount: excess, remainingAmount: excess, status: "available", note: "Auto-generated from assigned M-Pesa overpayment" } });
      }
      await tx.student.update({ where: { id: studentId }, data: { version: { increment: 1 } } });
      await tx.unmatchedPayment.delete({ where: { id: req.params.id } });
    });

    logAudit(req, { action: "payment_added", entityType: "payment", metadata: { source: "unmatched_assignment", unmatchedId: req.params.id, studentId, amount: unmatched.amount, txnRef: unmatched.txnRef } });

    const postLb = await deriveStudentBalance(studentId);
    res.json({ message: "Assigned successfully", updatedStudent: { id: studentId, totalPaid: postLb.totalPaid, totalCharges: postLb.totalCharges, outstanding: postLb.outstanding, creditBalance: postLb.creditBalance } });

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (user && PLAN_LIMITS[user?.plan]?.receipts) {
      autoSendReceipt({ payment: createdPayment, student, user })
        .catch(e => logger.error("receipt", "assign auto-receipt failed", { error: e.message }));
    }
  } catch (e) { return apiError(res, e, "assign unmatched payment"); }
});

app.post("/api/payments/unmatched/:id/recheck", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const unmatched = await prisma.unmatchedPayment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!unmatched) return res.status(404).json({ message: "Unmatched payment not found" });

    const match = await matchMpesaEvent({
      userId: req.userId,
      billRefNumber: unmatched.billRefNumber || null,
      payerName: unmatched.senderName || null,
      narration: unmatched.billRefNumber || unmatched.senderName || "",
      amount: unmatched.amount,
      phone: unmatched.phone || "",
    });

    const updated = await prisma.unmatchedPayment.update({
      where: { id: unmatched.id },
      data: {
        matchStatus: match.matchStatus,
        matchConfidence: match.matchConfidence,
        matchReason: match.matchReason,
        matchedStudentId: match.matchedStudentId,
        suggestedStudentId: match.suggestedStudentId,
        suggestedReason: match.suggestedReason,
      },
    });

    res.json({
      id: updated.id,
      matchStatus: updated.matchStatus,
      matchConfidence: updated.matchConfidence,
      matchReason: updated.matchReason,
      matchedStudentId: updated.matchedStudentId,
      suggestedStudentId: updated.suggestedStudentId,
      suggestedReason: updated.suggestedReason,
    });
  } catch (e) { return apiError(res, e, "recheck unmatched payment"); }
});

// ─── M-PESA STK PUSH (admin dashboard — authenticated) ──────────────────────
// Multi-tenant: uses the logged-in school's OWN Daraja credentials.
// Reliability improvements:
// 1. In-flight guard — blocks duplicate STK pushes for the same student
// 2. Creates a MpesaTransaction record so every push is tracked end-to-end
// 3. Audit log on initiation
// 4. Uses module-level fetchWithTimeout (no more inline definition)
app.post("/api/bank-statements/upload", requireAuth, requirePermission("payments.create"), statementUploadMiddleware, async (req, res) => {
  let upload = null;
  try {
    const file = req.statementFile;
    const fileHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const duplicateUpload = await prisma.bankStatementUpload.findFirst({ where: { userId: req.userId, fileHash, status: { in: ["PROCESSED", "COMPLETED"] } }, orderBy: { uploadedAt: "desc" } });
    if (duplicateUpload) {
      await prisma.bankStatementUpload.create({ data: { userId: req.userId, fileName: file.filename, fileHash, uploadedBy: req.staffId || req.userId, status: "REJECTED_DUPLICATE_FILE" } });
      logAudit(req, { action: "bank_statement_duplicate_file_rejected", entityType: "bank_statement_upload", entityId: duplicateUpload.id, metadata: { fileName: file.filename, fileHash } });
      return res.status(409).json({ message: "This bank statement has already been uploaded and processed." });
    }

    upload = await prisma.bankStatementUpload.create({ data: { userId: req.userId, fileName: file.filename, fileHash, uploadedBy: req.staffId || req.userId, status: "PROCESSING" } });
    logAudit(req, { action: "bank_statement_file_uploaded", entityType: "bank_statement_upload", entityId: upload.id, metadata: { fileName: file.filename, fileHash } });
    const normalizedRows = (await parseBankStatementRows(file)).map(normalizeBankRow).filter(row => row.paidAt && row.amount > 0);
    logger.info("bank-statement", "parsed rows", { userId: req.userId, uploadId: upload.id, parsedRows: normalizedRows.length, reqId: req.reqId });
    if (!normalizedRows.length) {
      await prisma.bankStatementUpload.update({ where: { id: upload.id }, data: { status: "FAILED_EMPTY" } });
      if (isPdfStatement(file)) return res.status(400).json({ message: "No valid payment rows were found in this PDF. Please upload CSV/Excel or a clearer statement PDF." });
      return res.status(400).json({ message: "No valid payment rows were found. Check that the file has date and amount columns." });
    }

    const [students, invoices] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId, deletedAt: null } }),
      prisma.invoice.findMany({ where: { userId: req.userId }, select: { id: true, invoiceNo: true, studentId: true, token: true, createdAt: true } }),
    ]);
    const balances = await deriveStudentBalancesBatch(students.map(s => s.id));
    const studentsById = new Map(students.map(s => [s.id, s]));
    const duplicateContext = await buildBankDuplicateContext({ normalizedRows, userId: req.userId });
    const dbDuplicateRefCount = new Set([...duplicateContext.existingBankRefs, ...duplicateContext.existingPaymentRefs]).size;
    logger.info("bank-statement", "existing duplicate refs found", { userId: req.userId, uploadId: upload.id, duplicateRefs: dbDuplicateRefCount, bankRefs: duplicateContext.existingBankRefs.size, paymentRefs: duplicateContext.existingPaymentRefs.size, fallbackDuplicates: duplicateContext.fallbackDuplicateKeys.size, reqId: req.reqId });

    const rowPayloads = [];
    for (const normalized of normalizedRows) {
      const match = matchBankTransaction({ normalized, students, invoices, balances, existingBankRefs: duplicateContext.existingBankRefs, existingPaymentRefs: duplicateContext.existingPaymentRefs, fallbackDuplicateKeys: duplicateContext.fallbackDuplicateKeys });
      const storedRef = match.paymentStatus === BANK_STATUS.DUPLICATE ? null : (normalized.transactionRef || null);
      rowPayloads.push({ userId: req.userId, uploadId: upload.id, transactionRef: storedRef, amount: normalized.amount, paidAt: normalized.paidAt, payerName: normalized.payerName || null, narration: normalized.narration || null, rawRowJson: normalized.rawRowJson, ...match });
      if (normalized.transactionRef && match.paymentStatus !== BANK_STATUS.DUPLICATE) duplicateContext.existingBankRefs.add(normalized.transactionRef);
      if (!normalized.transactionRef && match.paymentStatus !== BANK_STATUS.DUPLICATE) duplicateContext.fallbackDuplicateKeys.add(bankFallbackDuplicateKey(normalized));
    }

    const created = [];
    let uploadStatusUpdate = null;

    await prisma.$transaction(async (tx) => {
      for (const data of rowPayloads) {
        const row = await tx.bankTransaction.create({ data });
        created.push(row);
      }
      uploadStatusUpdate = await tx.bankStatementUpload.update({ where: { id: upload.id }, data: { status: "PROCESSED" } });
    }, { timeout: 20000, maxWait: 10000 });
    logger.info("bank-statement", "transaction writes complete", { userId: req.userId, uploadId: upload.id, createdCount: created.length, reqId: req.reqId });
    logger.info("bank-statement", "upload status update result", { userId: req.userId, uploadId: upload.id, status: uploadStatusUpdate?.status, reqId: req.reqId });

    for (const txn of created.filter(t => t.matchedStudentId && t.matchConfidence > 0)) {
      logAudit(req, { action: "bank_transaction_matched", entityType: "bank_transaction", entityId: txn.id, metadata: { matchedStudentId: txn.matchedStudentId, confidence: txn.matchConfidence, reason: txn.matchReason, status: txn.paymentStatus } });
    }
    res.status(201).json({ upload: { id: upload.id, fileName: upload.fileName, fileHash: upload.fileHash, status: "PROCESSED" }, transactions: created.map(t => serializeBankTransaction(t, studentsById)) });
  } catch (e) {
    if (upload?.id) {
      await prisma.bankStatementUpload.update({ where: { id: upload.id }, data: { status: "FAILED" } })
        .catch(updateError => logger.warn("bank-statement", "failed to mark upload failed", { uploadId: upload.id, error: safeErrorMessage(updateError), reqId: req.reqId }));
      logger.error("bank-statement", "upload failed", { uploadId: upload.id, error: safeErrorMessage(e), reqId: req.reqId });
    }
    if (e.code === "P2002") return res.status(409).json({ message: "A transaction in this statement has already been imported." });
    return apiError(res, e, "upload bank statement", req);
  }
});

app.get("/api/bank-statements/uploads/:id/transactions", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const upload = await prisma.bankStatementUpload.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!upload) return res.status(404).json({ message: "Upload not found" });
    const transactions = await prisma.bankTransaction.findMany({ where: { uploadId: upload.id, userId: req.userId }, orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }] });
    const students = await prisma.student.findMany({ where: { userId: req.userId, id: { in: [...new Set(transactions.flatMap(t => [t.matchedStudentId, t.suggestedStudentId]).filter(Boolean))] } } });
    res.json({ upload, transactions: transactions.map(t => serializeBankTransaction(t, new Map(students.map(s => [s.id, s])))) });
  } catch (e) { return apiError(res, e, "get bank transactions", req); }
});

app.patch("/api/bank-statements/transactions/:id/match", requireAuth, requirePermission("payments.create"), async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ message: "studentId required" });
  try {
    const transaction = await prisma.bankTransaction.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!transaction) return res.status(404).json({ message: "Transaction not found" });
    if (transaction.createdPaymentId) return res.status(400).json({ message: "Approved transactions cannot be rematched." });
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId, deletedAt: null } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const balance = await deriveStudentBalance(student.id);
    const updated = await prisma.bankTransaction.update({ where: { id: transaction.id }, data: { matchedStudentId: student.id, suggestedStudentId: null, suggestedReason: null, matchConfidence: 100, matchReason: "Manual admin match", requiredBalance: balance.outstanding, paymentStatus: transaction.paymentStatus === BANK_STATUS.DUPLICATE ? BANK_STATUS.DUPLICATE : classifyBankPaymentStatus(transaction.amount, balance.outstanding, 100) } });
    logAudit(req, { action: "bank_transaction_manual_match_changed", entityType: "bank_transaction", entityId: transaction.id, metadata: { studentId: student.id, amount: transaction.amount } });
    res.json({ transaction: serializeBankTransaction(updated, new Map([[student.id, student]])) });
  } catch (e) { return apiError(res, e, "match bank transaction", req); }
});

app.patch("/api/bank-statements/transactions/:id/mark-unknown", requireAuth, requirePermission("payments.create"), async (req, res) => {
  try {
    const transaction = await prisma.bankTransaction.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!transaction) return res.status(404).json({ message: "Transaction not found" });
    if (transaction.createdPaymentId) return res.status(400).json({ message: "Approved transactions cannot be changed." });
    const updated = await prisma.bankTransaction.update({ where: { id: transaction.id }, data: { matchedStudentId: null, suggestedStudentId: null, suggestedReason: null, matchConfidence: 0, matchReason: "Marked unknown by admin", requiredBalance: 0, paymentStatus: BANK_STATUS.UNMATCHED } });
    logAudit(req, { action: "bank_transaction_marked_unknown", entityType: "bank_transaction", entityId: transaction.id, metadata: { amount: transaction.amount } });
    res.json({ transaction: serializeBankTransaction(updated) });
  } catch (e) { return apiError(res, e, "mark bank transaction unknown", req); }
});

app.patch("/api/bank-statements/transactions/:id/ignore-duplicate", requireAuth, requirePermission("payments.create"), async (req, res) => {
  try {
    const transaction = await prisma.bankTransaction.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!transaction) return res.status(404).json({ message: "Transaction not found" });
    const updated = await prisma.bankTransaction.update({ where: { id: transaction.id }, data: { paymentStatus: BANK_STATUS.DUPLICATE } });
    logAudit(req, { action: "bank_transaction_duplicate_ignored", entityType: "bank_transaction", entityId: transaction.id, metadata: { amount: transaction.amount, transactionRef: transaction.transactionRef } });
    res.json({ transaction: serializeBankTransaction(updated) });
  } catch (e) { return apiError(res, e, "ignore bank duplicate", req); }
});

async function approveBankTransaction(req, transaction, { confirmOverpayment = false } = {}) {
  if (transaction.createdPaymentId) return { skipped: true, transaction, reason: "already_approved" };
  if (transaction.paymentStatus === BANK_STATUS.DUPLICATE) return { skipped: true, transaction, reason: "duplicate" };
  if (!transaction.matchedStudentId || transaction.matchConfidence < 85) return { skipped: true, transaction, reason: "unsafe_match" };
  if (![BANK_STATUS.FULL, BANK_STATUS.PARTIAL, BANK_STATUS.OVERPAYMENT].includes(transaction.paymentStatus)) return { skipped: true, transaction, reason: "status_not_approvable" };
  if (transaction.paymentStatus === BANK_STATUS.OVERPAYMENT && confirmOverpayment !== true) {
    const overBy = Math.max(0, Number(transaction.amount || 0) - Number(transaction.requiredBalance || 0));
    throw Object.assign(new Error("Amount exceeds required balance by KES " + fmtKE(overBy)), { statusCode: 409, details: { requiresConfirmation: true, overpaymentAmount: overBy } });
  }
  const student = await prisma.student.findFirst({ where: { id: transaction.matchedStudentId, userId: req.userId, deletedAt: null } });
  if (!student) throw Object.assign(new Error("Matched student not found."), { statusCode: 404 });
  if (transaction.transactionRef) {
    const existingPayment = await prisma.payment.findFirst({ where: { userId: req.userId, txnRef: transaction.transactionRef } });
    if (existingPayment) {
      const updatedDuplicate = await prisma.bankTransaction.update({ where: { id: transaction.id }, data: { paymentStatus: BANK_STATUS.DUPLICATE } });
      return { skipped: true, transaction: updatedDuplicate, reason: "duplicate" };
    }
  }
  const preLb = await deriveStudentBalance(student.id);
  const activeTerm = await activePaymentTerm(req.userId);
  const excess = Math.max(0, Number(transaction.amount || 0) - Number(preLb.outstanding || 0));
  const receiptNo = await nextReceiptNo(req.userId);
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({ data: { amount: transaction.amount, txnRef: transaction.transactionRef || null, method: "bank", termId: activeTerm?.id || null, paymentTermId: activeTerm?.id || null, receivedAt: transaction.paidAt, feeBreakdown: [], studentId: student.id, userId: req.userId, overpaymentAmount: excess, version: 1 } });
    await tx.student.update({ where: { id: student.id }, data: { daysOverdue: transaction.amount >= preLb.outstanding ? 0 : student.daysOverdue, version: { increment: 1 } } });
    await allocatePaymentFIFO(payment.id, tx, preLb.outstanding);
    await tx.balanceLedger.create({ data: { studentId: student.id, userId: req.userId, paymentId: payment.id, delta: transaction.amount, balanceBefore: preLb.totalPaid, balanceAfter: preLb.totalPaid + transaction.amount, source: "payment", note: "bank_statement" } });
    if (excess > 0) await tx.creditMemo.create({ data: { studentId: student.id, userId: req.userId, termId: activeTerm?.id || null, sourcePaymentId: payment.id, amount: excess, remainingAmount: excess, status: "available", note: "Auto-generated from bank statement overpayment" } });
    const postLb = await deriveStudentBalance(student.id, null, tx);
    let receipt = await tx.receipt.create({ data: { userId: req.userId, paymentId: payment.id, studentId: student.id, studentName: student.name, admNo: student.adm, className: student.cls, amount: payment.amount, method: "bank", txnRef: payment.txnRef || null, paidAt: payment.receivedAt, token: genToken(), receiptNo, channels: [], type: "bank_statement", balance: postLb.outstanding, status: "generated" } });
    receipt = await tx.receipt.update({ where: { id: receipt.id }, data: { token: receiptLinkToken(receipt) } });
    const updatedTransaction = await tx.bankTransaction.update({ where: { id: transaction.id }, data: { createdPaymentId: payment.id, createdReceiptId: receipt.id, paymentStatus: classifyBankPaymentStatus(transaction.amount, preLb.outstanding, transaction.matchConfidence), requiredBalance: preLb.outstanding } });
    return { payment, receipt, transaction: updatedTransaction, postLb };
  });
  logAudit(req, { action: "bank_statement_receipt_created", entityType: "receipt", entityId: result.receipt.id, metadata: { bankTransactionId: transaction.id, paymentId: result.payment.id, studentId: student.id, amount: transaction.amount } });
  if (excess > 0) logAudit(req, { action: "bank_statement_overpayment_confirmed", entityType: "bank_transaction", entityId: transaction.id, metadata: { studentId: student.id, amount: transaction.amount, outstanding: preLb.outstanding, overpaymentAmount: excess } });
  logger.payment("bank_statement_payment_approved", { userId: req.userId, studentId: student.id, amount: transaction.amount, txnRef: transaction.transactionRef || null, reqId: req.reqId });
  return { ...result, student };
}

app.post("/api/bank-statements/transactions/:id/approve", requireAuth, requirePermission("payments.create"), async (req, res) => {
  try {
    const parsed = bankApprovalSchema.pick({ confirmOverpayment: true }).parse(req.body || {});
    const transaction = await prisma.bankTransaction.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!transaction) return res.status(404).json({ message: "Transaction not found" });
    const result = await approveBankTransaction(req, transaction, parsed);
    const studentsById = result.student ? new Map([[result.student.id, result.student]]) : new Map();
    res.json({ approved: !result.skipped, reason: result.reason || null, transaction: serializeBankTransaction(result.transaction, studentsById), paymentId: result.payment?.id || null, receiptId: result.receipt?.id || null });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message, ...(e.details || {}) });
    if (e.code === "P2002") return res.status(409).json({ message: "This transaction reference has already been recorded." });
    return apiError(res, e, "approve bank transaction", req);
  }
});

app.post("/api/bank-statements/uploads/:id/approve-safe", requireAuth, requirePermission("payments.create"), async (req, res) => {
  try {
    const upload = await prisma.bankStatementUpload.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!upload) return res.status(404).json({ message: "Upload not found" });
    const candidates = await prisma.bankTransaction.findMany({ where: { uploadId: upload.id, userId: req.userId, createdPaymentId: null, matchConfidence: { gte: 85 }, paymentStatus: { in: [BANK_STATUS.FULL, BANK_STATUS.PARTIAL] } }, orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }] });
    const safe = candidates.filter(t => String(t.matchReason || "").startsWith("Exact "));
    const results = [];
    for (const transaction of safe) results.push(await approveBankTransaction(req, transaction, { confirmOverpayment: false }));
    const refreshed = await prisma.bankTransaction.findMany({ where: { uploadId: upload.id, userId: req.userId }, orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }] });
    const students = await prisma.student.findMany({ where: { userId: req.userId, id: { in: [...new Set(refreshed.flatMap(t => [t.matchedStudentId, t.suggestedStudentId]).filter(Boolean))] } } });
    res.json({ approvedCount: results.filter(r => !r.skipped).length, skippedCount: results.filter(r => r.skipped).length, transactions: refreshed.map(t => serializeBankTransaction(t, new Map(students.map(s => [s.id, s])))) });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ message: "One of these transaction references has already been recorded." });
    return apiError(res, e, "approve safe bank transactions", req);
  }
});

// ─── Parent bank submissions (Admin endpoints) ──────────────────────────────
app.get("/api/payments/bank-confirmations", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const take = Math.min(Number(req.query.limit || 50), 200);
    const cursor = req.query.cursor ? { id: req.query.cursor } : undefined;
    const rows = await prisma.parentBankPaymentSubmission.findMany({
      where: { userId: req.userId },
      orderBy: { submittedAt: "desc" },
      take,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    const [students, invoices] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId, id: { in: [...new Set(rows.map(r => r.studentId).filter(Boolean))] } } }),
      prisma.invoice.findMany({ where: { userId: req.userId, id: { in: [...new Set(rows.map(r => r.invoiceId).filter(Boolean))] } } }),
    ]);
    const studentMap = new Map(students.map(s => [s.id, s]));
    const invoiceMap = new Map(invoices.map(i => [i.id, i]));
    const payload = rows.map(r => ({
      id: r.id,
      invoiceId: r.invoiceId,
      invoiceNo: invoiceMap.get(r.invoiceId)?.invoiceNo ?? null,
      studentId: r.studentId,
      studentName: studentMap.get(r.studentId)?.name || invoiceMap.get(r.invoiceId)?.studentName || null,
      admNo: studentMap.get(r.studentId)?.adm || invoiceMap.get(r.invoiceId)?.admNo || null,
      className: studentMap.get(r.studentId)?.cls || invoiceMap.get(r.invoiceId)?.className || null,
      parentName: r.parentName,
      parentPhone: r.parentPhone,
      transactionRef: r.transactionRef || null,
      amount: r.amount,
      paidAt: r.paidAt,
      note: r.note,
      status: r.status,
      proofUrl: r.proofPath ? `/api/payments/bank-confirmations/${r.id}/proof` : null,
      createdAt: r.submittedAt,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedBy,
    }));
    res.setHeader("X-Total-Count", payload.length.toString());
    if (payload.length === take) res.setHeader("X-Next-Cursor", payload[payload.length - 1].id);
    res.json(payload);
  } catch (e) { return apiError(res, e, "list bank confirmations", req); }
});

app.get("/api/payments/bank-confirmations/:id/proof", requireAuth, requirePermission("payments.view"), async (req, res) => {
  try {
    const submission = await prisma.parentBankPaymentSubmission.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!submission?.proofPath) return res.status(404).json({ message: "Proof file not found" });
    const proofPath = path.resolve(submission.proofPath);
    const proofRoot = path.resolve(UPLOAD_ROOT, "proofs");
    const rel = path.relative(proofRoot, proofPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(403).json({ message: "Proof file is not accessible" });
    await fsp.access(proofPath);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(proofPath);
  } catch (e) {
    if (e?.code === "ENOENT") return res.status(404).json({ message: "Proof file not found" });
    return apiError(res, e, "view bank confirmation proof", req);
  }
});

app.post("/api/payments/bank-confirmations/:id/confirm", requireAuth, requirePermission("payments.create"), async (req, res) => {
  try {
    const submission = await prisma.parentBankPaymentSubmission.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!submission) return res.status(404).json({ message: "Submission not found" });
    if (submission.status === "CONFIRMED") return res.status(400).json({ message: "Already confirmed" });

    if (submission.transactionRef) {
      const [dupPayment, dupBank, dupSubmission] = await Promise.all([
        prisma.payment.findFirst({ where: { userId: req.userId, txnRef: submission.transactionRef } }),
        prisma.bankTransaction.findFirst({ where: { userId: req.userId, transactionRef: submission.transactionRef } }),
        prisma.parentBankPaymentSubmission.findFirst({ where: { userId: req.userId, transactionRef: submission.transactionRef, id: { not: submission.id } } }),
      ]);
      if (dupPayment || dupBank || dupSubmission) {
        await prisma.parentBankPaymentSubmission.update({ where: { id: submission.id }, data: { status: "DUPLICATE", reviewedAt: new Date(), reviewedBy: req.userId } });
        return res.status(409).json({ message: "This transaction reference already exists." });
      }
    }

    const student = submission.studentId ? await prisma.student.findFirst({ where: { id: submission.studentId, userId: req.userId } }) : null;
    if (!student) return res.status(404).json({ message: "Matched student not found" });

    const preLb = await deriveStudentBalance(student.id);
    const activeTerm = await activePaymentTerm(req.userId);
    const excess = Math.max(0, Number(submission.amount || 0) - Number(preLb.outstanding || 0));

    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({ data: {
        amount: submission.amount,
        txnRef: submission.transactionRef || null,
        method: "bank",
        termId: activeTerm?.id || null,
        paymentTermId: activeTerm?.id || null,
        receivedAt: submission.paidAt || new Date(),
        feeBreakdown: [],
        studentId: student.id,
        userId: req.userId,
        overpaymentAmount: excess,
        version: 1,
      } });

      await tx.student.update({ where: { id: student.id }, data: { daysOverdue: submission.amount >= preLb.outstanding ? 0 : student.daysOverdue, version: { increment: 1 } } });
      await allocatePaymentFIFO(payment.id, tx, preLb.outstanding);
      await tx.balanceLedger.create({ data: { studentId: student.id, userId: req.userId, paymentId: payment.id, delta: submission.amount, balanceBefore: preLb.totalPaid, balanceAfter: preLb.totalPaid + submission.amount, source: "parent_submission", note: "parent_portal" } });
      if (excess > 0) await tx.creditMemo.create({ data: { studentId: student.id, userId: req.userId, termId: activeTerm?.id || null, sourcePaymentId: payment.id, amount: excess, remainingAmount: excess, status: "available", note: "Auto-generated from parent submission overpayment" } });

      const receiptNo = await nextReceiptNo(req.userId);
      let receipt = await tx.receipt.create({ data: { userId: req.userId, paymentId: payment.id, studentId: student.id, studentName: student.name, admNo: student.adm, className: student.cls, amount: payment.amount, method: "bank", txnRef: payment.txnRef || null, paidAt: payment.receivedAt, token: genToken(), receiptNo, channels: [], type: "parent_submission", balance: 0, status: "generated" } });
      receipt = await tx.receipt.update({ where: { id: receipt.id }, data: { token: receiptLinkToken(receipt) } });

      const updated = await tx.parentBankPaymentSubmission.update({ where: { id: submission.id }, data: { createdPaymentId: payment.id, createdReceiptId: receipt.id, status: "CONFIRMED", reviewedAt: new Date(), reviewedBy: req.userId } });
      await tx.parentBankPaymentSubmission.delete({ where: { id: submission.id } });
      return { payment, receipt, updated };
    });

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    // Auto-send receipt if feature enabled
    autoSendReceipt({ payment: result.payment, student, user })
      .catch(e => logger.error("receipt", "bank-submission auto-receipt failed", { error: e.message }));

    await logAudit(req, { action: "parent_bank_submission_confirmed", entityType: "parent_bank_submission", entityId: submission.id, entityId2: result.payment.id, schoolOwnerId: req.userId, metadata: { paymentId: result.payment.id } });
    res.json({ approved: true, paymentId: result.payment.id, receiptId: result.receipt.id });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ message: "This transaction reference has already been recorded." });
    return apiError(res, e, "confirm parent bank submission", req);
  }
});

app.post("/api/payments/bank-confirmations/:id/reject", requireAuth, requirePermission("payments.create"), async (req, res) => {
  try {
    const { reason } = req.body || {};
    const submission = await prisma.parentBankPaymentSubmission.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!submission) return res.status(404).json({ message: "Submission not found" });
    if (submission.status === "CONFIRMED") return res.status(400).json({ message: "Cannot reject a confirmed submission" });
    const updated = await prisma.parentBankPaymentSubmission.update({ where: { id: submission.id }, data: { status: "REJECTED", reviewedAt: new Date(), reviewedBy: req.userId, metadata: { ...(submission.metadata || {}), reviewReason: reason || null } } });

    // Notify parent if phone/email available
    try {
      const student = await prisma.student.findUnique({ where: { id: submission.studentId } });
      const parentPhone = submission.parentPhone || student?.parentPhone;
      const parentEmail = submission.parentName && student?.parentEmail ? student.parentEmail : null;
      const msg = `Your bank payment submission for invoice ${submission.invoiceId} was rejected${reason ? `: ${reason}` : ""}. Please contact the school.`;
      if (parentPhone) await sendSMS(parentPhone, msg, null).catch(() => {});
      if (parentEmail) await sendEmail(parentEmail, `Payment submission rejected`, renderEmailLayout({ schoolName: (req.user?.schoolName || "School"), title: "Payment submission rejected", bodyHtml: `<p>${escHtml(msg)}</p>` })).catch(() => {});
    } catch {}

    await logAudit(req, { action: "parent_bank_submission_rejected", entityType: "parent_bank_submission", entityId: submission.id, schoolOwnerId: req.userId, metadata: { reason } });
    res.json({ rejected: true });
  } catch (e) { return apiError(res, e, "reject parent bank submission", req); }
});

app.post("/api/payments/stk", requireAuth, requirePermission("payments.create"), requirePlan("mpesa"), adminStkLimiter, async (req, res) => {
  const { studentId, amount, phone } = req.body;
  if (!studentId || !amount || !phone) return res.status(400).json({ message: "studentId, amount and phone required" });
  const stkPhone = normalizeSafaricomStkPhone(phone);
  if (!stkPhone) {
    logger.warn("stk", "Invalid STK phone number", { reqId: req.reqId, phone: maskSafaricomPhone(phone) });
    return res.status(400).json({ message: "Enter a valid Safaricom number, e.g. 0701475742 or 0112345678" });
  }
  let stkShortcode = null;

  // Outage mode — inform admin so they don't spam retries during Safaricom downtime
  if (outageState.degraded) {
    logger.warn("stk", "STK push attempted during outage", { userId: req.userId, studentId, reqId: req.reqId });
    return res.status(503).json({
      message: "M-Pesa is currently experiencing delays. Success rate is low right now. You can still try, but confirmation may take longer than usual.",
      degraded: true,
      successRate: outageState.successRate,
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.mpesaConfigured) return res.status(503).json({ message: "M-Pesa not configured for your account. Please add your credentials in Settings." });

    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId }, select: { id: true, name: true, parentName: true } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    // Guard: block if there's already an in-flight payment for this student
    const inFlight = await prisma.mpesaTransaction.findFirst({
      where: {
        studentId,
        status: { in: ["pending", "awaiting_callback", "processing", "callback_delayed"] },
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
    });
    if (inFlight) {
      return res.status(409).json({
        message: inFlight.status === "callback_delayed"
          ? "A payment is still being confirmed. Please wait a few minutes before trying again. If it doesn't complete, contact the school."
          : "A payment is already in progress for this student. Please wait for confirmation before sending another STK push.",
        inFlight: true,
      });
    }

    const CK = decrypt(user.mpesaConsumerKey);
    const CS = decrypt(user.mpesaConsumerSecret);
    const SC = user.mpesaShortcode;
    stkShortcode = SC;
    const PK = decrypt(user.mpesaPasskey);
    const stkSecret = process.env.MPESA_CALLBACK_SECRET || "";
    const CB = stkSecret
      ? `${process.env.BACKEND_URL || "http://localhost:3000"}/api/mpesa/stk-cb/${stkSecret}/${req.userId}`
      : `${process.env.BACKEND_URL || "http://localhost:3000"}/api/mpesa/callback/${req.userId}`;

    if (!CK || !CS || !SC || !PK) return res.status(503).json({ message: "M-Pesa credentials are incomplete. Please re-enter them in Settings." });

    const auth = Buffer.from(CK + ":" + CS).toString("base64");
    const tokenRes = await fetchWithTimeout(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: "Basic " + auth } },
      20000
    );
    const { access_token } = await tokenRes.json();
    if (!access_token) return res.status(502).json({ message: "Failed to authenticate with M-Pesa. Check your consumer key and secret." });

    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(SC + PK + ts).toString("base64");
    logger.info("stk", "Sending STK push to Daraja", {
      reqId: req.reqId,
      userId: req.userId,
      shortcode: SC,
      amount: Math.round(amount),
      phone: maskSafaricomPhone(stkPhone),
      callbackUrl: redactCallbackUrl(CB),
    });
    const stkRes = await fetchWithTimeout("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + access_token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: SC, Password: pw, Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(amount), PartyA: stkPhone, PartyB: SC,
        PhoneNumber: stkPhone, CallBackURL: CB,
        AccountReference: "FF-" + studentId,
        TransactionDesc: "School fee payment",
      }),
    }, 20000);
    const d = await stkRes.json().catch(() => ({}));
    logger.info("stk", "Daraja STK response", {
      reqId: req.reqId,
      userId: req.userId,
      shortcode: SC,
      httpStatus: stkRes.status,
      response: d,
    });

    if (d.ResponseCode === "0") {
      // Create a MpesaTransaction record to track this push end-to-end
      const pendingTxn = await prisma.mpesaTransaction.create({
        data: {
          checkoutRequestId: d.CheckoutRequestID,
          merchantRequestId: d.MerchantRequestID || null,
          studentId, userId: req.userId,
          amount: Math.round(amount), phone: stkPhone,
          payerName: student.parentName || student.name || null,
          status: "awaiting_callback",
        },
      }).catch(e => {
        logger.error("stk", "Failed to create transaction record", { error: e.message, reqId: req.reqId });
        return null;
      });

      // Structured payment event log
      logger.payment("stk_push_initiated", { userId: req.userId, studentId, amount: Math.round(amount), checkoutRequestId: d.CheckoutRequestID, phone: maskSafaricomPhone(stkPhone), reqId: req.reqId });

      logAudit(req, { action: "mpesa_stk_push_initiated", entityType: "mpesa_transaction", entityId: d.CheckoutRequestID, metadata: { studentId, amount: Math.round(amount), phone: maskSafaricomPhone(stkPhone), checkoutRequestId: d.CheckoutRequestID } });

      res.json({
        success: true,
        checkoutRequestId: d.CheckoutRequestID,
        MerchantRequestID: d.MerchantRequestID || null,
        CheckoutRequestID: d.CheckoutRequestID || null,
        ResponseCode: d.ResponseCode || null,
        ResponseDescription: d.ResponseDescription || null,
        pendingPaymentId: pendingTxn?.id || null,
        mpesaTransactionId: pendingTxn?.id || null,
      });
    } else {
      logger.warn("stk", "Daraja rejected STK push", {
        reqId: req.reqId,
        userId: req.userId,
        shortcode: SC,
        httpStatus: stkRes.status,
        errorCode: d.errorCode || null,
        ResponseCode: d.ResponseCode || null,
      });
      res.status(400).json(darajaStkErrorPayload(d));
    }
  } catch (e) {
    if (e.name === "AbortError") {
      logger.warn("stk", "Daraja STK request timed out", { reqId: req.reqId, userId: req.userId, shortcode: stkShortcode, phone: maskSafaricomPhone(stkPhone) });
      return res.status(504).json({ message: "M-Pesa request timed out. Please try again." });
    }
    return apiError(res, e, "STK push");
  }
});

// ─── M-PESA CALLBACK ──────────────────────────────────────────────────────────
// RELIABILITY IMPROVEMENTS:
// 1. Respond 200 to Safaricom IMMEDIATELY — they retry on any non-200 response.
//    Processing is done async so a slow DB never triggers a Safaricom retry.
// 2. Webhook secret verification — rejects forged callbacks.
// 3. Full result code mapping — every failure is stored with a user-readable message.
// 4. Atomic DB writes — payment.create + student.update in a single $transaction
//    so a crash between the two can never leave the DB in a partial state.
// 5. MpesaTransaction state machine — every STK push is tracked end-to-end.
// 6. Audit log — every callback is written to AuditLog immediately on receipt.
// 7. Multi-tenant safe — uses :userId from callback URL (set at STK push time)
//    so unmatched payments are always attributed to the correct school.
app.get("/api/payments/stk/status/:checkoutRequestId", requireAuth, async (req, res) => {
  try {
    const txn = await prisma.mpesaTransaction.findFirst({
      where: { checkoutRequestId: req.params.checkoutRequestId, userId: req.userId },
    });
    if (!txn) return res.status(404).json({ message: "STK request not found" });

    const status = adminStkStatus(txn.status);
    let payment = null;
    let receipt = null;
    let updatedStudent = null;

    if (status === "SUCCESS") {
      payment = txn.mpesaRef
        ? await prisma.payment.findFirst({ where: { userId: req.userId, txnRef: txn.mpesaRef } })
        : null;
      receipt = payment
        ? await prisma.receipt.findFirst({ where: { userId: req.userId, paymentId: payment.id }, orderBy: { createdAt: "desc" } })
        : null;
      const balance = await deriveStudentBalance(txn.studentId);
      updatedStudent = {
        id: txn.studentId,
        totalPaid: balance.totalPaid,
        totalCharges: balance.totalCharges,
        outstanding: balance.outstanding,
        creditBalance: balance.creditBalance,
      };
    }

    res.json({
      status,
      rawStatus: txn.status,
      message: txn.resultDesc || null,
      receiptNumber: receipt?.receiptNo || null,
      paymentId: payment?.id || null,
      studentId: txn.studentId,
      updatedStudent,
    });
  } catch (e) {
    return apiError(res, e, "get STK status", req);
  }
});

function darajaC2bOk() {
  return { ResultCode: 0, ResultDesc: "Accepted" };
}

function parseDarajaC2bAmount(value) {
  const amount = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeMpesaMsisdn(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return "254" + digits;
  return null;
}

function isSha256Hex(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

const C2B_PHONE_FIELDS = new Set([
  "msisdn",
  "phonenumber",
  "subscriberphone",
  "customermsisdn",
]);

function c2bPhoneFieldKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function findC2bPhoneCandidate(value, depth = 0, seen = new Set()) {
  if (!value || depth > 6) return null;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const name = c2bPhoneFieldKey(item.Name || item.name || item.Key || item.key);
        if (C2B_PHONE_FIELDS.has(name)) {
          const direct = item.Value ?? item.value;
          if (direct != null && String(direct).trim()) return direct;
        }
      }
      const nested = findC2bPhoneCandidate(item, depth + 1, seen);
      if (nested != null && String(nested).trim()) return nested;
    }
    return null;
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (C2B_PHONE_FIELDS.has(c2bPhoneFieldKey(key)) && candidate != null && String(candidate).trim()) {
      return candidate;
    }
  }

  for (const candidate of Object.values(value)) {
    const nested = findC2bPhoneCandidate(candidate, depth + 1, seen);
    if (nested != null && String(nested).trim()) return nested;
  }
  return null;
}

function extractC2bPayerPhone(body) {
  const candidate = findC2bPhoneCandidate(body);
  return isSha256Hex(candidate) ? null : normalizeMpesaMsisdn(candidate);
}

function c2bRawMetadataWithDebugNote(body, msisdn) {
  if (!isSha256Hex(msisdn)) return body;
  return {
    ...body,
    payerIdentifierHash: String(msisdn).trim(),
    debugNote: "Provider sent anonymized MSISDN, real payer phone unavailable.",
  };
}

async function backfillUnmatchedC2bPhonesFromRawMetadata() {
  const rows = await prisma.unmatchedPayment.findMany({
    where: { OR: [{ source: "c2b" }, { source: null }] },
    select: { id: true, phone: true, rawSafaricomMetadata: true },
    take: 1000,
  });

  let updated = 0;
  for (const row of rows) {
    if (isSha256Hex(row.phone)) {
      await prisma.unmatchedPayment.update({
        where: { id: row.id },
        data: {
          phone: null,
          rawSafaricomMetadata: c2bRawMetadataWithDebugNote(row.rawSafaricomMetadata || {}, row.phone),
        },
      });
      updated += 1;
      continue;
    }

    if (row.phone) continue;
    const phone = extractC2bPayerPhone(row.rawSafaricomMetadata);
    if (!phone) continue;
    await prisma.unmatchedPayment.update({
      where: { id: row.id },
      data: { phone },
    });
    updated += 1;
  }

  if (updated > 0) logger.info("startup", "Backfilled unmatched C2B payer phones", { updated });
}

function parseDarajaTransTime(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return new Date();
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+03:00`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function darajaC2bSenderName(body) {
  const name = [body?.FirstName, body?.MiddleName, body?.LastName]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

app.post("/api/payments/c2b/validate/:c2bToken", c2bWebhookLimiter, async (req, res) => {
  const user = await prisma.user.findFirst({
    where: { c2bCallbackToken: req.params.c2bToken },
  });
  if (!user) {
    logger.warn("c2b", "validate: unknown token", { token: req.params.c2bToken?.slice(0, 8), reqId: req.reqId });
    return res.status(200).json({ ResultCode: 1, ResultDesc: "Rejected" });
  }
  logger.payment("c2b_validation_received", {
    shortcode: req.body?.BusinessShortCode || null,
    txnRef: req.body?.TransID || null,
    userId: user.id,
    reqId: req.reqId,
  });
  res.json(darajaC2bOk());
});

app.post("/api/payments/c2b/confirm/:c2bToken", c2bWebhookLimiter, async (req, res) => {
  const user = await prisma.user.findFirst({
    where: { c2bCallbackToken: req.params.c2bToken },
  });
  if (!user) {
    logger.warn("c2b", "confirm: unknown token - possible probe", {
      token: req.params.c2bToken?.slice(0, 8),
      ip: req.ip,
      reqId: req.reqId,
    });
    return res.json(darajaC2bOk());
  }

  const configuredSecret = process.env.MPESA_CALLBACK_SECRET;
  const headerSecret = req.get("x-mpesa-callback-secret") || null;
  if (configuredSecret && headerSecret && !timingSafeEqualString(headerSecret, configuredSecret)) {
    logger.warn("c2b", "confirm: secret header mismatch", { userId: user.id, reqId: req.reqId });
    return res.json(darajaC2bOk());
  }

  const body = req.body || {};
  const shortcode = String(body.BusinessShortCode || "").trim();
  if (shortcode && user.mpesaShortcode && shortcode !== String(user.mpesaShortcode).trim()) {
    logger.warn("c2b", "confirm: shortcode mismatch for token", {
      userId: user.id,
      tokenShortcode: user.mpesaShortcode,
      bodyShortcode: shortcode,
      reqId: req.reqId,
    });
    return res.json(darajaC2bOk());
  }

  const txnRef = String(body.TransID || "").trim();
  const amount = parseDarajaC2bAmount(body.TransAmount);
  const msisdn = findC2bPhoneCandidate(body);
  const phone = isSha256Hex(msisdn) ? null : normalizeMpesaMsisdn(msisdn);
  const billRef = String(body.BillRefNumber || "").trim() || null;
  const payerName = darajaC2bSenderName(body);
  const narration = String(body.TransactionDesc || billRef || "").trim();
  const transactionDate = parseDarajaTransTime(body.TransTime);
  const rawSafaricomMetadata = c2bRawMetadataWithDebugNote(body, msisdn);

  if (isSha256Hex(msisdn)) {
    logger.warn("c2b", "C2B MSISDN appears anonymized/hashed by provider", { txnRef, shortcode });
  }

  if (!phone && !isSha256Hex(msisdn)) {
    logger.warn("c2b", "C2B confirm missing payer phone", {
      txnRef,
      shortcode,
      bodyKeys: Object.keys(body),
      reqId: req.reqId,
    });
  }

  await prisma.mpesaCallbackLog.create({
    data: {
      userId: user.id,
      checkoutRequestId: txnRef || null,
      merchantRequestId: null,
      resultCode: 0,
      resultDesc: "C2B confirmation received",
      status: "received",
      rawCallback: scrubAuditValue(body),
      ipAddress: req.ip || null,
      userAgent: req.headers?.["user-agent"] || null,
    },
  }).catch(e => logger.warn("c2b", "Failed to log raw callback", { error: e.message, reqId: req.reqId }));

  if (!shortcode || !txnRef || !amount) {
    logger.warn("c2b", "Malformed C2B confirm - missing required fields", {
      userId: user.id,
      shortcode,
      txnRef,
      amount,
      reqId: req.reqId,
    });
    return res.json(darajaC2bOk());
  }

  try {
    const existingPayment = await prisma.payment.findFirst({ where: { userId: user.id, txnRef } });
    const existingUnmatched = await prisma.unmatchedPayment.findFirst({ where: { userId: user.id, txnRef } });
    const senderName = payerName || billRef || null;

    if (!existingPayment) {
      const match = await matchMpesaEvent({ userId: user.id, billRefNumber: billRef, payerName, narration, amount, phone });
      const unmatchedData = {
        phone: phone || (isSha256Hex(existingUnmatched?.phone) ? null : existingUnmatched?.phone) || null,
        senderName: senderName || existingUnmatched?.senderName || null,
        billRefNumber: billRef || existingUnmatched?.billRefNumber || null,
        txnRef,
        amount,
        userId: user.id,
        method: "mpesa",
        source: "c2b",
        transactionDate,
        rawSafaricomMetadata,
        matchStatus: match.matchStatus,
        matchConfidence: match.matchConfidence,
        matchReason: match.matchReason,
        matchedStudentId: match.matchedStudentId,
        suggestedStudentId: match.suggestedStudentId,
        suggestedReason: match.suggestedReason,
      };

      let shouldCreateUnmatched = !existingUnmatched;
      if (existingUnmatched) {
        await prisma.unmatchedPayment.update({ where: { id: existingUnmatched.id }, data: unmatchedData });
      }

      if (match.matchStatus === MATCH_STATUS.MATCHED && match.matchConfidence >= 95) {
        const matchedStudent = await prisma.student.findFirst({
          where: { id: match.matchedStudentId, userId: user.id },
        });
        if (matchedStudent) {
          try {
            const preLb = await deriveStudentBalance(matchedStudent.id);
            const paymentTerm = await activePaymentTerm(user.id);
            await prisma.$transaction(async (tx) => {
              const payment = await tx.payment.create({
                data: {
                  amount,
                  txnRef,
                  method: "mpesa",
                  feeBreakdown: [],
                  termId: paymentTerm?.id || null,
                  paymentTermId: paymentTerm?.id || null,
                  receivedAt: new Date(),
                  studentId: matchedStudent.id,
                  userId: user.id,
                  overpaymentAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                },
              });
              const newPaidVal = preLb.totalPaid + amount;
              await tx.student.update({
                where: { id: matchedStudent.id },
                data: { daysOverdue: newPaidVal >= preLb.totalCharges ? 0 : matchedStudent.daysOverdue, version: { increment: 1 } },
              });
              await allocatePaymentFIFO(payment.id, tx, preLb.outstanding);
              await tx.balanceLedger.create({
                data: {
                  studentId: matchedStudent.id,
                  userId: user.id,
                  paymentId: payment.id,
                  delta: amount,
                  balanceBefore: preLb.totalPaid,
                  balanceAfter: newPaidVal,
                  source: "payment",
                  note: "c2b_tokenised_confirm",
                },
              });
              if (Math.max(0, amount - Number(preLb.outstanding || 0)) > 0) {
                await tx.creditMemo.create({
                  data: {
                    studentId: matchedStudent.id,
                    userId: user.id,
                    termId: paymentTerm?.id || null,
                    sourcePaymentId: payment.id,
                    amount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                    remainingAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                    status: "available",
                    note: "Auto-generated from C2B overpayment",
                  },
                });
              }
            });

            if (existingUnmatched) {
              await prisma.unmatchedPayment.delete({ where: { id: existingUnmatched.id } }).catch(() => {});
            }

            logger.payment("c2b_confirmation_matched", { userId: user.id, shortcode, txnRef, amount, matchedStudentId: matchedStudent.id, reqId: req.reqId });
            await logAudit(req, {
              action: "c2b_confirmation_matched",
              entityType: "payment",
              schoolOwnerId: user.id,
              metadata: { txnRef, amount, phone, billRef, matchedStudentId: matchedStudent.id },
            });
            return res.json(darajaC2bOk());
          } catch (matchErr) {
            logger.error("c2b", "Auto-match transaction failed - saving as unmatched", {
              error: safeErrorMessage(matchErr),
              txnRef,
              matchedStudentId: match.matchedStudentId,
              reqId: req.reqId,
            });
          }
        }
      }

      if (shouldCreateUnmatched) {
        await prisma.unmatchedPayment.create({ data: unmatchedData });
      }
      await logAudit(req, {
        action: "c2b_confirmation_received",
        entityType: "unmatched_payment",
        schoolOwnerId: user.id,
        metadata: { txnRef, amount, phone, billRef, payerName, matchStatus: match.matchStatus, matchConfidence: match.matchConfidence },
      });
    }

    logger.payment("c2b_confirmation_received", { userId: user.id, shortcode, txnRef, amount, reqId: req.reqId });
    return res.json(darajaC2bOk());
  } catch (e) {
    logger.error("c2b", "C2B tokenised confirm processing failed", { error: safeErrorMessage(e), shortcode, txnRef, userId: user.id, reqId: req.reqId });
    return res.json(darajaC2bOk());
  }
});

app.post("/api/payments/c2b/validate", async (req, res) => {
  if (process.env.DISABLE_LEGACY_C2B === "true") {
    logger.warn("c2b", "LEGACY_C2B_DISABLED: validate rejected", {
      shortcode: req.body?.BusinessShortCode || null,
      reqId: req.reqId,
    });
    return res.json(darajaC2bOk());
  }

  const shortcode = String(req.body?.BusinessShortCode || "").trim();

  if (shortcode) {
    const user = await prisma.user.findFirst({ where: { mpesaShortcode: shortcode } });
    if (user?.c2bCallbackToken) {
      logger.warn("c2b", "DEPRECATED_LEGACY_C2B: tokenised school hit legacy validate. Update Daraja URLs.", {
        userId: user.id,
        shortcode,
        reqId: req.reqId,
      });
      return res.json(darajaC2bOk());
    }
  }

  logger.warn("c2b", "DEPRECATED: legacy C2B validate called. School has no token yet.", {
    shortcode: shortcode || null,
    txnRef: req.body?.TransID || null,
    reqId: req.reqId,
  });
  res.json(darajaC2bOk());
});

app.post("/api/payments/c2b/confirm", async (req, res) => {
  if (process.env.DISABLE_LEGACY_C2B === "true") {
    logger.warn("c2b", "LEGACY_C2B_DISABLED: confirm rejected", {
      shortcode: req.body?.BusinessShortCode || null,
      txnRef: req.body?.TransID || null,
      reqId: req.reqId,
    });
    return res.json(darajaC2bOk());
  }

  const body = req.body || {};
  const shortcode = String(body.BusinessShortCode || "").trim();
  const txnRef = String(body.TransID || "").trim();
  const amount = parseDarajaC2bAmount(body.TransAmount);
  const msisdn = findC2bPhoneCandidate(body);
  const phone = isSha256Hex(msisdn) ? null : normalizeMpesaMsisdn(msisdn);
  const billRefNumber = String(body.BillRefNumber || "").trim() || null;
  const payerName = darajaC2bSenderName(body);
  const narration = String(body.TransactionDesc || billRefNumber || "").trim();
  const transactionDate = parseDarajaTransTime(body.TransTime);
  const rawSafaricomMetadata = c2bRawMetadataWithDebugNote(body, msisdn);

  if (isSha256Hex(msisdn)) {
    logger.warn("c2b", "C2B MSISDN appears anonymized/hashed by provider", { txnRef, shortcode });
  }

  if (!phone && !isSha256Hex(msisdn)) {
    logger.warn("c2b", "C2B legacy confirm missing payer phone", {
      txnRef,
      shortcode,
      bodyKeys: Object.keys(body),
      reqId: req.reqId,
    });
  }

  try {
    if (!shortcode || !txnRef || !amount) {
      logger.warn("c2b", "Malformed C2B confirmation accepted without processing", { shortcode, txnRef, amount, reqId: req.reqId });
      return res.json(darajaC2bOk());
    }

    const user = await prisma.user.findFirst({ where: { mpesaShortcode: shortcode } });
    if (!user) {
      logger.warn("c2b", "C2B confirmation for unknown shortcode accepted", { shortcode, txnRef, reqId: req.reqId });
      return res.json(darajaC2bOk());
    }

    if (user?.c2bCallbackToken) {
      logger.warn("c2b", "DEPRECATED_LEGACY_C2B: tokenised school hit legacy confirm. Possible replay or stale Daraja config.", {
        userId: user.id,
        shortcode,
        txnRef,
        amount,
        reqId: req.reqId,
      });
      await prisma.mpesaCallbackLog.create({
        data: {
          userId: user.id,
          checkoutRequestId: txnRef || null,
          merchantRequestId: null,
          resultCode: -1,
          resultDesc: "Rejected: legacy endpoint called for tokenised school",
          status: "rejected_legacy",
          rawCallback: scrubAuditValue(req.body || {}),
          ipAddress: req.ip || null,
          userAgent: req.headers?.["user-agent"] || null,
        },
      }).catch(e => logger.warn("c2b", "Failed to log rejected legacy callback", { error: e.message }));

      await logAudit(req, {
        action: "c2b_legacy_rejected_tokenised_school",
        entityType: "mpesa_callback",
        schoolOwnerId: user.id,
        metadata: { shortcode, txnRef, amount, reason: "school_has_token" },
      });

      return res.json(darajaC2bOk());
    }

    logger.warn("c2b", "DEPRECATED: legacy C2B confirm called for untokenised school", {
      userId: user.id,
      shortcode,
      txnRef,
      reqId: req.reqId,
    });

    const existingPayment = await prisma.payment.findFirst({ where: { userId: user.id, txnRef } });
    const existingUnmatched = await prisma.unmatchedPayment.findFirst({ where: { userId: user.id, txnRef } });
    const senderName = payerName || billRefNumber || null;

    if (!existingPayment) {
      const match = await matchMpesaEvent({ userId: user.id, billRefNumber, payerName, narration, amount, phone });
      const unmatchedData = {
        phone: phone || (isSha256Hex(existingUnmatched?.phone) ? null : existingUnmatched?.phone) || null,
        senderName: senderName || existingUnmatched?.senderName || null,
        billRefNumber: billRefNumber || existingUnmatched?.billRefNumber || null,
        txnRef,
        amount,
        userId: user.id,
        method: "mpesa",
        source: "c2b",
        transactionDate,
        rawSafaricomMetadata,
        matchStatus: match.matchStatus,
        matchConfidence: match.matchConfidence,
        matchReason: match.matchReason,
        matchedStudentId: match.matchedStudentId,
        suggestedStudentId: match.suggestedStudentId,
        suggestedReason: match.suggestedReason,
      };

      let shouldCreateUnmatched = !existingUnmatched;
      if (existingUnmatched) {
        await prisma.unmatchedPayment.update({ where: { id: existingUnmatched.id }, data: unmatchedData });
      }

      if (match.matchStatus === MATCH_STATUS.MATCHED && match.matchConfidence >= 95) {
        const matchedStudent = await prisma.student.findFirst({ where: { id: match.matchedStudentId, userId: user.id } });
        if (matchedStudent) {
          try {
            const preLb = await deriveStudentBalance(matchedStudent.id);
            const paymentTerm = await activePaymentTerm(user.id);
            await prisma.$transaction(async (tx) => {
              const payment = await tx.payment.create({
                data: {
                  amount,
                  txnRef,
                  method: "mpesa",
                  feeBreakdown: [],
                  termId: paymentTerm?.id || null,
                  paymentTermId: paymentTerm?.id || null,
                  receivedAt: new Date(),
                  studentId: matchedStudent.id,
                  userId: user.id,
                  overpaymentAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                },
              });
              const newPaidVal = preLb.totalPaid + amount;
              await tx.student.update({ where: { id: matchedStudent.id }, data: { daysOverdue: newPaidVal >= preLb.totalCharges ? 0 : matchedStudent.daysOverdue, version: { increment: 1 } } });
              await allocatePaymentFIFO(payment.id, tx, preLb.outstanding);
              await tx.balanceLedger.create({
                data: {
                  studentId: matchedStudent.id,
                  userId: user.id,
                  paymentId: payment.id,
                  delta: amount,
                  balanceBefore: preLb.totalPaid,
                  balanceAfter: newPaidVal,
                  source: "payment",
                  note: "c2b_confirmation",
                },
              });
              if (Math.max(0, amount - Number(preLb.outstanding || 0)) > 0) {
                await tx.creditMemo.create({
                  data: {
                    studentId: matchedStudent.id,
                    userId: user.id,
                    termId: paymentTerm?.id || null,
                    sourcePaymentId: payment.id,
                    amount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                    remainingAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                    status: "available",
                    note: "Auto-generated from C2B overpayment",
                  },
                });
              }
            });

            if (existingUnmatched) {
              await prisma.unmatchedPayment.delete({ where: { id: existingUnmatched.id } }).catch(() => {});
            }

            logger.payment("c2b_confirmation_matched", { userId: user.id, shortcode, txnRef, amount, matchedStudentId: matchedStudent.id, reqId: req.reqId });
            await logAudit(req, {
              action: "c2b_confirmation_matched",
              entityType: "payment",
              schoolOwnerId: user.id,
              metadata: { txnRef, amount, phone, billRefNumber, matchedStudentId: matchedStudent.id },
            });
            return res.json(darajaC2bOk());
          } catch (matchErr) {
            logger.error("c2b", "Auto-match transaction failed - saving as unmatched", {
              error: safeErrorMessage(matchErr),
              txnRef,
              matchedStudentId: match.matchedStudentId,
              reqId: req.reqId,
            });
          }
        }
      }

      if (shouldCreateUnmatched) {
        await prisma.unmatchedPayment.create({ data: unmatchedData });
      }
      await logAudit(req, {
        action: "c2b_confirmation_received",
        entityType: "unmatched_payment",
        schoolOwnerId: user.id,
        metadata: { txnRef, amount, phone, billRefNumber, payerName, matchStatus: match.matchStatus, matchConfidence: match.matchConfidence },
      });
    }

    logger.payment("c2b_confirmation_received", { userId: user.id, shortcode, txnRef, amount, reqId: req.reqId });
    return res.json(darajaC2bOk());
  } catch (e) {
    logger.error("c2b", "C2B confirmation processing failed", { error: safeErrorMessage(e), shortcode, txnRef, reqId: req.reqId });
    return res.json(darajaC2bOk());
  }
});

app.post("/api/mpesa/callback/:userId", async (req, res) => {
  const configuredSecret = process.env.MPESA_CALLBACK_SECRET;
  // Accept secret via header ONLY -- never from query string.
  // Query params appear in access logs and proxy logs.
  // The new /api/mpesa/stk-cb/:secret/:userId route is preferred.
  // This legacy route remains for backwards compatibility only.
  const suppliedSecret = req.get("x-mpesa-callback-secret") || null;

  // If a secret is configured but the caller used the old query param style,
  // log a migration warning but still reject -- force migration to header or
  // new path route.
  if (configuredSecret && req.query.secret && !suppliedSecret) {
    logger.warn("callback", "Legacy callback: secret supplied via query param (insecure). Migrate to /api/mpesa/stk-cb/ path route.", {
      userId: req.params.userId,
      reqId: req.reqId,
    });
    await logAudit(req, {
      action: "mpesa_callback_rejected",
      entityType: "mpesa_callback",
      schoolOwnerId: req.params.userId,
      metadata: { reason: "secret_in_query_param_not_accepted" },
    });
    return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized callback" });
  }
  if (configuredSecret && (!suppliedSecret || !timingSafeEqualString(suppliedSecret, configuredSecret))) {
    await logAudit(req, { action: "mpesa_callback_rejected", entityType: "mpesa_callback", schoolOwnerId: req.params.userId, metadata: { reason: "invalid_secret" } });
    return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized callback" });
  }
  const incomingCallback = req.body?.Body?.stkCallback;
  const missing = ["MerchantRequestID", "CheckoutRequestID", "ResultCode", "ResultDesc"].filter(field => incomingCallback?.[field] === undefined || incomingCallback?.[field] === null);
  if (missing.length) {
    await logAudit(req, { action: "mpesa_callback_rejected", entityType: "mpesa_callback", schoolOwnerId: req.params.userId, metadata: { reason: "missing_fields", missing } });
    return res.status(400).json({ ResultCode: 1, ResultDesc: "Malformed callback" });
  }

  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  processMpesaCallback(req.body, req.params.userId, req).catch(e =>
    console.error("[CALLBACK] Unhandled processing error:", e)
  );
});

app.post("/api/mpesa/stk-cb/:secret/:userId", async (req, res) => {
  const configuredSecret = process.env.MPESA_CALLBACK_SECRET;
  if (!configuredSecret || !timingSafeEqualString(req.params.secret, configuredSecret)) {
    await logAudit(req, {
      action: "mpesa_callback_rejected",
      entityType: "mpesa_callback",
      schoolOwnerId: req.params.userId,
      metadata: { reason: "invalid_path_secret" },
    });
    return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized" });
  }

  const incomingCallback = req.body?.Body?.stkCallback;
  const missing = ["MerchantRequestID", "CheckoutRequestID", "ResultCode", "ResultDesc"]
    .filter(field => incomingCallback?.[field] === undefined || incomingCallback?.[field] === null);
  if (missing.length) {
    await logAudit(req, {
      action: "mpesa_callback_rejected",
      entityType: "mpesa_callback",
      schoolOwnerId: req.params.userId,
      metadata: { reason: "missing_fields", missing },
    });
    return res.status(400).json({ ResultCode: 1, ResultDesc: "Malformed callback" });
  }

  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  processMpesaCallback(req.body, req.params.userId, req).catch(e =>
    logger.error("callback", "Unhandled processing error in stk-cb", { error: e.message })
  );
});

async function processMpesaCallback(body, callbackUserId, req = null) {
  const cb = body?.Body?.stkCallback;

  if (!cb || typeof cb.ResultCode === "undefined") {
    logger.warn("callback", "Malformed payload — missing stkCallback", {
      bodyPreview: JSON.stringify(scrubAuditValue(body || {})).slice(0, 200),
      callbackUserId,
    });
    return;
  }

  const checkoutId = cb.CheckoutRequestID;
  const resultCode = Number(cb.ResultCode);
  const codeInfo = SAFARICOM_CODES[resultCode] || { status: "failed", msg: cb.ResultDesc || "Payment was not completed." };
  const accountStudentId = (cb.AccountReference || "").replace(/^FF-/, "");
  const txn = checkoutId
    ? await prisma.mpesaTransaction.findFirst({
        where: {
          checkoutRequestId: checkoutId,
          userId: callbackUserId,   // scope to callback owner, never global
        },
      })
    : null;

  // If no transaction found under the callback owner, check if it exists
  // under a DIFFERENT owner -- this is a cross-tenant mismatch and is
  // suspicious. Log and abort rather than process.
  if (!txn && checkoutId) {
    const crossTenantTxn = await prisma.mpesaTransaction.findFirst({
      where: { checkoutRequestId: checkoutId },
    });
    if (crossTenantTxn) {
      logger.warn("callback", "Cross-tenant checkoutId detected -- possible replay attack", {
        checkoutId,
        callbackUserId,
        actualOwner: crossTenantTxn.userId,
      });
      await logAudit(null, {
        action: "mpesa_callback_cross_tenant",
        entityType: "mpesa_transaction",
        entityId: checkoutId,
        schoolOwnerId: callbackUserId,
        metadata: {
          reason: "checkoutId_belongs_to_different_tenant",
          actualOwner: crossTenantTxn.userId,
        },
      });
      return; // abort -- do not process
    }
  }

  await prisma.mpesaCallbackLog.create({
    data: {
      userId: txn?.userId || callbackUserId,
      checkoutRequestId: checkoutId,
      merchantRequestId: cb.MerchantRequestID || null,
      resultCode,
      resultDesc: cb.ResultDesc || null,
      status: "received",
      rawCallback: scrubAuditValue(body || {}),
      ipAddress: req?.ip || null,
      userAgent: req?.headers?.["user-agent"] || null,
    },
  }).catch(e => logger.warn("callback", "Failed to persist callback log", { error: e.message, checkoutId }));

  logger.payment("mpesa_callback_received", { checkoutId, resultCode, status: codeInfo.status, userId: callbackUserId });

  await logAudit(null, { action: "mpesa_callback_received", entityType: "mpesa_transaction", entityId: checkoutId, schoolOwnerId: txn?.userId || callbackUserId, metadata: { checkoutRequestId: checkoutId, resultCode, resultStatus: codeInfo.status, accountReference: cb.AccountReference } });

  if (resultCode === 0) {
    const items = cb.CallbackMetadata?.Item || [];
    const get = n => items.find(i => i.Name === n)?.Value;
    const amount = parseFloat(get("Amount"));
    const ref = get("MpesaReceiptNumber");
    const phone = get("PhoneNumber")?.toString();

    if (!amount || !ref || !phone) {
      logger.error("callback", "Success callback missing amount or ref — skipping", {
        checkoutId,
        hasAmount: !!amount,
        hasRef: !!ref,
        hasPhone: !!phone,
        callbackUserId,
      });
      await logAudit(req, { action: "mpesa_callback_suspicious", entityType: "mpesa_transaction", entityId: checkoutId, schoolOwnerId: txn?.userId || callbackUserId, metadata: { reason: "missing_success_metadata", amount, ref, phone } });
      return;
    }

    const alreadyProcessed = await prisma.payment.findFirst({ where: { txnRef: ref } });
    if (alreadyProcessed) {
      await prisma.mpesaTransaction.updateMany({
        where: { checkoutRequestId: checkoutId, userId: alreadyProcessed.userId, status: { notIn: ["success", "reversed"] } },
        data: { status: "success", mpesaRef: ref, callbackReceivedAt: new Date(), resolvedAt: new Date() },
      }).catch(() => {});
      console.log(`[CALLBACK] Duplicate — ${ref} already processed`);
      return;
    }

    let verifiedUserId = callbackUserId;
    let verifiedStudentId = null;
    let student = null;

    if (!txn) {
      logger.warn("callback", "M-Pesa transaction missing; attempting fallback matching", { checkoutId, callbackUserId, accountStudentId });
      await logAudit(req, { action: "mpesa_callback_suspicious", entityType: "mpesa_transaction", entityId: checkoutId, schoolOwnerId: callbackUserId, metadata: { reason: "no_pending_transaction", accountStudentId } });
      const callbackUser = await prisma.user.findUnique({ where: { id: callbackUserId } });
      if (callbackUser) {
        const match = await matchMpesaEvent({ userId: callbackUserId, billRefNumber: cb.AccountReference || null, payerName: null, narration: cb.AccountReference || null, amount, phone });
        if (match.matchStatus === MATCH_STATUS.MATCHED && match.matchConfidence >= 95) {
          const matchedStudent = await prisma.student.findFirst({ where: { id: match.matchedStudentId, userId: callbackUserId } });
          if (matchedStudent) {
            const preLb = await deriveStudentBalance(matchedStudent.id);
            const paymentTerm = await activePaymentTerm(callbackUserId);
            try {
              await prisma.$transaction(async (tx) => {
                const payment = await tx.payment.create({
                  data: {
                    amount,
                    txnRef: ref,
                    method: "mpesa",
                    feeBreakdown: [],
                    termId: paymentTerm?.id || null,
                    paymentTermId: paymentTerm?.id || null,
                    receivedAt: new Date(),
                    studentId: matchedStudent.id,
                    userId: callbackUserId,
                    overpaymentAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                  },
                });
                const newPaidVal = preLb.totalPaid + amount;
                await tx.student.update({ where: { id: matchedStudent.id }, data: { daysOverdue: newPaidVal >= preLb.totalCharges ? 0 : matchedStudent.daysOverdue, version: { increment: 1 } } });
                await allocatePaymentFIFO(payment.id, tx, preLb.outstanding);
                await tx.balanceLedger.create({
                  data: {
                    studentId: matchedStudent.id,
                    userId: callbackUserId,
                    paymentId: payment.id,
                    delta: amount,
                    balanceBefore: preLb.totalPaid,
                    balanceAfter: newPaidVal,
                    source: "payment",
                    note: "mpesa_callback_fallback",
                  },
                });
                if (Math.max(0, amount - Number(preLb.outstanding || 0)) > 0) {
                  await tx.creditMemo.create({
                    data: {
                      studentId: matchedStudent.id,
                      userId: callbackUserId,
                      termId: paymentTerm?.id || null,
                      sourcePaymentId: payment.id,
                      amount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                      remainingAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
                      status: "available",
                      note: "Auto-generated from M-Pesa fallback matching",
                    },
                  });
                }
              });
              logger.payment("mpesa_callback_fallback_matched", { checkoutId, ref, amount, matchedStudentId: matchedStudent.id, userId: callbackUserId });
              await logAudit(req, {
                action: "mpesa_callback_fallback_matched",
                entityType: "payment",
                schoolOwnerId: callbackUserId,
                metadata: { checkoutId, ref, amount, matchedStudentId: matchedStudent.id, accountReference: cb.AccountReference, matchReason: match.matchReason },
              });
              return;
            } catch (fallbackErr) {
              logger.error("callback", "M-Pesa fallback transaction failed", { error: safeErrorMessage(fallbackErr), checkoutId, ref });
            }
          }
        }

        await prisma.unmatchedPayment.create({
          data: {
            phone,
            senderName: null,
            billRefNumber: cb.AccountReference || null,
            txnRef: ref,
            amount,
            userId: callbackUserId,
            method: "mpesa",
            source: "stk",
            transactionDate: new Date(),
            matchStatus: match.matchStatus,
            matchConfidence: match.matchConfidence,
            matchReason: match.matchReason,
            matchedStudentId: match.matchedStudentId,
            suggestedStudentId: match.suggestedStudentId,
            suggestedReason: match.suggestedReason,
          },
        });
        logger.warn("callback", "Unmatched payment stored", { ref, accountRef: cb.AccountReference, amount, userId: callbackUserId, matchStatus: match.matchStatus, matchReason: match.matchReason });
      }
      return;
    }

    if (txn) {
      if (!["pending", "awaiting_callback", "processing", "callback_delayed"].includes(txn.status)) {
        logger.info("callback", "Duplicate/already resolved M-Pesa callback ignored", { checkoutId, status: txn.status });
        return;
      }
      if (txn.userId !== callbackUserId) {
        logger.warn("callback", "M-Pesa callback tenant mismatch", { checkoutId, callbackUserId, txnUserId: txn.userId, txnStudentId: txn.studentId, accountStudentId });
        await prisma.mpesaTransaction.updateMany({
          where: { checkoutRequestId: checkoutId, userId: txn.userId },
          data: { status: "reconciliation_required", resultCode, resultDesc: "Callback tenant mismatch", callbackReceivedAt: new Date(), resolvedAt: new Date() },
        }).catch(() => {});
        return;
      }

      if (Math.round(Number(amount)) !== Math.round(Number(txn.amount)) || String(phone).slice(-9) !== String(txn.phone).slice(-9)) {
        logger.warn("callback", "M-Pesa callback amount/phone mismatch", { checkoutId, expectedAmount: txn.amount, gotAmount: amount, userId: callbackUserId });
        await logAudit(req, { action: "mpesa_callback_suspicious", entityType: "mpesa_transaction", entityId: checkoutId, schoolOwnerId: txn.userId, metadata: { reason: "amount_or_phone_mismatch", expectedAmount: txn.amount, gotAmount: amount } });
        await prisma.mpesaTransaction.updateMany({
          where: { checkoutRequestId: checkoutId, userId: txn.userId },
          data: { status: "reconciliation_required", resultCode, resultDesc: "Callback amount or phone mismatch", callbackReceivedAt: new Date(), resolvedAt: new Date() },
        }).catch(() => {});
        return;
      }

      if (accountStudentId && accountStudentId !== txn.studentId) {
        logger.warn("callback", "M-Pesa callback student reference mismatch", { checkoutId, userId: callbackUserId, txnStudentId: txn.studentId, accountStudentId });
        await prisma.mpesaTransaction.updateMany({
          where: { checkoutRequestId: checkoutId, userId: callbackUserId },
          data: { status: "reconciliation_required", resultCode, resultDesc: "Callback student reference mismatch", callbackReceivedAt: new Date(), resolvedAt: new Date() },
        }).catch(() => {});
        return;
      }

      verifiedUserId = txn.userId;
      verifiedStudentId = txn.studentId;
      student = await prisma.student.findFirst({ where: { id: verifiedStudentId, userId: verifiedUserId } });

      if (!student) {
        logger.warn("callback", "M-Pesa transaction student not found for verified tenant", { checkoutId, userId: verifiedUserId, studentId: verifiedStudentId });
        await prisma.mpesaTransaction.updateMany({
          where: { checkoutRequestId: checkoutId, userId: verifiedUserId },
          data: { status: "reconciliation_required", resultCode, resultDesc: "Verified student not found", callbackReceivedAt: new Date(), resolvedAt: new Date() },
        }).catch(() => {});
        return;
      }
    }

    if (student) {
      const preLb = await deriveStudentBalance(verifiedStudentId);
      const paymentTerm = await activePaymentTerm(verifiedUserId);

      let payment, newPaid;
      try {
        const result = await prisma.$transaction(async (tx) => {
          const p = await tx.payment.create({
            data: {
              amount, txnRef: ref, method: "mpesa", feeBreakdown: [],
              termId: paymentTerm?.id || null,
              paymentTermId: paymentTerm?.id || null,
              receivedAt: new Date(),
              studentId: verifiedStudentId, userId: verifiedUserId,
              overpaymentAmount: Math.max(0, amount - Number(preLb.outstanding || 0)),
            },
          });
          const newPaidVal = preLb.totalPaid + amount;
          const excess = Math.max(0, amount - Number(preLb.outstanding || 0));
          await tx.student.update({
            where: { id: verifiedStudentId },
            data: { daysOverdue: newPaidVal >= preLb.totalCharges ? 0 : student.daysOverdue, version: { increment: 1 } },
          });
          await allocatePaymentFIFO(p.id, tx, preLb.outstanding);
          await tx.balanceLedger.create({
            data: {
              studentId: verifiedStudentId, userId: verifiedUserId,
              paymentId: p.id, delta: amount,
              balanceBefore: preLb.totalPaid,
              balanceAfter: newPaidVal,
              source: "payment",
              note: "mpesa_callback:" + ref,
            },
          });
          if (excess > 0) {
            await tx.creditMemo.create({
              data: { studentId: verifiedStudentId, userId: verifiedUserId, termId: paymentTerm?.id || null, sourcePaymentId: p.id, amount: excess, remainingAmount: excess, status: "available", note: "Auto-generated from M-Pesa overpayment" },
            });
          }
          await tx.mpesaTransaction.updateMany({
            where: { checkoutRequestId: checkoutId, userId: verifiedUserId, status: { notIn: ["success", "reversed"] } },
            data: { status: "success", mpesaRef: ref, callbackReceivedAt: new Date(), resolvedAt: new Date() },
          });
          return { payment: p, newPaid: newPaidVal, excess };
        });
        payment = result.payment;
        newPaid = result.newPaid;

        if (result.excess > 0) {
          logger.warn("callback", "Overpayment → CreditMemo created", { studentId: verifiedStudentId, excess: result.excess, ledgerCharges: preLb.totalCharges, newTotalPaid: newPaid, txnRef: ref });
          logAudit(null, { action: "overpayment_detected", entityType: "payment", entityId: payment.id, schoolOwnerId: verifiedUserId, metadata: { studentId: verifiedStudentId, excess: result.excess, newPaid, totalCharges: preLb.totalCharges, txnRef: ref, source: "mpesa_callback" } });
        }

        logger.payment("mpesa_payment_recorded", { txnRef: ref, amount, studentId: verifiedStudentId, newPaid, userId: verifiedUserId });
        logger.payment("mpesa_tenant_verified_payment_recorded", { checkoutId, txnRef: ref, amount, studentId: verifiedStudentId, userId: verifiedUserId, source: txn ? "mpesaTransaction" : "accountReferenceFallback" });
      } catch (txErr) {
        if (txErr?.code === "P2002") {
          logger.warn("callback", "DB unique constraint caught duplicate callback", { checkoutId, ref });
          await prisma.mpesaTransaction.updateMany({
            where: { checkoutRequestId: checkoutId, userId: verifiedUserId, status: { notIn: ["success", "reversed"] } },
            data: { status: "success", mpesaRef: ref, callbackReceivedAt: new Date(), resolvedAt: new Date() },
          }).catch(() => {});
          return;
        }
        logger.error("callback", "Transaction failed — marking reconciliation_required", { error: txErr.message, checkoutId, ref });
        await prisma.mpesaTransaction.updateMany({ where: { checkoutRequestId: checkoutId, userId: verifiedUserId }, data: { status: "reconciliation_required" } }).catch(() => {});
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: verifiedUserId } });
      if (user && PLAN_LIMITS[user?.plan]?.receipts) {
        autoSendReceipt({ payment, student, user }).catch(e => logger.error("receipt", e.message));
      }
    } else {
      const user = await prisma.user.findUnique({ where: { id: callbackUserId } });
      if (user) {
        await prisma.unmatchedPayment.create({ data: { phone, senderName: null, billRefNumber: cb.AccountReference || null, txnRef: ref, amount, userId: user.id, method: "mpesa", source: "stk" } });
        logger.warn("callback", "Unmatched payment stored", { ref, accountRef: cb.AccountReference, amount, userId: callbackUserId });
      }
    }
  } else {
    const statusUserId = txn?.userId || callbackUserId;
    await prisma.mpesaTransaction.updateMany({
      where: { checkoutRequestId: checkoutId, userId: statusUserId, status: { notIn: ["success", "reversed"] } },
      data: { status: codeInfo.status, resultCode, resultDesc: codeInfo.msg || cb.ResultDesc || "Payment not completed", callbackReceivedAt: new Date(), resolvedAt: new Date() },
    }).catch(e => logger.error("callback", "Failed to update transaction status", { error: e.message }));

    console.log(`[CALLBACK] Failure stored — ${checkoutId}: ${codeInfo.status} (${resultCode})`);
  }
}
// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatPhoneAT(phone) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("254")) return "+" + clean;
  if (clean.startsWith("0"))   return "+254" + clean.slice(1);
  if (clean.startsWith("7") || clean.startsWith("1")) return "+254" + clean;
  return "+" + clean;
}

function normalizeSafaricomStkPhone(phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  let normalized = clean;
  if (clean.startsWith("0")) normalized = "254" + clean.slice(1);
  else if (clean.startsWith("7")) normalized = "254" + clean;
  else if (clean.startsWith("1")) normalized = "254" + clean;
  else if (clean.startsWith("254")) normalized = clean;

  const valid = /^254[17]\d{8}$/.test(normalized);
  if (process.env.NODE_ENV === "development") {
    console.debug("[STK Phone Validation]", {
      rawPhone: phone,
      cleanedPhone: clean,
      normalizedPhone: normalized,
      valid,
    });
  }

  return valid ? normalized : null;
}

function maskSafaricomPhone(phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length < 7) return "[invalid-phone]";
  return clean.slice(0, 4) + "****" + clean.slice(-3);
}

function redactCallbackUrl(url) {
  return redactPathTokens(String(url || "")
    .replace(/([?&]secret=)[^&]+/i, "$1[redacted]")
    .replace(/(\/mpesa\/stk-cb\/)[^/]+/i, "$1[redacted]"));
}

function darajaStkErrorPayload(body, fallbackMessage = "STK push failed. Please try again.") {
  const payload = {
    errorCode: body?.errorCode || null,
    errorMessage: body?.errorMessage || null,
    ResponseCode: body?.ResponseCode || null,
    ResponseDescription: body?.ResponseDescription || null,
  };
  return {
    message: payload.errorMessage || payload.ResponseDescription || fallbackMessage,
    ...payload,
  };
}

function adminStkStatus(status) {
  if (status === "success") return "SUCCESS";
  if (status === "cancelled_by_user") return "CANCELLED";
  if (status === "timeout") return "TIMEOUT";
  if (["pending", "awaiting_callback", "processing", "callback_delayed"].includes(status)) return "PENDING";
  return "FAILED";
}

function genToken() { return crypto.randomBytes(8).toString("hex"); }

// XSS protection — escape all user-supplied strings before inserting into HTML
function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function nextReceiptNo(userId) {
  const seq = await prisma.$transaction(async (tx) => {
    const initialRows = await tx.$queryRaw`
      SELECT COALESCE(MAX(CASE
        WHEN "receiptNo" ~ '^RCP-[0-9]+$' THEN SUBSTRING("receiptNo" FROM 5)::integer
        ELSE 0
      END), 0) + 1 AS "nextVal"
      FROM "Receipt"
      WHERE "userId" = ${userId}
    `;
    return nextSequenceValueTx(tx, "receipt:" + userId, Number(initialRows[0]?.nextVal || 1));
  });
  return "RCP-" + String(seq).padStart(4, "0");
}

async function nextInvoiceNo(userId) {
  return prisma.$transaction(async (tx) => {
    const initialRows = await tx.$queryRaw`
      SELECT COALESCE(MAX("invoiceNo"), 0) + 1 AS "nextVal"
      FROM "Invoice"
      WHERE "userId" = ${userId}
    `;
    return nextSequenceValueTx(tx, "invoice:" + userId, Number(initialRows[0]?.nextVal || 1));
  });
}

async function nextSequenceValueTx(tx, id, initialValue = 1) {
  await tx.$executeRaw`
    INSERT INTO "Sequence" ("id", "nextVal") VALUES (${id}, ${initialValue})
    ON CONFLICT ("id") DO NOTHING
  `;
  const rows = await tx.$queryRaw`
    SELECT "nextVal" FROM "Sequence" WHERE "id" = ${id} FOR UPDATE
  `;
  const current = rows[0]?.nextVal;
  if (!Number.isInteger(current)) throw new Error("Sequence row missing for " + id);
  await tx.sequence.update({ where: { id }, data: { nextVal: current + 1 } });
  return current;
}

function publicInvoiceLink(token) {
  return backendPublicBaseUrl() + "/i/" + token;
}

function publicReceiptLink(token) {
  return backendPublicBaseUrl() + "/r/" + token;
}

function paymentMethodLabel(method) {
  return method === "mpesa" ? "M-Pesa" : method === "bank" ? "Bank Transfer" : method === "cash" || method === "manual" ? "Cash" : String(method || "Payment");
}

function dateTimeKE(value) {
  return value ? new Date(value).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "N/A";
}

function renderEmailLayout({ schoolName, schoolLogoUrl, schoolTagline, title, bodyHtml, ctaText, link, accent = "#003366" }) {
  const safeLink = escHtml(link);
  const emailLogoUrl = /^https?:\/\//i.test(String(schoolLogoUrl || "")) ? schoolLogoUrl : null;
  const logo = emailLogoUrl
    ? "<img src='" + escHtml(emailLogoUrl) + "' alt='' style='width:72px;height:72px;border-radius:12px;object-fit:contain;display:block;background:#fff;padding:4px;margin-right:12px;vertical-align:middle'>"
    : "";
  return "<div style='margin:0;padding:0;background:#f3f6fb;font-family:Arial,Inter,sans-serif;color:#162033'>"
    + "<div style='max-width:620px;margin:0 auto;padding:24px 14px'>"
    + "<div style='text-align:center;margin-bottom:14px;font-size:13px;font-weight:800;letter-spacing:1px;color:#059669'>FEEFLOW<div style='font-size:11px;font-weight:400;color:#718096;margin-top:2px'>Secure school fee communication</div></div>"
    + "<div style='background:#fff;border:1px solid #dce5f2;border-radius:12px;overflow:hidden;box-shadow:0 8px 28px rgba(15,31,58,.08)'>"
    + "<div style='background:" + accent + ";color:#fff;padding:20px 24px'><div style='display:flex;align-items:center'>" + logo + "<div><div style='font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.82'>" + escHtml(schoolName || "School") + "</div>" + (schoolTagline ? "<div style='font-size:12px;opacity:.82;margin-top:2px'>" + escHtml(schoolTagline) + "</div>" : "") + "<div style='font-size:20px;font-weight:800;margin-top:4px'>" + escHtml(title) + "</div></div></div></div>"
    + "<div style='padding:24px;font-size:14px;line-height:1.65;color:#26364f'>" + bodyHtml
    + "<div style='margin:22px 0 14px'><a href='" + safeLink + "' style='display:inline-block;background:" + accent + ";color:#fff;text-decoration:none;border-radius:8px;padding:12px 20px;font-weight:800'>" + escHtml(ctaText) + "</a></div>"
    + "<div style='font-size:12px;color:#718096;line-height:1.5'>If the button does not open, use this secure link:<br><a href='" + safeLink + "' style='color:" + accent + ";word-break:break-all'>" + safeLink + "</a></div>"
    + "</div></div>"
    + "<div style='text-align:center;color:#94a3b8;font-size:11px;margin-top:14px'>Sent via FeeFlow</div>"
    + "</div></div>";
}

function renderInvoiceSms({ studentName, className, totalDueNow, dueDate, token, paymentRef }) {
  const link = publicInvoiceLink(token);
  const dueFmt = dueDate ? new Date(dueDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : "N/A";
  return "Dear Parent, school fee reminder for " + studentName + " (" + className + "). Amount due: KES " + fmtKE(totalDueNow) + ". Due: " + dueFmt + ". Bank payment ref: " + (paymentRef || "N/A") + ". View full invoice/payment details: " + link;
}

function renderReceiptSms({ studentName, amount, token, txnRef, balance }) {
  const link = publicReceiptLink(token);
  return "Dear Parent, payment received for " + studentName + ": KES " + fmtKE(amount) + ". Ref: " + (txnRef || "N/A") + ". Balance: KES " + fmtKE(balance) + ". View official receipt: " + link;
}

function renderInvoiceEmail({ schoolName, schoolLogoUrl, schoolTagline, schoolPrimaryColor, studentName, className, totalDueNow, dueDate, token, paymentRef }) {
  const link = publicInvoiceLink(token);
  const dueFmt = fmtDateKE(dueDate);
  const body = "<p style='margin:0 0 14px'>Dear Parent/Guardian,</p>"
    + "<p style='margin:0 0 14px'>We would like to remind you that there is a pending school fee balance for <strong>" + escHtml(studentName) + "</strong> in <strong>" + escHtml(className || "Class") + "</strong>. The total amount currently due is <strong>KES " + fmtKE(totalDueNow) + "</strong>, payable by <strong>" + escHtml(dueFmt) + "</strong>.</p>"
    + "<div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:16px 0'><strong>Bank payment reference:</strong> <span style='font-family:monospace;font-weight:800'>" + escHtml(paymentRef || "N/A") + "</span><br><span style='font-size:12px;color:#64748b'>Please include this reference in the bank narration/reference so the payment is reconciled accurately.</span></div>"
    + "<p style='margin:0 0 14px'>Please access the full invoice and payment details using the secure FeeFlow link below.</p>"
    + "<p style='margin:0'>Thank you.</p>";
  return renderEmailLayout({ schoolName, schoolLogoUrl, schoolTagline, title: "School Fee Reminder", bodyHtml: body, ctaText: "View Invoice", link, accent: DOC_PRIMARY });
}

function renderReceiptEmail({ schoolName, schoolLogoUrl, schoolTagline, schoolPrimaryColor, studentName, className, admNo, amount, method, token, txnRef, paidAt, balance, parentName, parentPhone }) {
  const link = publicReceiptLink(token);
  const paidBy = parentName || parentPhone || "N/A";
  const methodFmt = paymentMethodLabel(method);
  const body = "<p style='margin:0 0 14px'>Dear Parent/Guardian,</p>"
    + "<p style='margin:0 0 14px'>We have received a payment of <strong>KES " + fmtKE(amount) + "</strong> for <strong>" + escHtml(studentName) + "</strong> in <strong>" + escHtml(className || "Class") + "</strong>.</p>"
    + "<div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:16px 0'>"
    + "<div><strong>Payment Method:</strong> " + escHtml(methodFmt) + "</div>"
    + "<div><strong>Reference:</strong> " + escHtml(txnRef || "N/A") + "</div>"
    + "<div><strong>Paid By:</strong> " + escHtml(paidBy) + "</div>"
    + "<div><strong>Date &amp; Time:</strong> " + escHtml(dateTimeKE(paidAt)) + "</div>"
    + (admNo ? "<div><strong>Admission No:</strong> " + escHtml(admNo) + "</div>" : "")
    + "<div><strong>Remaining Balance:</strong> KES " + fmtKE(balance) + "</div>"
    + "</div>"
    + "<p style='margin:0 0 14px'>Please access the official receipt using the secure FeeFlow link below.</p>"
    + "<p style='margin:0'>Thank you.</p>";
  return renderEmailLayout({ schoolName, schoolLogoUrl, schoolTagline, title: "Payment Receipt", bodyHtml: body, ctaText: "View Receipt", link, accent: DOC_PRIMARY });
}

function buildInvoiceMessage({ studentName, className, totalFee, totalDueNow, dueDate, token, paymentRef }) {
  return renderInvoiceSms({ studentName, className, totalDueNow: totalDueNow ?? totalFee, dueDate, token, paymentRef });
}

function buildReceiptMessage({ studentName, amount, token, txnRef, balance }) {
  return renderReceiptSms({ studentName, amount, token, txnRef, balance });
}

// sendSMS — returns { messageId, status: "queued" } on acceptance.
// "queued" means AT accepted it. Actual delivery comes via /api/sms/delivery webhook.
// Never call this "sent" to the user — only "queued" until telco confirms delivery.
async function sendSMS(to, message, user) {
  const apiKey   = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME || "feeflows";
  const senderId = process.env.AT_SENDER_ID;
  if (!apiKey) throw new Error("SMS not configured — AT_API_KEY is missing from .env");
  const phone = formatPhoneAT(to);
  if (!phone) throw new Error("Cannot send SMS: invalid phone number '" + to + "'");
  const params = { username, to: phone, message };
  if (senderId) params.from = senderId;
  const body = new URLSearchParams(params);
  let httpRes;
  try {
    httpRes = await fetchWithTimeout("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: { "apiKey": apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    }, 15000);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("SMS timed out — Africa's Talking did not respond within 15 seconds");
    throw new Error("SMS network error — could not reach Africa's Talking: " + e.message);
  }
  const raw = await httpRes.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error("SMS provider returned an invalid response (not JSON). Raw: " + raw.slice(0, 100)); }

  const recipient = data.SMSMessageData?.Recipients?.[0];
  if (!recipient) throw new Error("Africa's Talking returned no recipient data. Response: " + JSON.stringify(data).slice(0, 200));

  const atStatus  = recipient.status;
  const messageId = recipient.messageId || null;

  // Map AT rejection codes to human-readable errors
  const ERRORS = {
    UserInBlacklist:      "Parent's number (" + phone + ") has opted out of SMS. They must text START to 40101 to re-subscribe.",
    InvalidPhoneNumber:   "Invalid phone number: " + phone + ". Check the parent's number is correct.",
    InvalidSenderId:      "SMS sender ID is not approved by Africa's Talking. Contact AT support.",
    InsufficientCredit:   "Your Africa's Talking account has insufficient credit. Top up at account.africastalking.com.",
    UserAccountSuspended: "Your Africa's Talking account is suspended. Contact AT support immediately.",
    DeliveryFailure:      "SMS delivery failed — the number may be switched off or unreachable.",
    MessageRejected:      "SMS was rejected by the mobile network. The number may be blocked.",
    RejectedByNetwork:    "SMS was rejected by the telco network. Try again later.",
  };
  if (ERRORS[atStatus]) throw new Error(ERRORS[atStatus]);

  // "Success" = AT queued it for delivery. Telco delivery is confirmed via webhook.
  return { messageId, status: "queued", atStatus };
}

async function sendWhatsAppTemplate(phone, templateName, headerParams, bodyParams, buttonUrlSuffix) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    logger.warn("whatsapp", "WhatsApp credentials not configured - skipping", { templateName });
    return { skipped: true };
  }

  const digits = String(phone || "").replace(/\D/g, "");
  const normalised = digits.replace(/^0/, "254").replace(/^(7|1)/, "254$1");
  const components = [];

  if (headerParams?.length) components.push({ type: "header", parameters: headerParams });
  if (bodyParams?.length) components.push({ type: "body", parameters: bodyParams });
  if (buttonUrlSuffix) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(buttonUrlSuffix) }],
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: normalised,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components,
    },
  };

  try {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      15000
    );
    const data = await res.json();
    if (!res.ok) {
      logger.warn("whatsapp", "Meta API error sending template", {
        templateName,
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message };
    }
    logger.info("whatsapp", "WhatsApp template sent", {
      templateName,
      to: normalised.slice(0, 6) + "***",
      messageId: data?.messages?.[0]?.id,
    });
    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    logger.warn("whatsapp", "Failed to send WhatsApp template", {
      templateName,
      error: safeErrorMessage(err),
    });
    return { success: false, error: safeErrorMessage(err) };
  }
}

const WA_DELAY_MS = parseInt(process.env.WA_DELAY_MS || "80", 10);

// Free-form text send — used by the WhatsApp inbox (AI auto-replies + Yaya's manual
// replies). Distinct from sendWhatsAppTemplate above: Meta only allows free-form text
// within the 24h customer service window after the customer's last message, whereas
// templates can be sent any time. Invoices/receipts keep using the template sender —
// this is only for inbox conversation replies.
async function sendWhatsAppText(phone, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    logger.warn("whatsapp", "WhatsApp credentials not configured - skipping text send");
    return { skipped: true };
  }

  const digits = String(phone || "").replace(/\D/g, "");
  const normalised = digits.replace(/^0/, "254").replace(/^(7|1)/, "254$1");

  const payload = {
    messaging_product: "whatsapp",
    to: normalised,
    type: "text",
    text: { body: String(body || "").slice(0, 4096) },
  };

  try {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      15000
    );
    const data = await res.json();
    if (!res.ok) {
      logger.warn("whatsapp", "Meta API error sending text", { status: res.status, error: data?.error?.message });
      return { success: false, error: data?.error?.message };
    }
    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    logger.warn("whatsapp", "Failed to send WhatsApp text", { error: safeErrorMessage(err) });
    return { success: false, error: safeErrorMessage(err) };
  }
}

const waQueue = [];
let waQueueRunning = false;
let waTotalEnqueued = 0;
let waTotalSent = 0;
let waTotalFailed = 0;

function enqueueWhatsApp(phone, templateName, headerParams, bodyParams, buttonSuffix, meta = {}) {
  waTotalEnqueued++;
  return new Promise((resolve, reject) => {
    waQueue.push({ phone, templateName, headerParams, bodyParams, buttonSuffix, meta, resolve, reject });
    logger.info("waQueue", "Job enqueued", { templateName, queueLength: waQueue.length, totalEnqueued: waTotalEnqueued });
    if (!waQueueRunning) drainWaQueue();
  });
}

async function drainWaQueue() {
  waQueueRunning = true;
  logger.info("waQueue", "Queue drain started", { queueLength: waQueue.length });
  while (waQueue.length > 0) {
    const job = waQueue.shift();
    try {
      const result = await sendWhatsAppTemplate(
        job.phone,
        job.templateName,
        job.headerParams,
        job.bodyParams,
        job.buttonSuffix
      );
      if (result?.success === false) {
        waTotalFailed++;
        logger.warn("waQueue", "Job failed (Meta error)", { templateName: job.templateName, error: result.error, meta: job.meta });
      } else {
        waTotalSent++;
      }
      job.resolve(result);
    } catch (err) {
      waTotalFailed++;
      logger.warn("waQueue", "Job threw", { templateName: job.templateName, error: safeErrorMessage(err), meta: job.meta });
      job.reject(err);
    }
    if (waQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, WA_DELAY_MS));
    }
  }
  waQueueRunning = false;
  logger.info("waQueue", "Queue drained", { sent: waTotalSent, failed: waTotalFailed });
}

const waText = value => ({ type: "text", text: String(value ?? "-") });
const waDate = value => value ? new Date(value).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" }) : "-";
const waDateTime = value => value ? new Date(value).toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";

function whatsappInvoiceTemplateParams({ user, student, invoice, totalAmount, dueDate, termName }) {
  const schoolName = user?.schoolName || "School";
  return {
    headerParams: [waText(schoolName)],
    bodyParams: [
      waText(student?.parentName?.split(" ")[0] || "Parent"),
      waText(invoice?.studentName || student?.name || "-"),
      waText(invoice?.admNo || student?.adm || "-"),
      waText(invoice?.className || student?.cls || "-"),
      waText(schoolName),
      waText(invoice?.termName || termName || "-"),
      waText(invoice?.invoiceNo || invoice?.invoiceNumber || invoice?.id || "-"),
      waText(waDate(dueDate || invoice?.dueDate)),
      waText(Number(totalAmount || invoice?.totalDueNow || invoice?.balance || invoice?.totalFee || 0).toLocaleString()),
      waText(user?.mpesaShortcode || user?.bankPaybillNumber || "-"),
      waText(studentBankPaymentReference(student) || invoice?.studentName || student?.name || "-"),
    ],
    buttonSuffix: invoiceLinkToken(invoice),
  };
}

function whatsappReceiptTemplateParams({ user, student, receipt, payment, balance }) {
  const schoolName = user?.schoolName || "School";
  const paidAt = receipt?.paidAt || payment?.createdAt || payment?.receivedAt;
  const amount = receipt?.amount ?? payment?.amount ?? 0;
  const receiptBalance = balance ?? receipt?.balance ?? 0;
  return {
    headerParams: [waText(schoolName)],
    bodyParams: [
      waText(student?.parentName?.split(" ")[0] || "Parent"),
      waText(receipt?.studentName || student?.name || "-"),
      waText(receipt?.admNo || student?.adm || "-"),
      waText(schoolName),
      waText(receipt?.txnRef || payment?.txnRef || receipt?.reference || "-"),
      waText(waDateTime(paidAt)),
      waText(Number(amount || 0).toLocaleString()),
      waText(Number(receiptBalance || 0).toLocaleString()),
    ],
    buttonSuffix: receiptLinkToken(receipt),
  };
}

// sendEmail uses RESEND_FROM_EMAIL env var for the sender address.
// In Resend, "onboarding@resend.dev" only delivers to your own verified account email.
// Set RESEND_FROM_EMAIL to a verified domain address (e.g. noreply@yourdomain.com)
// or leave it unset to default to the safe sandbox sender below.
// For local dev: set RESEND_TEST_EMAIL=your@email.com to catch all outgoing emails there.
const sendEmail = async (to, subject, htmlBody, opts = {}) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return;
  const recipient  = process.env.NODE_ENV === "test" && process.env.RESEND_TEST_EMAIL
    ? process.env.RESEND_TEST_EMAIL : to;
  const fromAddress = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  const payload = { from: "FeeFlow <" + fromAddress + ">", to: recipient, subject, html: htmlBody };
  // Allow optional Reply-To so support can reply directly to the user
  if (opts.replyTo) payload.headers = { "Reply-To": opts.replyTo };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("Email send failed (" + response.status + "): " + raw.slice(0, 300));
  try { return JSON.parse(raw); } catch { return raw; }
};

function fmtKE(n)         { return Number(n || 0).toLocaleString("en-KE"); }
function fmtDateKE(d)     { return d ? new Date(d).toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" }) : "—"; }
function fmtDatetimeKE(d) { return d ? new Date(d).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }

// ─── PUBLIC INVOICE PAGE ──────────────────────────────────────────────────────
let pdfBrowserPromise = null;

function pdfFilePart(value, fallback) {
  const clean = String(value || fallback || "document").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return clean || fallback || "document";
}

function renderPrintStyles(accent) {
  return [
    "@page{size:A4;margin:12mm}",
    "*{box-sizing:border-box}",
    "html,body{margin:0;padding:0;background:#fff;color:#162033;font-family:Arial,Inter,sans-serif;font-size:12px;line-height:1.45}",
    ".sheet{width:100%;background:#fff}",
    ".header{display:flex;justify-content:space-between;gap:18px;border-bottom:3px solid " + accent + ";padding-bottom:16px;margin-bottom:18px;page-break-inside:avoid}",
    ".brand-left{display:flex;align-items:flex-start;gap:12px;min-width:0}",
    ".school-logo,.logo-img{width:72px;height:72px;object-fit:contain;display:block;border-radius:12px;background:#fff;}",
    ".school-logo.logo-fallback,.logo-img.logo-fallback{display:flex;align-items:center;justify-content:center;background:" + accent + ";color:#fff;font-size:22px;font-weight:900}",
    ".school{font-size:24px;font-weight:800;color:#0f1f3a;margin-bottom:4px}",
    ".school-tagline{font-size:11px;color:#526079;margin:-1px 0 4px;max-width:360px}",
    ".doc-title{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#526079;font-weight:700}",
    ".meta{text-align:right;font-size:12px;color:#526079}",
    ".meta strong{display:block;color:#0f1f3a;font-size:15px;margin-bottom:3px}",
    ".badge{display:inline-block;margin-top:8px;border-radius:999px;background:" + accent + ";color:#fff;padding:5px 12px;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}",
    ".grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;page-break-inside:avoid}",
    ".box{border:1px solid #d9e1ec;border-radius:8px;padding:12px;background:#f8fafc;page-break-inside:avoid}",
    ".label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#718096;font-weight:800;margin-bottom:5px}",
    ".value{font-size:14px;font-weight:800;color:#0f1f3a;overflow-wrap:anywhere}",
    ".muted{color:#526079;font-size:11px;margin-top:3px;overflow-wrap:anywhere}",
    "table{width:100%;border-collapse:collapse;margin:14px 0 16px;table-layout:fixed;page-break-inside:auto}",
    "thead{display:table-header-group}",
    "tr{page-break-inside:avoid;break-inside:avoid}",
    "th{background:#0f1f3a;color:#fff;text-align:left;padding:9px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em}",
    "td{border-bottom:1px solid #e6edf5;padding:9px 10px;vertical-align:top;overflow-wrap:anywhere}",
    ".num{text-align:right;white-space:nowrap}",
    ".summary{margin-left:auto;width:58%;min-width:280px;border:1px solid #d9e1ec;border-radius:8px;overflow:hidden;page-break-inside:avoid}",
    ".sum-row{display:flex;justify-content:space-between;gap:16px;padding:9px 12px;border-bottom:1px solid #e6edf5}",
    ".sum-row:last-child{border-bottom:0}",
    ".sum-row.total{background:#0f1f3a;color:#fff;font-size:14px;font-weight:800}",
    ".note{border:1px solid #d9e1ec;border-radius:8px;padding:11px 12px;margin-top:14px;background:#fbfdff;page-break-inside:avoid}",
    ".instructions{margin-top:16px;padding:12px;border-left:4px solid " + accent + ";background:#f8fafc;page-break-inside:avoid}",
    ".footer{margin-top:22px;text-align:center;color:#7a8699;font-size:10px;page-break-inside:avoid}",
    ".receipt-amount{border:2px solid #bbf7d0;background:#f0fdf4;border-radius:10px;padding:18px;text-align:center;margin:14px 0 18px;page-break-inside:avoid}",
    ".receipt-amount .amount{font-size:28px;font-weight:900;color:#047857}",
    ".kv{display:grid;grid-template-columns:180px 1fr;border-bottom:1px solid #e6edf5;padding:9px 0;gap:14px;page-break-inside:avoid}",
    ".kv .k{color:#526079}.kv .v{font-weight:700;color:#0f1f3a;overflow-wrap:anywhere}",
    "@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.box,.note,.instructions,.summary,.receipt-amount{break-inside:avoid;page-break-inside:avoid}}",
  ].join("");
}

function renderPrintBrandHeader(data, docTitle, badgeHtml) {
  const logo = renderPdfBrandLogo(data, "school-logo");
  return "<div class='brand-left'>" + logo + "<div><div class='school'>" + escHtml(data.schoolName) + "</div>"
    + (data.schoolTagline ? "<div class='school-tagline'>" + escHtml(data.schoolTagline) + "</div>" : "")
    + "<div class='doc-title'>" + escHtml(docTitle) + "</div>" + badgeHtml + "</div></div>";
}

function getSchoolBranding(user) {
  return {
    schoolName: user?.schoolName || "School",
    ...brandingPayload(user),
    schoolLogoDataUri: user?.schoolLogoDataUri || null,
  };
}

function renderPdfHeader(data, title, subtitle = "", accent = "#003366") {
  return "<section class='header'>"
    + renderPrintBrandHeader(data, title, subtitle ? "<span class='badge'>" + escHtml(subtitle) + "</span>" : "")
    + "<div class='meta'><strong>" + escHtml(title) + "</strong><div>Generated: " + fmtDatetimeKE(new Date()) + "</div></div>"
    + "</section>";
}

function renderReportShell({ title, accent, body }) {
  return "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>" + escHtml(title) + "</title><style>"
    + renderPrintStyles(accent)
    + ".report-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;page-break-inside:avoid}"
    + ".report-stat{border:1px solid #d9e1ec;border-radius:8px;background:#f8fafc;padding:11px 12px;page-break-inside:avoid}"
    + ".report-stat strong{display:block;color:#0f1f3a;font-size:16px;margin-bottom:3px}.report-stat span{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.06em;font-weight:800}"
    + ".filter-summary{border:1px solid #d9e1ec;border-radius:8px;background:#fbfdff;padding:10px 12px;margin-bottom:14px;color:#526079;font-size:11px;page-break-inside:avoid}"
    + ".status-pill{display:inline-block;border-radius:999px;padding:3px 8px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;background:#e6edf5;color:#334155}"
    + ".status-pill.valid{background:#dcfce7;color:#166534}.status-pill.reversed,.status-pill.deleted{background:#fee2e2;color:#991b1b}"
    + "@media(max-width:700px){.report-summary{grid-template-columns:repeat(2,1fr)}}"
    + "</style></head><body><main class='sheet'>" + body + "<footer class='footer'>Powered by FeeFlow</footer></main></body></html>";
}

function renderPaymentsReportPdfHtml({ user, payments, summary, filters }) {
  const brand = getSchoolBranding(user);
  const accent = DOC_PRIMARY;
  const methodLabel = method => method === "mpesa" ? "M-Pesa" : method === "bank" ? "Bank" : "Manual";
  const filterText = [
    "Date: " + (filters.startDate && filters.endDate ? fmtDateKE(filters.startDate) + " to " + fmtDateKE(filters.endDate) : "All time"),
    "Student: " + (filters.studentName || "All students"),
    "Class: " + (filters.className || "All classes"),
    "Method: " + (filters.method === "all" ? "All methods" : methodLabel(filters.method)),
    "Status: " + (filters.status || "valid"),
  ].join(" | ");
  const rows = payments.map(p => {
    const status = p.deletedAt ? "deleted" : p.reversedAt || p.isReversal ? "reversed" : "valid";
    return "<tr><td>" + fmtDatetimeKE(p.receivedAt || p.createdAt) + "</td><td>" + escHtml(p.student?.name || "Unknown") + "</td><td>" + escHtml(p.student?.adm || "") + "</td><td>" + escHtml(p.student?.cls || "") + "</td><td>" + escHtml([p.student?.parentName, p.student?.parentPhone].filter(Boolean).join(" / ")) + "</td><td>" + escHtml(methodLabel(p.method)) + "</td><td>" + escHtml(p.txnRef || "") + "</td><td class='num'>KES " + fmtKE(Math.abs(Number(p.amount || 0))) + "</td><td><span class='status-pill " + status + "'>" + status + "</span></td></tr>";
  }).join("");
  const body = renderPdfHeader(brand, "Payments Report", "Financial Report", accent)
    + "<section class='filter-summary'>" + escHtml(filterText) + "</section>"
    + "<section class='report-summary'>"
    + "<div class='report-stat'><strong>" + summary.count + "</strong><span>Total payments</span></div>"
    + "<div class='report-stat'><strong>KES " + fmtKE(summary.totalAmount) + "</strong><span>Total amount</span></div>"
    + "<div class='report-stat'><strong>KES " + fmtKE(summary.mpesaTotal) + "</strong><span>M-Pesa total</span></div>"
    + "<div class='report-stat'><strong>KES " + fmtKE(summary.manualTotal) + "</strong><span>Manual total</span></div>"
    + "</section>"
    + "<section class='report-summary' style='grid-template-columns:1fr'><div class='report-stat'><strong>KES " + fmtKE(summary.reversedDeletedTotal) + "</strong><span>Reversed / deleted total included</span></div></section>"
    + "<table><thead><tr><th>Date</th><th>Student Name</th><th>Adm No.</th><th>Class</th><th>Parent</th><th>Method</th><th>Transaction Ref</th><th class='num'>Amount</th><th>Status</th></tr></thead><tbody>"
    + (rows || "<tr><td colspan='9' style='text-align:center;color:#718096;padding:22px'>No payments match these filters.</td></tr>")
    + "</tbody></table>";
  return renderReportShell({ title: "Payments Report", accent, body });
}

function renderTermReportPdfHtml({ term, summary, students, user }) {
  const brand = getSchoolBranding(user);
  const accent = DOC_PRIMARY;
  const statusLabel = status => status === "fully_paid" ? "Fully paid" : status === "partial" ? "Partial" : status === "no_charges" ? "No charge" : "Unpaid";
  const rows = students.map(s => "<tr><td>" + escHtml(s.name) + "</td><td>" + escHtml(s.adm || "") + "</td><td>" + escHtml(s.bankPaymentReference || "") + "</td><td>" + escHtml(s.cls || "") + "</td><td>" + escHtml([s.parentName, s.parentPhone].filter(Boolean).join(" / ")) + "</td><td class='num'>KES " + fmtKE(s.termCharges) + "</td><td class='num'>KES " + fmtKE(s.termPaid) + "</td><td class='num'>KES " + fmtKE(s.termBalance) + "</td><td><span class='status-pill " + (s.status === "fully_paid" ? "valid" : s.status === "unpaid" ? "deleted" : "") + "'>" + statusLabel(s.status) + "</span></td></tr>").join("");
  const body = renderPdfHeader(brand, "Past Term Report", term.name, accent)
    + "<section class='filter-summary'>Term: " + escHtml(term.name) + " | Dates: " + fmtDateKE(term.startDate) + " to " + fmtDateKE(term.endDate) + "</section>"
    + "<section class='report-summary'>"
    + "<div class='report-stat'><strong>KES " + fmtKE(summary.totalExpected) + "</strong><span>Total expected</span></div>"
    + "<div class='report-stat'><strong>KES " + fmtKE(summary.totalCollected) + "</strong><span>Total collected</span></div>"
    + "<div class='report-stat'><strong>KES " + fmtKE(summary.totalRemaining) + "</strong><span>Total remaining</span></div>"
    + "<div class='report-stat'><strong>" + Math.round(summary.collectionRate || 0) + "%</strong><span>Collection rate</span></div>"
    + "<div class='report-stat'><strong>" + summary.fullyPaidCount + "</strong><span>Fully paid</span></div>"
    + "<div class='report-stat'><strong>" + summary.partialCount + "</strong><span>Partial</span></div>"
    + "<div class='report-stat'><strong>" + summary.unpaidCount + "</strong><span>Unpaid</span></div>"
    + "<div class='report-stat'><strong>" + summary.noChargeCount + "</strong><span>No charge</span></div>"
    + "</section>"
    + "<table><thead><tr><th>Student Name</th><th>Adm No.</th><th>Bank Ref</th><th>Class</th><th>Parent</th><th class='num'>Term Charges</th><th class='num'>Term Paid</th><th class='num'>Term Balance</th><th>Status</th></tr></thead><tbody>"
    + (rows || "<tr><td colspan='9' style='text-align:center;color:#718096;padding:22px'>No students found.</td></tr>")
    + "</tbody></table>";
  return renderReportShell({ title: "Past Term Report", accent, body });
}

function renderInvoicePrintHtml(data) {
  const displayFeeTotal = (Array.isArray(data.feeLines) ? data.feeLines : [])
    .reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const lines = data.feeLines.map((line) =>
    "<tr><td>" + escHtml(line.typeName || line.name || "Fee") + "</td><td class='num'>KES " + fmtKE(line.amount) + "</td></tr>"
  ).join("");
  const bankRows = [
    ["Paybill Number", data.bankPaybillNumber],
    ["Account Number / Business Number", data.bankAccountNumber],
    ["Account Name", data.bankAccountName],
    ["Bank Name", data.bankName],
  ].filter(([, v]) => String(v || "").trim());
  const bankSection = bankRows.length > 0
    ? "<section class='instructions' style='margin-top:12px'>"
      + "<strong>Pay via Bank / Paybill</strong><br>"
      + "<span style='font-size:11px;color:#526079'>Use student reference <strong>"
      + escHtml(data.paymentRef || "N/A")
      + "</strong> or invoice reference <strong>"
      + escHtml(data.invoicePaymentRef || data.invoiceNo)
      + "</strong> in the narration/reference field.</span>"
      + "<table style='width:100%;margin-top:10px;border-collapse:collapse;font-size:12px'>"
      + bankRows.map(([label, value]) =>
          "<tr><td style='padding:5px 8px;color:#526079;width:55%'>"
          + escHtml(label) + ":</td>"
          + "<td style='padding:5px 8px;font-weight:800;color:#0f1f3a;text-align:right'>"
          + escHtml(value) + "</td></tr>"
        ).join("")
      + (data.bankPaymentInstructions
          ? "<tr><td colspan='2' style='padding:5px 8px;font-size:11px;color:#526079'>"
            + escHtml(data.bankPaymentInstructions) + "</td></tr>"
          : "")
      + "</table></section>"
    : "";
  const accent = DOC_PRIMARY;
  return "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>Invoice " + escHtml(data.invoiceNo) + "</title><style>" + renderPrintStyles(accent) + "</style></head><body><main class='sheet'>"
    + "<section class='header'>" + renderPrintBrandHeader(data, "Official Fee Invoice", "<span class='badge'>Payment Due</span>") + "<div class='meta'><strong>Invoice " + escHtml(data.invoiceNo) + "</strong><div>Issued: " + fmtDateKE(data.createdAt) + "</div><div>Due: " + fmtDateKE(data.dueDate) + "</div></div></section>"
    + "<section class='grid'><div class='box'><div class='label'>Student</div><div class='value'>" + escHtml(data.studentName) + "</div><div class='muted'>" + escHtml(data.className || "") + (data.admNo ? " &middot; Adm: " + escHtml(data.admNo) : "") + "</div><div class='muted'><strong>Bank payment ref:</strong> " + escHtml(data.paymentRef || "N/A") + "</div></div><div class='box'><div class='label'>Parent Details</div><div class='value'>" + escHtml(data.parentName || "Parent / Guardian") + "</div><div class='muted'>" + escHtml(data.parentPhone || "") + "</div></div></section>"
    + "<table><thead><tr><th>Description</th><th class='num'>Amount</th></tr></thead><tbody>" + lines + "</tbody></table>"
    + "<section class='summary'>"
    + (Number(data.feeLines?.length) > 1
        ? "<div class='sum-row'><span>Subtotal</span><strong>KES " + fmtKE(displayFeeTotal) + "</strong></div>"
        : "")
    + (Number(data.totalPaidToDate) > 0
        ? "<div class='sum-row' style='color:#27ae60'><span>Previously Paid</span><strong>KES " + fmtKE(data.totalPaidToDate) + "</strong></div>"
        : "")
    + "<div class='sum-row total'><span>Total Due Now</span><strong>KES " + fmtKE(data.totalDueNow) + "</strong></div>"
    + "</section>"
    + (data.note ? "<section class='note'><strong>Note:</strong> " + escHtml(data.note) + "</section>" : "")
    + "<section class='instructions'><strong>Payment instructions</strong><br>Pay the amount due by " + fmtDateKE(data.dueDate) + ". Include bank payment reference <strong>" + escHtml(data.paymentRef || "N/A") + "</strong> or invoice reference <strong>" + escHtml(data.invoicePaymentRef || data.invoiceNo) + "</strong> in the bank narration/reference.</section>"
    + bankSection
    + "<footer class='footer'>Powered by FeeFlow</footer>"
    + "</main></body></html>";
}

function renderReceiptPrintHtml(data) {
  const verification = data.verificationUrl
    ? "<div class='kv'><div class='k'>Verification Link</div><div class='v'>" + escHtml(data.verificationUrl) + "</div></div>"
    : "<div class='kv'><div class='k'>Receipt Token</div><div class='v'>" + escHtml(data.token) + "</div></div>";
  const accent = DOC_PRIMARY;
  return "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>Receipt " + escHtml(data.receiptNo) + "</title><style>" + renderPrintStyles(accent) + "</style></head><body><main class='sheet'>"
    + "<section class='header'>" + renderPrintBrandHeader(data, "Official Payment Receipt", "<span class='badge'>Paid</span>") + "<div class='meta'><strong>Receipt " + escHtml(data.receiptNo) + "</strong><div>Payment date: " + fmtDatetimeKE(data.paidAt) + "</div></div></section>"
    + "<section class='receipt-amount'><div class='label'>Amount Paid</div><div class='amount'>KES " + fmtKE(data.amount) + "</div></section>"
    + "<section class='box'>"
    + "<div class='kv'><div class='k'>Student</div><div class='v'>" + escHtml(data.studentName) + "</div></div>"
    + "<div class='kv'><div class='k'>Class / Admission</div><div class='v'>" + escHtml(data.className || "") + (data.admNo ? " / " + escHtml(data.admNo) : "") + "</div></div>"
    + "<div class='kv'><div class='k'>Payment Method</div><div class='v'>" + escHtml(data.method) + "</div></div>"
    + (data.txnRef ? "<div class='kv'><div class='k'>Transaction Reference</div><div class='v'>" + escHtml(data.txnRef) + "</div></div>" : "")
    + "<div class='kv'><div class='k'>Balance After Payment</div><div class='v'>" + (Number(data.balance) > 0 ? "KES " + fmtKE(data.balance) : "Cleared") + "</div></div>"
    + verification
    + "</section><footer class='footer'>Powered by FeeFlow</footer>"
    + "</main></body></html>";
}

async function htmlToPdfBuffer(html) {
  return withPdfConcurrency(async () => {
    if (pdfBrowserPromise) {
      const existingBrowser = await pdfBrowserPromise;
      if (!existingBrowser.isConnected()) pdfBrowserPromise = null;
    }

    if (!pdfBrowserPromise) {
      const isProduction = process.env.NODE_ENV === "production" || process.env.NODE_ENV !== "test";
      const executablePath = isProduction
        ? await chromium.executablePath()
        : process.env.PUPPETEER_EXECUTABLE_PATH;
      if (!isProduction && !executablePath) {
        logger.warn("pdf", "Local PDF generation requires PUPPETEER_EXECUTABLE_PATH or an installed Chrome executable.");
      }
      logger.info("pdf", "browser launch started", {
        runtime: isProduction ? "sparticuz-chromium" : "local",
        executablePath: executablePath ? "provided" : "missing",
      });
      const launchOptions = {
        args: isProduction ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless,
      };
      pdfBrowserPromise = puppeteer.launch(launchOptions).catch(error => {
        pdfBrowserPromise = null;
        logger.error("pdf", "browser launch failed", { error: error.message });
        throw error;
      });
    }
    const browser = await pdfBrowserPromise;
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.evaluate(async () => {
        const images = Array.from(document.images || []);
        await Promise.all(images.map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        }));
      });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
      });
      const buffer = Buffer.from(pdf);
      logger.info("pdf", "PDF generated successfully", { bytes: buffer.length });
      return buffer;
    } finally {
      await page.close();
    }
  });
}

async function generatePdfFromHtml(html, options = {}) {
  return htmlToPdfBuffer(html, options);
}

async function findInvoiceByPublicToken(token) {
  try {
    const payload = verifyPublicLink(token, "invoice", process.env.INVOICE_LINK_SECRET || process.env.JWT_SECRET);
    return prisma.invoice.findFirst({ where: { id: payload.id, userId: payload.ownerUserId } });
  } catch {
    // Legacy random tokens are allowed only for already-issued links.
    return prisma.invoice.findFirst({ where: { token } });
  }
}

async function findReceiptByPublicToken(token) {
  try {
    const payload = verifyPublicLink(token, "receipt", process.env.RECEIPT_LINK_SECRET || process.env.JWT_SECRET);
    return prisma.receipt.findFirst({ where: { id: payload.id, userId: payload.ownerUserId } });
  } catch {
    return prisma.receipt.findFirst({ where: { token } });
  }
}

async function getInvoicePrintData(token) {
  const baseInvoice = await findInvoiceByPublicToken(token);
  if (!baseInvoice) return null;
  const invoice = await prisma.invoice.findFirst({
    where: { id: baseInvoice.id },
    include: {
      user: {
        select: {
          schoolName: true,
          ...USER_BRANDING_SELECT,
          ...USER_BANK_PAYBILL_SELECT,
        },
      },
    },
  });
  if (!invoice) return null;
  const [st, liveBalance] = await Promise.all([
    prisma.student.findUnique({ where: { id: invoice.studentId } }),
    deriveStudentBalance(invoice.studentId),
  ]);
  const snap = invoiceSnapshot(invoice);
  const feeLines = Array.isArray(invoice.feeBreakdown) && invoice.feeBreakdown.length > 0
    ? invoice.feeBreakdown
    : [{ typeName: "Fee", amount: invoice.totalFee }];
  const displayFeeTotal = feeLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const displayTotalDueNow = Math.max(0, displayFeeTotal - snap.totalPaidToDate);
  const branding = brandingPayload(invoice.user);
  const schoolLogoDataUri = await getLogoDataUri(invoice.user);
  // If local file is missing (e.g. after a deploy wipe), fall back
  // to the Supabase public URL so PDFs still show the logo.
  // renderPdfBrandLogo checks schoolLogoDataUri first, then schoolLogoUrl.
  const schoolLogoFallbackUrl = !schoolLogoDataUri
    ? (invoice.user.schoolLogoUrl || null)
    : null;
  return {
    schoolName: invoice.user.schoolName || "School",
    ...branding,
    schoolLogoDataUri,
    schoolLogoUrl: schoolLogoFallbackUrl,
    invoiceNo: invoice.invoiceNo,
    createdAt: invoice.createdAt,
    dueDate: invoice.dueDate,
    studentName: st?.name || invoice.studentName,
    className: st?.cls || invoice.className,
    admNo: st?.adm || invoice.admNo,
    paymentRef: studentBankPaymentReference(st || { id: invoice.studentId, adm: invoice.admNo }),
    invoicePaymentRef: invoiceBankPaymentReference(invoice),
    parentName: st?.parentName || "",
    parentPhone: st?.parentPhone || "",
    feeLines,
    previousOutstanding: snap.previousOutstanding,
    newChargesTotal: displayFeeTotal,
    accountTotalCharges: snap.accountTotalCharges,
    totalPaidToDate: snap.totalPaidToDate,
    totalCredit: liveBalance?.totalCredit ?? 0,
    totalDueNow: displayTotalDueNow,
    note: invoice.note || "",
    bankPaybillNumber: invoice.user.bankPaybillNumber || "",
    bankAccountNumber: invoice.user.bankAccountNumber || "",
    bankAccountName: invoice.user.bankAccountName || "",
    bankName: invoice.user.bankName || "",
    bankPaymentInstructions: invoice.user.bankPaymentInstructions || "",
  };
}

async function getReceiptPrintData(token) {
  const baseReceipt = await findReceiptByPublicToken(token);
  if (!baseReceipt) return null;
  const receipt = await prisma.receipt.findFirst({
    where: { id: baseReceipt.id },
    include: { user: { select: { schoolName: true, ...USER_BRANDING_SELECT } } },
  });
  if (!receipt) return null;
  const METHOD = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash", manual: "Cash" };
  const branding = brandingPayload(receipt.user);
  const schoolLogoDataUri = await getLogoDataUri(receipt.user);
  const schoolLogoFallbackUrl = !schoolLogoDataUri
    ? (receipt.user.schoolLogoUrl || null)
    : null;
  return {
    token: receipt.token,
    schoolName: receipt.user.schoolName || "School",
    ...branding,
    schoolLogoDataUri,
    schoolLogoUrl: schoolLogoFallbackUrl,
    receiptNo: receipt.receiptNo,
    paidAt: receipt.paidAt,
    studentName: receipt.studentName,
    className: receipt.className,
    admNo: receipt.admNo,
    method: METHOD[receipt.method] || receipt.method,
    txnRef: receipt.txnRef,
    amount: receipt.amount,
    balance: receipt.balance || 0,
    verificationUrl: publicReceiptLink(receipt.token),
  };
}

app.get("/i/:token/pdf", pdfLimiter, async (req, res) => {
  try {
    const data = await getInvoicePrintData(req.params.token);
    if (!data) return res.status(404).send("Invoice not found");
    const pdf = await htmlToPdfBuffer(renderInvoicePrintHtml(data));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"Invoice-" + pdfFilePart(data.invoiceNo, "invoice") + ".pdf\"");
    res.send(pdf);
  } catch (e) {
    logger.error("pdf", "invoice_pdf_failed", { error: e.message, reqId: req.reqId });
    if (e?.statusCode) return res.status(e.statusCode).send(e.message);
    res.status(500).send("Could not generate invoice PDF");
  }
});

app.get("/r/:token/pdf", pdfLimiter, async (req, res) => {
  try {
    const data = await getReceiptPrintData(req.params.token);
    if (!data) return res.status(404).send("Receipt not found");
    const pdf = await htmlToPdfBuffer(renderReceiptPrintHtml(data));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"Receipt-" + pdfFilePart(data.receiptNo, "receipt") + ".pdf\"");
    res.send(pdf);
  } catch (e) {
    logger.error("pdf", "receipt_pdf_failed", { error: e.message, reqId: req.reqId });
    if (e?.statusCode) return res.status(e.statusCode).send(e.message);
    res.status(500).send("Could not generate receipt PDF");
  }
});

app.get("/i/:token", async (req, res) => {
  try {
    const baseInvoice = await findInvoiceByPublicToken(req.params.token);
    const invoice = baseInvoice && await prisma.invoice.findFirst({
      where: { id: baseInvoice.id },
      include: { user: { select: { schoolName: true, mpesaConfigured: true, ...USER_BRANDING_SELECT, ...USER_BANK_PAYBILL_SELECT } } },
    });
    if (!invoice) return res.status(404).send("<!DOCTYPE html><html><body style='font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8'><div style='text-align:center;color:#c00'><div style='font-size:48px'>X</div><h2>Invoice not found</h2><p style='color:#666'>This link may be invalid or expired.</p></div></body></html>");
    await logAudit(req, { action: "invoice_public_link_opened", entityType: "invoice", entityId: invoice.id, schoolOwnerId: invoice.userId, metadata: { purpose: "view" } });

    // Load live student for name/contact details only
    const st_live = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    const st = st_live || {
      name: invoice.studentName, adm: invoice.admNo, cls: invoice.className,
      parentName: null, parentPhone: null, daysOverdue: 0,
    };

    // invoice.totalFee is the authoritative term total (includes any extras added at creation).
    // feeBreakdown holds the line items. If somehow totalFee > sum(breakdown) we show a
    // catch-all "Fee" row for the remainder so numbers always add up visually.
    // ── LEDGER-DERIVED BALANCE (the fix for the core accounting bug) ──────────
    // OLD (wrong): filter payments by invoice.createdAt — misses payments made
    //   before the invoice was generated. Causes "already paid" invoices to show
    //   a balance. Also breaks when transport fee is added later.
    //
    // NEW (correct): derive from StudentCharge rows (if they exist) OR invoice.totalFee
    //   minus ALL valid payments for this student. Charges are additive — when
    //   transport is added, a new StudentCharge row is created. The invoice page
    //   always shows: SUM(charges) - SUM(all valid payments).
    //
    // For the parent portal, we show the INVOICE-SPECIFIC charges vs all payments
    // because the parent needs to know what this particular invoice demands.
    const fb = Array.isArray(invoice.feeBreakdown) && invoice.feeBreakdown.length > 0
      ? invoice.feeBreakdown : [{ typeName: "Fee", amount: invoice.totalFee }];

    // Charges for THIS invoice only (from StudentCharge if available, else invoice.totalFee)
    const newChargesTotal = fb.reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const snap = invoiceSnapshot(invoice);
    const paidToDate = snap.totalPaidToDate;
    const balance = Math.max(0, newChargesTotal - paidToDate);

    const liveBalance = await deriveStudentBalance(invoice.studentId);

    const brand = brandingPayload(invoice.user);
    const school  = escHtml(invoice.user.schoolName || "School");
    const primary = DOC_PRIMARY;
    const brandLogo = renderBrandLogo({ schoolName: invoice.user.schoolName, ...brand }, "school-logo");
    const tagline = brand.schoolTagline ? "<div class='school-tagline'>" + escHtml(brand.schoolTagline) + "</div>" : "";
    const feeRows = fb.map(f => "<tr style='border-bottom:1px solid #eee'><td style='padding:10px 12px'>" + escHtml(f.typeName || f.name || "Fee") + "</td><td style='padding:10px 12px;text-align:right'>" + fmtKE(f.amount) + "</td></tr>").join("");
    const paymentRef = studentBankPaymentReference(st);
    const invoicePaymentRef = invoiceBankPaymentReference(invoice);
    const accountRows =
      (paidToDate > 0
        ? "<tr style='color:#27ae60'><td style='padding:8px 12px;font-weight:600'>Previously Paid</td><td style='padding:8px 12px;text-align:right;font-weight:600'>KES " + fmtKE(paidToDate) + "</td></tr>"
        : "")
      + "<tr style='background:" + (balance > 0 ? "#fff5f5" : "#f0fdf4") + "'><td style='padding:9px 12px;font-weight:700;color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>Total Due Now</td><td style='padding:9px 12px;text-align:right;font-weight:700;color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>KES " + fmtKE(balance) + "</td></tr>";

    const portalUrl  = backendPublicBaseUrl() + "/p/" + invoice.token;
    const html = "<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Fee Invoice - " + escHtml(st.name) + "</title>"
      + "<style>"
      + "*{box-sizing:border-box;margin:0;padding:0}"
      /* ── body: NO min-height, NO overflow constraints that could clip canvas ── */
      + "body{font-family:Arial,sans-serif;background:#f0f4f8;padding:24px 16px}"
      + ".wrap{max-width:600px;margin:0 auto}"
      + ".brand{text-align:center;margin-bottom:20px}"
      + ".brand .name{font-size:13px;font-weight:700;color:#059669;letter-spacing:1px}"
      + ".brand .sub{font-size:12px;color:#888;margin-top:2px}"
      /* ── card: NO overflow:hidden, NO fixed height, width must be fluid ── */
      + ".card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);width:100%;display:block}"
      + ".hdr{background:" + primary + ";color:#fff;padding:24px 28px;display:flex;justify-content:space-between;align-items:flex-start;gap:18px;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
      + ".school-brand{display:flex;align-items:flex-start;gap:12px;min-width:0}"
      + ".school-logo{width:72px;height:72px;border-radius:12px;background:#fff;border:1px solid rgba(255,255,255,.45);object-fit:contain;display:block;padding:4px;flex:0 0 auto}.school-logo.logo-fallback{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.18);color:#fff;font-size:20px;font-weight:800}.school-tagline{font-size:12px;opacity:.82;margin-top:2px}"
      + ".hdr h1{font-size:20px;font-weight:700;margin-bottom:4px}"
      + ".hdr .sub{font-size:11px;opacity:.75;letter-spacing:1px;text-transform:uppercase}"
      + ".hdr .badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:4px 12px;border-radius:20px;font-size:11px;margin-top:8px}"
      /* ── body section: overflow visible, no height constraints ── */
      + ".body{padding:28px;overflow:visible}"
      + ".grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}"
      + ".box{background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;-webkit-print-color-adjust:exact;print-color-adjust:exact;overflow:visible}"
      + ".box .lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}"
      + ".box .val{font-size:15px;font-weight:700;color:#003366;word-break:break-word}"
      + ".box .inf{font-size:12px;color:#555;margin-top:2px;word-break:break-word}"
      /* ── table: fixed layout prevents column overflow ── */
      + "table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;table-layout:fixed}"
      + "table td,table th{word-break:break-word;overflow-wrap:break-word}"
      + "thead tr{background:" + primary + ";color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
      + "thead th{padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.5px;font-weight:600}"
      + "tbody td{padding:10px 12px;border-bottom:1px solid #eee}"
      + ".total-row td{background:#e8f0fe;font-weight:700;font-size:14px;color:" + primary + ";border-top:2px solid " + primary + ";padding:11px 12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
      + ".actions{padding:0 28px 28px}"
      + ".btn-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:15px;border-radius:10px;background:" + primary + ";border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;text-align:center;text-decoration:none;transition:opacity .2s}"
      + ".btn-primary:hover{opacity:.9}.btn-primary:disabled{opacity:.6;cursor:not-allowed}"
      + ".btn-mpesa{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:15px;border-radius:10px;background:#22d3a4;border:none;color:#0b1a14;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;text-align:center;text-decoration:none;margin-bottom:10px;transition:opacity .2s}"
      + ".btn-mpesa:hover{opacity:.9}"
      + ".portal-link{display:block;text-align:center;margin-top:14px;font-size:13px;font-weight:700;color:" + primary + ";text-decoration:none;padding:10px;border:1px solid " + primary + ";border-radius:8px;transition:background .2s}"
      + ".portal-link:hover{background:#f0f4f8}"
      + ".note{background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;color:#555;margin-bottom:20px;overflow:visible}"
      + ".bank-info-row{display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-top:1px solid #e5e7eb}.bank-info-row:first-of-type{border-top:none}.bank-info-row span{color:#555}.bank-info-row strong{text-align:right;color:#003366;word-break:break-word}"
      + ".footer{margin-top:18px;font-size:11px;color:#aaa;text-align:center;line-height:1.8;padding-bottom:8px}"
      + "img{max-width:100%;height:auto}"
      + "@media(max-width:480px){.grid{grid-template-columns:1fr}.hdr{flex-direction:column;gap:12px}}"
      + "@media print{"
      + "*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;overflow:visible!important}"
      + "body{background:#fff!important;padding:0!important}"
      + ".wrap{max-width:100%!important}"
      + ".actions,.no-print{display:none!important}"
      + ".card{box-shadow:none!important;border-radius:0!important}"
      + ".hdr{background:" + primary + "!important;color:#fff!important}"
      + "thead tr{background:" + primary + "!important;color:#fff!important}"
      + ".total-row td{background:#e8f0fe!important;color:" + primary + "!important}"
      + ".box{background:#f7f9fc!important}"
      + "table{table-layout:fixed!important}"
      + "}"
      + "</style>"
      + "</head><body><div class='wrap'>"
      + "<div class='brand'><div class='name'>FEEFLOW</div><div class='sub'>Fee Management Platform</div></div>"
      + "<div class='card' id='invoice-card'>"
      + "<div class='hdr'><div class='school-brand'>" + brandLogo + "<div><h1>" + school + "</h1>" + tagline + "<div class='sub'>Official Fee Invoice</div><div class='badge'>PAYMENT DUE</div></div></div>"
      + "<div style='text-align:right;font-size:12px'><div style='opacity:.75'>Invoice No.</div><div style='font-size:15px;font-weight:700'>" + invoice.invoiceNo + "</div><div style='opacity:.75;margin-top:6px'>Issued</div><div>" + fmtDateKE(invoice.createdAt) + "</div></div></div>"
      + "<div class='body'><div class='grid'>"
      + "<div class='box'><div class='lbl'>Billed To</div><div class='val'>" + escHtml(st.name) + "</div><div class='inf'>" + escHtml(st.cls || "") + (st.adm ? " &middot; Adm: " + escHtml(st.adm) : "") + "</div><div class='inf'><strong>Bank payment ref:</strong> " + escHtml(paymentRef || "N/A") + "</div>" + (st.parentName ? "<div class='inf'>Parent: " + escHtml(st.parentName) + "</div>" : "") + (st.parentPhone ? "<div class='inf'>Phone: " + escHtml(st.parentPhone) + "</div>" : "") + "</div>"
      + "<div class='box'><div class='lbl'>Payment Due</div><div class='val' style='color:#c00'>" + fmtDateKE(invoice.dueDate) + "</div>" + (invoice.termName ? "<div class='inf'>Term: " + escHtml(invoice.termName) + "</div>" : "") + "</div>"
      + "</div>"
      + "<table><thead><tr><th>Description</th><th style='text-align:right'>Amount (KES)</th></tr></thead><tbody>" + feeRows + "</tbody>"
      + "<tfoot>"
      + (fb.length > 1
          ? "<tr class='total-row'><td>Subtotal</td><td style='text-align:right'>KES " + fmtKE(newChargesTotal) + "</td></tr>"
          : "")
      + accountRows
      + "</tfoot></table>"
      + (invoice.note ? "<div class='note'><strong>Note:</strong> " + escHtml(invoice.note) + "</div>" : "")
      + "<div class='note'><strong>Pay via Bank / Paybill</strong><br>Use this student reference in narration/reference: <strong>" + escHtml(paymentRef || "N/A") + "</strong><br>Invoice reference: <strong>" + escHtml(invoicePaymentRef || invoice.invoiceNo) + "</strong>"
      + (hasBankPaybillInfo(invoice.user) ? "<div style='margin-top:10px'>" + renderBankPaybillRows(invoice.user) + "</div>" : "<div style='margin-top:10px;color:#777'>Bank / Paybill details have not been added by the school yet.</div>")
      + "</div>"
      + "<div class='footer'>Please ensure payment is made before the due date.<br>For inquiries, contact " + school + " administration.<br><em>Powered by FeeFlow</em></div>"
      + "</div></div>"
      // ── Action buttons live OUTSIDE the invoice-card so they don't appear in PDF ──
      + "<div class='actions'>"
      + (balance > 0 && invoice.user?.mpesaConfigured ? "<a href='" + portalUrl + "' class='btn-mpesa'>💳 Pay Now via M-Pesa</a>" : "")
      + "<a class='btn-primary' href='/i/" + encodeURIComponent(invoice.token) + "/pdf'>&#8659; Download Invoice PDF</a>"
      + "<a href='" + portalUrl + "' class='portal-link'>&#128279; View balance &amp; payment history</a>"
      + "</div>"
      + "</div>"
      + "</body></html>";

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("invoice page:", e); res.status(500).send("<!DOCTYPE html><html><body style='font-family:Arial;padding:40px;text-align:center'><h2 style='color:#c00'>Could not load invoice</h2><p>Something went wrong on our end. Please try again or contact the school directly.</p></body></html>"); }
});

// ─── PUBLIC RECEIPT PAGE ──────────────────────────────────────────────────────
app.get("/r/:token", async (req, res) => {
  try {
    const baseReceipt = await findReceiptByPublicToken(req.params.token);
    const receipt = baseReceipt && await prisma.receipt.findFirst({
      where: { id: baseReceipt.id },
      include: { user: { select: { schoolName: true, ...USER_BRANDING_SELECT } } },
    });
    if (!receipt) return res.status(404).send("<!DOCTYPE html><html><body style='font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8'><div style='text-align:center;color:#c00'><div style='font-size:48px'>X</div><h2>Receipt not found</h2><p style='color:#666'>This link may be invalid.</p></div></body></html>");
    await logAudit(req, { action: "receipt_public_link_opened", entityType: "receipt", entityId: receipt.id, schoolOwnerId: receipt.userId, metadata: { purpose: "view" } });

    const brand = brandingPayload(receipt.user);
    const school  = escHtml(receipt.user.schoolName || "School");
    const primary = DOC_PRIMARY;
    const brandLogo = renderBrandLogo({ schoolName: receipt.user.schoolName, ...brand }, "school-logo");
    const tagline = brand.schoolTagline ? "<div class='school-tagline'>" + escHtml(brand.schoolTagline) + "</div>" : "";
    const balance = receipt.balance || 0; // stored at receipt creation time — not live student data
    const METHOD  = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash", manual: "Cash" };
    const method  = METHOD[receipt.method] || receipt.method;

    const rows = [
      ["Student",        escHtml(receipt.studentName)],
      receipt.admNo     ? ["Adm. No.",        escHtml(receipt.admNo)]   : null,
      ["Class",          escHtml(receipt.className)],
      ["Payment Method", escHtml(method)],
      receipt.txnRef    ? ["Transaction Ref",  escHtml(receipt.txnRef)] : null,
      ["Date & Time",    fmtDatetimeKE(receipt.paidAt)],
    ].filter(Boolean).map(function(r) {
      return "<div style='display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f0f0;font-size:13px'><span style='color:#666'>" + r[0] + "</span><span style='font-weight:600;text-align:right;max-width:60%'>" + r[1] + "</span></div>";
    }).join("");

    const html = "<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Payment Receipt - " + escHtml(receipt.studentName) + "</title>"
      + "<style>"
      + "*{box-sizing:border-box;margin:0;padding:0}"
      + "body{font-family:Arial,sans-serif;background:#f0f4f8;padding:24px 16px}"
      + ".wrap{max-width:480px;margin:0 auto}"
      + ".brand{text-align:center;margin-bottom:20px}"
      + ".brand .name{font-size:13px;font-weight:700;color:#059669;letter-spacing:1px}"
      + ".brand .sub{font-size:12px;color:#888;margin-top:2px}"
      + ".card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);width:100%;display:block}"
      + ".hdr{background:" + primary + ";color:#fff;padding:20px 24px;display:flex;gap:12px;align-items:flex-start;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
      + ".school-logo{width:72px;height:72px;border-radius:12px;background:#fff;border:1px solid rgba(255,255,255,.45);object-fit:contain;display:block;padding:4px;flex:0 0 auto}.school-logo.logo-fallback{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.18);color:#fff;font-size:20px;font-weight:800}.school-tagline{font-size:12px;opacity:.82;margin-top:2px}"
      + ".hdr h1{font-size:16px;font-weight:700;letter-spacing:1px;word-break:break-word}"
      + ".hdr .sub{font-size:11px;opacity:.8;margin-top:3px;letter-spacing:1px;text-transform:uppercase}"
      + ".body{padding:24px;overflow:visible}"
      + ".rec-no{text-align:center;font-size:12px;color:#888;margin-bottom:18px}"
      + ".amount-box{background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
      + ".amount-box .lbl{font-size:11px;color:#16a34a;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}"
      + ".amount-box .val{font-size:30px;font-weight:800;color:#16a34a;word-break:break-word}"
      + ".actions{padding:0 24px 24px}"
      + ".btn-dl{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:15px;border-radius:10px;background:" + primary + ";border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;text-decoration:none;transition:opacity .2s}"
      + ".btn-dl:hover{opacity:.9}.btn-dl:disabled{opacity:.6;cursor:not-allowed}"
      + ".footer{margin-top:16px;font-size:11px;color:#aaa;text-align:center;line-height:1.8;padding-bottom:8px}"
      + "img{max-width:100%;height:auto}"
      + "@media print{"
      + "*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;overflow:visible!important}"
      + "body{background:#fff!important;padding:0!important}"
      + ".wrap{max-width:100%!important}"
      + ".actions,.no-print{display:none!important}"
      + ".card{box-shadow:none!important;border-radius:0!important}"
      + ".hdr{background:" + primary + "!important;color:#fff!important}"
      + ".amount-box{background:#f0fdf4!important;border-color:#bbf7d0!important}"
      + "}"
      + "</style>"
      + "</head><body><div class='wrap'>"
      + "<div class='brand'><div class='name'>FEEFLOW</div><div class='sub'>Fee Management Platform</div></div>"
      + "<div class='card' id='receipt-card'>"
      + "<div class='hdr'>" + brandLogo + "<div><h1>" + school + "</h1>" + tagline + "<div class='sub'>Official Payment Receipt</div></div></div>"
      + "<div class='body'>"
      + "<div class='rec-no'>Receipt No: <strong style='color:#333;font-family:monospace'>" + escHtml(receipt.receiptNo) + "</strong></div>"
      + "<div class='amount-box'><div class='lbl'>Amount Received</div><div class='val'>KES " + fmtKE(receipt.amount) + "</div></div>"
      + rows
      + "<div style='margin-top:14px;padding:11px 14px;border-radius:9px;background:" + (balance > 0 ? "#fff5f5" : "#f0fdf4") + ";border:1px solid " + (balance > 0 ? "#fecaca" : "#bbf7d0") + ";display:flex;justify-content:space-between;font-weight:700;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact'>"
      + "<span style='color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>Outstanding Balance</span>"
      + "<span style='color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>" + (balance > 0 ? "KES " + fmtKE(balance) : "Cleared &#10003;") + "</span></div>"
      + "<div class='footer'>Thank you for your payment &mdash; " + school + "<br><em>Powered by FeeFlow</em></div>"
      + "</div></div>"
      // ── Download button lives outside receipt-card so it won't appear in the PDF ──
      + "<div class='actions'>"
      + "<a class='btn-dl' href='/r/" + encodeURIComponent(receipt.token) + "/pdf'>&#8659; Download Receipt PDF</a>"
      + "</div>"
      + "</div>"
      + "</body></html>";

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("receipt page:", e); res.status(500).send("<!DOCTYPE html><html><body style='font-family:Arial;padding:40px;text-align:center'><h2 style='color:#c00'>Could not load receipt</h2><p>Something went wrong on our end. Please try again or contact the school directly.</p></body></html>"); }
});

// ─── INVOICES API ─────────────────────────────────────────────────────────────
app.get("/api/invoices", requireAuth, requirePermission("invoices.view"), async (req, res) => {
  try {
    const take = Math.min(Number(req.query.limit || 50), 200);
    const cursor = req.query.cursor ? { id: req.query.cursor } : undefined;
    const invoices = await prisma.invoice.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    if (!invoices.length) {
      res.setHeader("X-Total-Count", "0");
      return res.json([]);
    }

    // CORRECT BALANCE DERIVATION for invoice list:
    // Old approach: filter payments by invoice.createdAt — silently excluded payments
    //   made before the invoice was issued, creating phantom balances.
    // New approach: for each invoice, sum all StudentCharge rows linked to it,
    //   then sum all non-reversed payments for that student in the invoice's term.
    //   This gives the true outstanding for each invoice.
    const studentIds = [...new Set(invoices.map(i => i.studentId))];
    const termIds    = [...new Set(invoices.map(i => i.termId).filter(Boolean))];

    const [allCharges, allPayments] = await Promise.all([
      // Charges grouped by invoiceId
      prisma.studentCharge.findMany({
        where: { invoiceId: { in: invoices.map(i => i.id) }, voidedAt: null },
        select: { invoiceId: true, amount: true },
      }),
      // All valid payments for these students in these terms
      prisma.payment.groupBy({
        by: ["studentId"],
        where: { studentId: { in: studentIds }, reversedAt: null, isReversal: false, deletedAt: null },
        _sum: { amount: true },
      }),
    ]);

    // Map charges per invoice
    const chargesByInvoice = {};
    for (const c of allCharges) {
      chargesByInvoice[c.invoiceId] = (chargesByInvoice[c.invoiceId] || 0) + c.amount;
    }

    // Map payments per student (global — payments apply to the student, not a specific invoice)
    const paidByStudent = Object.fromEntries(allPayments.map(r => [r.studentId, Number(r._sum.amount ?? 0)]));

    const balances = await deriveStudentBalancesBatch(studentIds);
    const enriched = invoices.map(inv => {
      const invoiceCharges = chargesByInvoice[inv.id] ?? null;
      const chargesTotal   = invoiceCharges !== null ? invoiceCharges : inv.totalFee;
      const studentBalance = balances.get(inv.studentId);
      const snap           = invoiceSnapshot(inv);
      const livePaid       = snap.totalPaidToDate;
      const liveBalance    = snap.totalDueNow;
      const hasLedger      = invoiceCharges !== null;
      return { ...inv, ...snap, livePaid, liveBalance, chargesTotal, hasLedger, liveAccountBalance: studentBalance?.outstanding ?? 0 };
    });

    res.setHeader("X-Total-Count", enriched.length.toString());
    if (enriched.length === take) res.setHeader("X-Next-Cursor", enriched[enriched.length - 1].id);
    res.json(enriched);
  } catch (e) { return apiError(res, e, "get invoices", req); }
});

app.post("/api/invoices/preview", requireAuth, requirePermission("invoices.create"), requirePlan("invoices"), async (req, res) => {
  const { studentId, selectedChargeIds } = req.body;
  if (!studentId) return res.status(400).json({ message: "studentId required" });
  try {
    const [student, activeTerm] = await Promise.all([
      prisma.student.findFirst({ where: { id: studentId, userId: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    if (!student) return res.status(404).json({ message: "Student not found" });
    const quote = await quoteInvoiceCharges({
      studentId,
      userId: req.userId,
      termId: activeTerm?.id || null,
      selectedChargeIds,
    });
    if (!quote.lines.length) {
      return res.status(400).json({ message: "This student has no fee charges yet. Add fees from the student's profile first." });
    }
    const displayTotalDueNow = Math.max(0, quote.displayFeeTotal - quote.snapshot.totalPaidToDate);
    res.json({
      accountTotalCharges: quote.snapshot.accountTotalCharges,
      totalPaidToDate: quote.snapshot.totalPaidToDate,
      totalDueNow: displayTotalDueNow,
      newChargesTotal: quote.snapshot.newChargesTotal,
      displayFeeTotal: quote.displayFeeTotal,
      previousOutstanding: quote.snapshot.previousOutstanding,
      feeLines: quote.lines,
    });
  } catch (e) { return apiError(res, e, "preview invoice", req); }
});

app.post("/api/invoices", requireAuth, requirePermission("invoices.create"), requirePlan("invoices"), async (req, res) => {
  const { studentIds, dueDate, termName, note, selectedChargeIds, sendDate, channels } = req.body;
  if (!studentIds?.length) return res.status(400).json({ message: "Select at least one student" });
  if (!dueDate)            return res.status(400).json({ message: "Due date is required" });
  try {
    const [user, activeTerm] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const students         = await prisma.student.findMany({ where: { id: { in: studentIds }, userId: req.userId } });
    const selectedChannels = [...new Set((Array.isArray(channels) ? channels : [channels])
      .map(ch => String(ch || "").toLowerCase().trim())
      .filter(ch => ch === "sms" || ch === "email" || ch === "whatsapp"))];
    if (!selectedChannels.length) return res.status(400).json({ message: "Select at least one delivery channel" });
    const results          = [];
    const errors           = [];

    for (const student of students) {
      const token     = genToken();
      const invoiceNo = await nextInvoiceNo(req.userId);
      const idempotencyKey = invoiceIdempotencyKey({
        userId: req.userId,
        studentId: student.id,
        termId: activeTerm?.id || null,
        dueDate,
        selectedChargeIds,
        sendDate,
        channels: selectedChannels,
      });

      const quote = await quoteInvoiceCharges({
        studentId: student.id,
        userId: req.userId,
        termId: activeTerm?.id || null,
        selectedChargeIds,
      });
      if (!quote.lines.length) {
        errors.push({ studentId: student.id, message: `${student.name} has no fee charges yet` });
        continue;
      }
      const invoiceLineTotal = quote.displayFeeTotal;
      const displayFeeBreakdownWithIds = quote.lines.map(line => ({
        typeName: line.typeName || line.description || "Fee",
        amount: Number(line.amount || 0),
        alreadyCharged: line.alreadyCharged ?? false,
        id: line.id,
      }));
      const displayFeeBreakdown = displayFeeBreakdownWithIds.map(({ id, ...rest }) => rest);
      const snapshot = quote.snapshot;

      const existingInvoice = await prisma.invoice.findFirst({ where: { idempotencyKey } });
      if (existingInvoice) {
        results.push(existingInvoice);
        continue;
      }

      // CRITICAL FIX: We no longer mutate student.fee when extra fees are added.
      //
      // OLD (broken) behaviour:
      //   student.fee was overwritten to 80,000 when Transport was added.
      //   Any balance = fee - paid already calculated was now wrong because
      //   the denominator changed under old payments.
      //
      // NEW (correct) behaviour:
      //   We associate existing StudentCharge rows with this invoice. The total charges
      //   are derived by SUM(StudentCharge) at query time. student.fee is only
      //   updated here to the HIGHER of its current value and the new invoice
      //   total — this maintains backward compatibility for queries that still
      //   use the legacy fallback, but is NOT the source of truth.
      //   The source of truth is StudentCharge.

      // ATOMIC: create invoice + associate StudentCharge rows in one transaction
      let invoice;
      try {
        invoice = await prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findFirst({ where: { idempotencyKey } });
        if (existing) return existing;
        // Update student.fee only for legacy compatibility — not the accounting source of truth
        const inv = await tx.invoice.create({
          data: {
            invoiceNo, token,
            idempotencyKey,
            studentId: student.id, userId: req.userId,
            studentName: student.name, className: student.cls, admNo: student.adm,
            termId: activeTerm?.id || null,
            totalFee: invoiceLineTotal,
            paid: snapshot.totalPaidToDate,
            balance: snapshot.totalDueNow,
            accountTotalCharges: snapshot.accountTotalCharges,
            totalPaidToDate: snapshot.totalPaidToDate,
            totalDueNow: snapshot.totalDueNow,
            newChargesTotal: snapshot.newChargesTotal,
            previousOutstanding: snapshot.previousOutstanding,
            dueDate: new Date(dueDate), termName: termName || null,
            feeBreakdown: displayFeeBreakdown, note: note || null,
            channels: selectedChannels,
            status: sendDate ? "scheduled" : "sent",
            scheduledFor: sendDate ? new Date(sendDate) : null,
            sentAt: sendDate ? null : new Date(),
          },
        });

        await createChargesFromInvoice({
          invoiceId:      inv.id,
          studentId:      student.id,
          userId:         req.userId,
          termId:         activeTerm?.id || null,
          selectedChargeIds,
        }, tx);

        return inv;
        });
      } catch (error) {
        if (error.code !== "P2002") throw error;
        invoice = await prisma.invoice.findFirst({ where: { idempotencyKey } });
        if (!invoice) throw error;
      }

      if (invoice?.id) {
        const signedToken = invoiceLinkToken(invoice);
        invoice = await prisma.invoice.update({ where: { id: invoice.id }, data: { token: signedToken } });
      }
      logAudit(req, { action: "invoice_created", entityType: "invoice", entityId: invoice.id, metadata: { studentId: student.id, totalDueNow: invoice.totalDueNow, status: invoice.status } });
      results.push(invoice);
    }
    const responsePayload = {
      invoices: results,
      queued: sendDate ? 0 : results.length,
      failed: 0,
      scheduled: !!sendDate,
      note: sendDate ? undefined : `${results.length} invoices created. Notifications sending in background.`,
    };
    if (errors.length) responsePayload.errors = errors;
    res.json(responsePayload);
   
    if (!sendDate) {
      setImmediate(async () => {
        const studentsById = new Map(students.map(student => [student.id, student]));
        for (const invoice of results) {
          const student = studentsById.get(invoice.studentId);
          if (!student) continue;

          if (selectedChannels.includes("sms") && student.parentPhone) {
            const paymentRef = studentBankPaymentReference(student);
            const msg = buildInvoiceMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, admNo: student.adm, totalFee: invoice.totalDueNow || invoice.balance || invoice.totalFee, dueDate, termName, note, token: invoice.token, paymentRef });
            sendSMS(student.parentPhone, msg, user)
              .then(smsResult => {
                if (smsResult?.messageId) return prisma.invoice.update({ where: { id: invoice.id }, data: { smsMessageId: smsResult.messageId, smsStatus: "queued" } });
                return null;
              })
              .then(() => logAudit(req, { action: "invoice_sent", entityType: "invoice", entityId: invoice.id, metadata: { channel: "sms" } }))
              .catch(e => {
                logger.error("invoice-sms", e.message, { studentId: student.id });
                prisma.invoice.update({ where: { id: invoice.id }, data: { smsStatus: "failed" } }).catch(() => {});
              });
          }

          if (selectedChannels.includes("email") && (student.parentEmail || student.email) && process.env.RESEND_API_KEY) {
            sendEmail(
              student.parentEmail || student.email,
              "Fee Invoice - " + student.name + (termName ? " | " + termName : ""),
              renderInvoiceEmail({
                schoolName: user.schoolName || "School",
                ...brandingPayload(user),
                studentName: student.name,
                className: student.cls,
                totalDueNow: invoice.totalDueNow || invoice.balance || invoice.totalFee,
                dueDate,
                token: invoice.token,
                paymentRef: studentBankPaymentReference(student),
              })
            ).catch(e => logger.error("invoice-email", e.message));
          }

          if (selectedChannels.includes("whatsapp") && student.parentPhone) {
            try {
              const wa = whatsappInvoiceTemplateParams({ user, student, invoice, dueDate, termName });
              enqueueWhatsApp(
                student.parentPhone,
                "feeflow_invoice",
                wa.headerParams,
                wa.bodyParams,
                wa.buttonSuffix,
                { invoiceId: invoice.id, studentId: invoice.studentId, schoolId: invoice.userId }
              ).catch(err => logger.warn("waQueue", "Invoice enqueue error", { error: safeErrorMessage(err), invoiceId: invoice.id }));
              logAudit(req, { action: "invoice_sent", entityType: "invoice", entityId: invoice.id, metadata: { channel: "whatsapp" } });
            } catch (e) {
              logger.warn("whatsapp", "Invoice WhatsApp dispatch failed", { error: safeErrorMessage(e), invoiceId: invoice.id });
            }
          }
        }
      });
    }
  } catch (e) {
    logger.error("create invoices", "invoice_create_failed", {
      errorMessage: safeErrorMessage(e),
      prismaCode: e?.code,
      prismaMeta: e?.meta,
      reqId: req.reqId,
      studentIdsCount: Array.isArray(studentIds) ? studentIds.length : 0,
    });
    return apiError(res, e, "create invoices", req);
  }
});

app.post("/api/invoices/:id/resend", requireAuth, requirePermission("invoices.send"), requirePlan("invoices"), async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const channels = Array.isArray(invoice.channels) ? invoice.channels : [];
    let allOk = true;
    if (channels.includes("sms") && student.parentPhone) {
      const msg = buildInvoiceMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, admNo: student.adm, totalFee: invoice.totalDueNow || invoice.balance || invoice.totalFee, dueDate: invoice.dueDate, termName: invoice.termName, note: invoice.note, token: invoice.token, paymentRef: studentBankPaymentReference(student) });
      try { await sendSMS(student.parentPhone, msg, user); } catch { allOk = false; }
    }
    if (channels.includes("email") && (student.parentEmail || student.email)) {
      try { await sendEmail(student.parentEmail || student.email, "Fee Invoice - " + student.name, renderInvoiceEmail({
        schoolName: user.schoolName || "School",
        ...brandingPayload(user),
        studentName: student.name,
        className: student.cls,
        totalDueNow: invoice.totalDueNow || invoice.balance || invoice.totalFee,
        dueDate: invoice.dueDate,
        token: invoice.token,
        paymentRef: studentBankPaymentReference(student),
      })); }
      catch { allOk = false; }
    }
    if (channels.includes("whatsapp") && student.parentPhone) {
      try {
        const wa = whatsappInvoiceTemplateParams({ user, student, invoice });
        await enqueueWhatsApp(
          student.parentPhone,
          "feeflow_invoice",
          wa.headerParams,
          wa.bodyParams,
          wa.buttonSuffix,
          { invoiceId: invoice.id, studentId: invoice.studentId, schoolId: invoice.userId }
        );
      } catch (e) {
        logger.warn("whatsapp", "Invoice WhatsApp dispatch failed", { error: safeErrorMessage(e), invoiceId: invoice.id });
      }
    }
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk });
  } catch (e) { return apiError(res, e, "resend invoice"); }
});

app.post("/api/invoices/:id/regenerate-link", requireAuth, requirePermission("invoices.send"), async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const token = invoiceLinkToken(invoice);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { token } });
    await logAudit(req, { action: "invoice_link_regenerated", entityType: "invoice", entityId: invoice.id });
    res.json({ token, url: publicInvoiceLink(token) });
  } catch (e) { return apiError(res, e, "regenerate invoice link", req); }
});

// ─── RECEIPTS API ─────────────────────────────────────────────────────────────
app.get("/api/receipts", requireAuth, requirePermission("receipts.view"), async (req, res) => {
  try {
    const take = Math.min(Number(req.query.limit || 50), 200);
    const cursor = req.query.cursor ? { id: req.query.cursor } : undefined;
    const receipts   = await prisma.receipt.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    const studentIds = [...new Set(receipts.map(r => r.studentId).filter(Boolean))];

    // Derive all balances in one batch — never from student.fee - student.paid
    const balances = await deriveStudentBalancesBatch(studentIds);

    const enriched = receipts.map(r => {
      const lb = balances.get(r.studentId);
      // Show the snapshot balance stored on the receipt (what it was at creation time)
      // plus the live outstanding for current context. Both are useful to accountants.
      return {
        ...r,
        balance:        r.balance,          // historical snapshot — what receipt showed at issue
        liveBalance:    lb?.outstanding ?? r.balance,  // current derived balance
        totalCharges:   lb?.totalCharges  ?? null,
        totalPaid:      lb?.totalPaid     ?? null,
      };
    });
    res.setHeader("X-Total-Count", enriched.length.toString());
    if (enriched.length === take) res.setHeader("X-Next-Cursor", enriched[enriched.length - 1].id);
    res.json(enriched);
  } catch (e) { return apiError(res, e, "get receipts", req); }
});

app.post("/api/receipts/manual", requireAuth, requirePermission("receipts.create"), async (req, res) => {
  const { paymentId, studentId, channels } = req.body;
  if (!paymentId) return res.status(400).json({ message: "Payment ID required" });
  try {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, userId: req.userId } });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    const resolvedStudentId = studentId || payment.studentId;
    const student = await prisma.student.findFirst({
      where: {
        id: resolvedStudentId,
        userId: req.userId,
        deletedAt: null,
      },
    });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const selectedChannels = [...new Set((Array.isArray(channels) ? channels : [channels])
      .map(ch => String(ch || "").toLowerCase().trim())
      .filter(ch => ch === "sms" || ch === "email" || ch === "whatsapp"))];
    let token       = genToken();
    const receiptNo = await nextReceiptNo(req.userId);

    // LEDGER-DERIVED balance — snapshot at receipt creation time
    const lb = await deriveStudentBalance(student.id);

    let receipt   = await prisma.receipt.create({
      data: {
        userId: req.userId, paymentId: payment.id, studentId: student.id,
        studentName: student.name, admNo: student.adm, className: student.cls,
        amount: payment.amount, method: payment.method, txnRef: payment.txnRef || null,
        paidAt: payment.createdAt, token, receiptNo,
        channels: selectedChannels.length ? selectedChannels : ["sms"],
        type: "manual", balance: lb.outstanding, status: "pending",
      },
    });
    receipt = await prisma.receipt.update({ where: { id: receipt.id }, data: { token: receiptLinkToken(receipt) } });
    token = receipt.token;
    logAudit(req, { action: "receipt_generated", entityType: "receipt", entityId: receipt.id, metadata: { paymentId: payment.id, studentId: student.id, amount: payment.amount } });
    const msg = buildReceiptMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, amount: payment.amount, method: payment.method, token, txnRef: payment.txnRef, balance: receipt.balance });
    let allOk = true;
    if (selectedChannels.includes("sms") && student.parentPhone) {
      try {
        const smsResult = await sendSMS(student.parentPhone, msg, user);
        if (smsResult?.messageId) await prisma.receipt.update({ where: { id: receipt.id }, data: { smsMessageId: smsResult.messageId, smsStatus: "queued" } }).catch(() => {});
      } catch (e) {
        logger.error("manual-receipt-sms", e.message);
        await prisma.receipt.update({ where: { id: receipt.id }, data: { smsStatus: "failed" } }).catch(() => {});
        allOk = false;
      }
    }
    if (selectedChannels.includes("email") && (student.parentEmail || student.email)) {
      try { await sendEmail(student.parentEmail || student.email, "Payment Receipt - " + student.name, renderReceiptEmail({
        schoolName: user.schoolName || "School",
        ...brandingPayload(user),
        studentName: student.name,
        className: student.cls,
        admNo: student.adm,
        amount: payment.amount,
        method: payment.method,
        token,
        txnRef: payment.txnRef,
        paidAt: payment.createdAt,
        balance: receipt.balance,
        parentName: student.parentName,
        parentPhone: student.parentPhone,
      })); }
      catch (e) { logger.error("manual-receipt-email", e.message); allOk = false; }
    }
    if (selectedChannels.includes("whatsapp") && student.parentPhone) {
      try {
        const wa = whatsappReceiptTemplateParams({ user, student, receipt, payment, balance: receipt.balance });
        await enqueueWhatsApp(
          student.parentPhone,
          "feeflow_receipt",
          wa.headerParams,
          wa.bodyParams,
          wa.buttonSuffix,
          { receiptId: receipt.id, studentId: receipt.studentId, schoolId: receipt.userId }
        );
      } catch (e) {
        logger.warn("whatsapp", "Receipt WhatsApp dispatch failed", { error: safeErrorMessage(e), receiptId: receipt.id });
      }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk, receipt });
  } catch (e) { return apiError(res, e, "send manual receipt", req); }
});

app.post("/api/receipts/:id/resend", requireAuth, requirePermission("receipts.view"), async (req, res) => {
  try {
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    const student = await prisma.student.findUnique({ where: { id: receipt.studentId } });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    const msg      = buildReceiptMessage({ schoolName: user.schoolName || "School", studentName: receipt.studentName, className: receipt.className, amount: receipt.amount, method: receipt.method, token: receipt.token, txnRef: receipt.txnRef, balance: receipt.balance });
    const channels = Array.isArray(receipt.channels) ? receipt.channels : [];
    let allOk = true;
    if (student?.parentPhone) {
      try { await sendSMS(student.parentPhone, msg, user); } catch { allOk = false; }
    }
    if (channels.includes("email") && (student?.parentEmail || student?.email)) {
      try { await sendEmail(student.parentEmail || student.email, "Payment Receipt - " + receipt.studentName, renderReceiptEmail({
        schoolName: user.schoolName || "School",
        ...brandingPayload(user),
        studentName: receipt.studentName,
        className: receipt.className,
        admNo: receipt.admNo,
        amount: receipt.amount,
        method: receipt.method,
        token: receipt.token,
        txnRef: receipt.txnRef,
        paidAt: receipt.paidAt,
        balance: receipt.balance,
        parentName: student?.parentName,
        parentPhone: student?.parentPhone,
      })); }
      catch { allOk = false; }
    }
    if (channels.includes("whatsapp") && student?.parentPhone) {
      try {
        const wa = whatsappReceiptTemplateParams({ user, student, receipt, balance: receipt.balance });
        await enqueueWhatsApp(
          student.parentPhone,
          "feeflow_receipt",
          wa.headerParams,
          wa.bodyParams,
          wa.buttonSuffix,
          { receiptId: receipt.id, studentId: receipt.studentId, schoolId: receipt.userId }
        );
      } catch (e) {
        logger.warn("whatsapp", "Receipt WhatsApp dispatch failed", { error: safeErrorMessage(e), receiptId: receipt.id });
      }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk });
  } catch (e) { return apiError(res, e, "resend receipt"); }
});

app.post("/api/receipts/:id/regenerate-link", requireAuth, requirePermission("receipts.view"), async (req, res) => {
  try {
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    const token = receiptLinkToken(receipt);
    await prisma.receipt.update({ where: { id: receipt.id }, data: { token } });
    await logAudit(req, { action: "receipt_link_regenerated", entityType: "receipt", entityId: receipt.id });
    res.json({ token, url: publicReceiptLink(token) });
  } catch (e) { return apiError(res, e, "regenerate receipt link", req); }
});

// ─── AUTO-RECEIPT (Max plan) ──────────────────────────────────────────────────
// WHY: The old receipt stored balance = student.fee - student.paid at creation
// time. student.paid is a mutable accumulator — if another payment or reversal
// happens later, the stored balance on all previous receipts becomes wrong.
// Now: balance is derived from the ledger at receipt creation time (immutable
// snapshot). The receipt correctly shows "balance remaining AFTER this payment".
async function autoSendReceipt({ payment, student, user }) {
  try {
    let token       = genToken();
    const receiptNo = await nextReceiptNo(user.id);

    // Derive the post-payment balance from the ledger — never from student.paid
    const lb = await deriveStudentBalance(student.id);
    const receiptBalance = lb.outstanding; // balance remaining after this payment
    const channels = ["sms", "email"];
    if (user.whatsappEnabled) channels.push("whatsapp");

    let receipt   = await prisma.receipt.create({
      data: {
        userId: user.id, paymentId: payment.id, studentId: student.id,
        studentName: student.name, admNo: student.adm, className: student.cls,
        amount: payment.amount, method: payment.method, txnRef: payment.txnRef || null,
        paidAt: payment.createdAt, token, receiptNo,
        channels, type: "auto",
        balance: receiptBalance, // ledger-derived snapshot at receipt creation time
        status: "pending",
      },
    });
    const signedReceiptToken = receiptLinkToken(receipt);
    receipt = await prisma.receipt.update({ where: { id: receipt.id }, data: { token: signedReceiptToken } });
    token = signedReceiptToken;
    const msg = buildReceiptMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, amount: payment.amount, method: payment.method, token, txnRef: payment.txnRef, balance: receiptBalance });
    let allOk = true;
    if (channels.includes("sms") && student.parentPhone) {
      try { await sendSMS(student.parentPhone, msg, user); }
      catch (e) { logger.error("auto-receipt-sms", e.message); allOk = false; }
    }
    if (channels.includes("email") && (student.parentEmail || student.email)) {
      try { await sendEmail(student.parentEmail || student.email, "Payment Receipt - " + student.name, renderReceiptEmail({
        schoolName: user.schoolName || "School",
        ...brandingPayload(user),
        studentName: student.name,
        className: student.cls,
        admNo: student.adm,
        amount: payment.amount,
        method: payment.method,
        token,
        txnRef: payment.txnRef,
        paidAt: payment.createdAt,
        balance: receiptBalance,
        parentName: student.parentName,
        parentPhone: student.parentPhone,
      })); }
      catch (e) { logger.error("auto-receipt-email", e.message); allOk = false; }
    }
    if (channels.includes("whatsapp") && student.parentPhone) {
      try {
        const wa = whatsappReceiptTemplateParams({ user, student, receipt, payment, balance: receiptBalance });
        enqueueWhatsApp(
          student.parentPhone,
          "feeflow_receipt",
          wa.headerParams,
          wa.bodyParams,
          wa.buttonSuffix,
          { receiptId: receipt.id, studentId: receipt.studentId, schoolId: receipt.userId }
        ).catch(err => logger.warn("waQueue", "Receipt enqueue error", { error: safeErrorMessage(err), receiptId: receipt.id }));
      } catch (e) {
        logger.warn("whatsapp", "Receipt WhatsApp dispatch failed", { error: safeErrorMessage(e), receiptId: receipt.id });
      }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
  } catch (e) { logger.error("auto-receipt", e.message); }
}

// ─── SCHEDULED INVOICE PROCESSOR ─────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  let schedulerRunning = false;
  setInterval(async () => {
  if (schedulerRunning) return; // prevent double-send if processing takes > 60s
  schedulerRunning = true;
  try {
    const due = await prisma.invoice.findMany({ where: { status: "scheduled", scheduledFor: { lte: new Date() } } });
    if (!due.length) return;

    // Batch fetch all needed students and users to avoid N+1 queries
    const studentIds = [...new Set(due.map(i => i.studentId))];
    const userIds    = [...new Set(due.map(i => i.userId))];
    const [students, users] = await Promise.all([
      prisma.student.findMany({ where: { id: { in: studentIds } } }),
      prisma.user.findMany({ where: { id: { in: userIds } } }),
    ]);
    const studentMap = Object.fromEntries(students.map(s => [s.id, s]));
    const userMap    = Object.fromEntries(users.map(u => [u.id, u]));

    for (const invoice of due) {
      const student = studentMap[invoice.studentId];
      const user    = userMap[invoice.userId];
      if (!student || !user) continue;
      const channels = Array.isArray(invoice.channels) ? invoice.channels : [];
      let allOk = true;
      if (channels.includes("sms") && student.parentPhone) {
        const msg = buildInvoiceMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, admNo: student.adm, totalFee: invoice.totalDueNow || invoice.balance || invoice.totalFee, dueDate: invoice.dueDate, termName: invoice.termName, note: invoice.note, token: invoice.token, paymentRef: studentBankPaymentReference(student) });
        try { await sendSMS(student.parentPhone, msg, user); } catch { allOk = false; }
      }
      if (channels.includes("email") && (student.parentEmail || student.email)) {
        try { await sendEmail(student.parentEmail || student.email, "Fee Invoice - " + student.name, renderInvoiceEmail({
          schoolName: user.schoolName || "School",
          ...brandingPayload(user),
          studentName: student.name,
          className: student.cls,
          totalDueNow: invoice.totalDueNow || invoice.balance || invoice.totalFee,
          dueDate: invoice.dueDate,
          token: invoice.token,
          paymentRef: studentBankPaymentReference(student),
        })); }
        catch { allOk = false; }
      }
      if (channels.includes("whatsapp") && student.parentPhone) {
        try {
          const wa = whatsappInvoiceTemplateParams({ user, student, invoice });
          enqueueWhatsApp(
            student.parentPhone,
            "feeflow_invoice",
            wa.headerParams,
            wa.bodyParams,
            wa.buttonSuffix,
            { invoiceId: invoice.id, studentId: invoice.studentId, schoolId: invoice.userId }
          ).catch(err => logger.warn("waQueue", "Invoice enqueue error", { error: safeErrorMessage(err), invoiceId: invoice.id }));
        } catch (e) {
          logger.warn("whatsapp", "Invoice WhatsApp dispatch failed", { error: safeErrorMessage(e), invoiceId: invoice.id });
        }
      }
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
  finally { schedulerRunning = false; }
  }, 60 * 1000);
}

// ─── SMS DELIVERY REPORT WEBHOOK (Africa's Talking) ─────────────────────────
// AT posts delivery reports here when an SMS reaches the handset (or fails).
// Configure in AT dashboard: Settings → SMS → Delivery Reports
// URL: https://your-backend.com/api/sms/delivery
// This updates status from "queued" → "delivered" or "failed"
app.post("/api/sms/delivery", async (req, res) => {
  const configuredSecret = process.env.SMS_WEBHOOK_SECRET;
  const suppliedSecret = req.get("x-sms-webhook-secret") || req.get("x-callback-secret") || null;

  if (!configuredSecret) {
    logger.warn("sms", "SMS_WEBHOOK_SECRET is not set. Rejecting delivery webhook to prevent unauthenticated updates.", {
      reqId: req.reqId,
      ip: req.ip,
    });
    return res.sendStatus(401);
  }

  if (!suppliedSecret || !timingSafeEqualString(suppliedSecret, configuredSecret)) {
    logger.warn("sms", "SMS delivery webhook rejected: invalid or missing secret", {
      reqId: req.reqId,
      ip: req.ip,
      hasHeader: !!suppliedSecret,
    });
    return res.sendStatus(401);
  }

  try {
    const { id, status, phoneNumber, deliveryStatus: providerDeliveryStatus, networkCode, failureReason } = req.body || {};

    if (!id || !status) {
      logger.warn("sms", "SMS delivery webhook missing required fields", { reqId: req.reqId });
      return res.sendStatus(400);
    }

    const normalizedDeliveryStatus =
      ["DeliveredToTerminal", "Success"].includes(status) ? "delivered" :
      ["DeliveredToNetwork"].includes(status)             ? "queued" :
      ["Failed", "RejectedByNetwork", "InvalidPhoneNumber", "DeliveryFailure", "MessageRejected"].includes(status) ? "failed" : "queued";

    logger.info("sms", "delivery_report", {
      id,
      phone: phoneNumber ? maskSafaricomPhone(phoneNumber) : null,
      status,
      deliveryStatus: providerDeliveryStatus || null,
      networkCode: networkCode || null,
      reqId: req.reqId,
    });

    const [inv, rec] = await Promise.all([
      prisma.invoice.updateMany({ where: { smsMessageId: id }, data: { smsStatus: normalizedDeliveryStatus } }),
      prisma.receipt.updateMany({ where: { smsMessageId: id }, data: { smsStatus: normalizedDeliveryStatus } }),
    ]);

    if (inv.count || rec.count) {
      logger.info("sms", "delivery_status_updated", {
        id,
        invoiceCount: inv.count,
        receiptCount: rec.count,
        status: normalizedDeliveryStatus,
        reqId: req.reqId,
      });
      await logAudit(req, {
        action: "sms_delivery_status_updated",
        entityType: "sms_log",
        entityId: id,
        metadata: {
          status,
          deliveryStatus: providerDeliveryStatus || null,
          networkCode: networkCode || null,
          failureReason: failureReason || null,
        },
      }).catch(() => {});
    }

    return res.sendStatus(200);
  } catch (e) {
    logger.error("sms", "SMS delivery webhook processing failed", {
      error: safeErrorMessage(e),
      reqId: req.reqId,
    });
    return res.sendStatus(500);
  }
});

// ─── HEALTH & FALLBACKS ───────────────────────────────────────────────────────
// ─── PUBLIC PAY NOW — STK push from invoice page (no auth required) ─────────
// Uses the SCHOOL'S OWN M-Pesa credentials pulled from the invoice's userId.
// Rate limited to prevent abuse — 5 attempts per phone per 10 minutes.
const payNowLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  // Use phone number as key when available, fallback to IP with IPv6 support
  keyGenerator: (req, res) => {
    if (req.body?.phone) return req.body.phone;
    // Use built-in ipKeyGenerator for IPv6 compatibility
    return ipKeyGenerator(req);
  },
  skip: (req) => false,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many payment attempts. Please wait 10 minutes." },
});

app.post("/api/pay/:invoiceToken", payNowLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number is required" });

  // Outage mode — warn parent but still allow the attempt
  // We don't block because they may still succeed; we just set expectations
  const degradedWarning = outageState.degraded ? {
    warning: "M-Pesa is currently experiencing delays. Your payment may take longer than usual to confirm. Don't send multiple requests.",
    degraded: true,
  } : null;

  try {
    // Load invoice + school credentials in one query
    const baseInvoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    const invoice = baseInvoice && await prisma.invoice.findFirst({
      where: { id: baseInvoice.id },
      include: { user: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } }) || {
      id: invoice.studentId, name: invoice.studentName, adm: invoice.admNo,
      cls: invoice.className,
    };
    const school = invoice.user;

    // LEDGER-DERIVED balance — the only correct way to get outstanding amount
    // This ensures the STK push amount is correct even if extra fees were added
    // after the invoice was originally sent.
    const lb      = await deriveStudentBalance(invoice.studentId);
    const balance = lb.outstanding;

    if (balance <= 0) return res.status(400).json({ error: "This invoice is already fully paid." });
    if (!school.mpesaConfigured) return res.status(503).json({ error: "This school has not set up M-Pesa payments yet. Please pay at the school office." });

    // Guard: block if there's already an in-flight payment for this student (prevents double-charges)
    const inFlight = await prisma.mpesaTransaction.findFirst({
      where: {
        studentId: student.id,
        status: { in: ["pending", "awaiting_callback", "processing", "callback_delayed"] },
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
    });
    if (inFlight) {
      return res.status(409).json({
        error: inFlight.status === "callback_delayed"
          ? "A payment is still being confirmed. Please wait a few minutes before trying again. If it doesn't complete, contact the school."
          : "A payment request is already being processed. Please enter your PIN on your phone. Don't send another request.",
        inFlight: true,
        checkoutRequestId: inFlight.checkoutRequestId,
        CheckoutRequestID: inFlight.checkoutRequestId,
      });
    }

    // Per-student retry limit — max 5 attempts per 24 hours
    const dayAgo   = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const attempts = await prisma.mpesaTransaction.count({
      where: { studentId: student.id, createdAt: { gte: dayAgo } },
    });
    const STK_DAILY_LIMIT = process.env.NODE_ENV === "development" ? 999 : 5;
    if (attempts >= STK_DAILY_LIMIT) {
      return res.status(429).json({
        error: "Too many payment attempts today. Please pay at the school office or contact the school directly.",
      });
    }

    // Decrypt THIS SCHOOL'S credentials — each school has its own Daraja account
    const CK = decrypt(school.mpesaConsumerKey);
    const CS = decrypt(school.mpesaConsumerSecret);
    const SC = school.mpesaShortcode;
    const PK = decrypt(school.mpesaPasskey);

    if (!CK || !CS || !SC || !PK) return res.status(503).json({ error: "M-Pesa credentials incomplete. Please contact the school." });

    const cleanPhone = normalizeSafaricomStkPhone(phone);
    if (!cleanPhone) {
      logger.warn("pay", "Invalid STK phone number", { reqId: req.reqId, phone: maskSafaricomPhone(phone) });
      return res.status(400).json({ error: "Enter a valid Safaricom number, e.g. 0701475742 or 0112345678" });
    }

    const stkSecret = process.env.MPESA_CALLBACK_SECRET || "";
    const CB = stkSecret
      ? `${process.env.BACKEND_URL || "http://localhost:3000"}/api/mpesa/stk-cb/${stkSecret}/${school.id}`
      : `${process.env.BACKEND_URL || "http://localhost:3000"}/api/mpesa/callback/${school.id}`;

    const auth = Buffer.from(CK + ":" + CS).toString("base64");
    const tokenRes = await fetchWithTimeout(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: "Basic " + auth } }
    );
    const { access_token } = await tokenRes.json();
    if (!access_token) return res.status(502).json({ error: "Failed to connect to M-Pesa. Please try again." });

    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(SC + PK + ts).toString("base64");
    logger.info("pay", "Sending public STK push", { userId: school.id, studentId: student.id, reqId: req.reqId, phone: maskSafaricomPhone(cleanPhone) });

    const d = await (await fetchWithTimeout("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + access_token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: SC, Password: pw, Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(balance),
        PartyA: cleanPhone, PartyB: SC, PhoneNumber: cleanPhone,
        CallBackURL: CB,
        AccountReference: "FF-" + student.id,
        TransactionDesc: "Fee payment - " + student.name,
      }),
    })).json();

    if (d.ResponseCode === "0") {
      // Track this push in MpesaTransaction for state machine + retry eligibility
      await prisma.mpesaTransaction.create({
        data: {
          checkoutRequestId: d.CheckoutRequestID,
          merchantRequestId: d.MerchantRequestID || null,
          studentId: student.id,
          userId: school.id,
          amount: Math.round(balance),
          phone: cleanPhone,
          status: "awaiting_callback",
        },
      }).catch(e => console.error("[PAY] Failed to create transaction record:", e.message));

      res.json({ success: true, checkoutRequestId: d.CheckoutRequestID, CheckoutRequestID: d.CheckoutRequestID, MerchantRequestID: d.MerchantRequestID || null, amount: balance, ...(degradedWarning || {}) });
    } else {
      res.status(400).json({ error: d.errorMessage || d.ResponseDescription || "STK push failed. Please try again." });
    }
  } catch (e) {
    if (e.name === "AbortError") return res.status(504).json({ error: "M-Pesa timed out. Please try again." });
    return res.status(500).json({ error: e.message?.includes("M-Pesa") ? e.message : "Payment failed. Please try again." });
  }
});

// ─── PUBLIC PAYMENT STATUS POLL ──────────────────────────────────────────────
app.get("/api/pay/:invoiceToken/status", pollLimiter, async (req, res) => {
  try {
    const invoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    if (!invoice) return res.status(404).json({ error: "Not found" });

    // LEDGER-DERIVED balance — never from student.paid field
    const lb = await deriveStudentBalance(invoice.studentId);

    const latestTxn = await prisma.mpesaTransaction.findFirst({
      where:   { studentId: invoice.studentId },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      totalPaid: lb.totalPaid,
      totalCharges: lb.totalCharges,
      balance: lb.outstanding,
      cleared: lb.outstanding === 0,
      txStatus: latestTxn?.status || null,
      txMsg:    latestTxn?.resultDesc || null,
      checkoutRequestId: latestTxn?.checkoutRequestId || null,
      degraded: outageState.degraded,
    });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ─── RETRY ELIGIBILITY CHECK ──────────────────────────────────────────────────
app.get("/api/pay/:invoiceToken/stk-status/:checkoutRequestId", pollLimiter, async (req, res) => {
  try {
    const invoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    if (!invoice) return res.status(404).json({ error: "Not found" });

    const txn = await prisma.mpesaTransaction.findFirst({
      where: {
        checkoutRequestId: req.params.checkoutRequestId,
        studentId: invoice.studentId,
      },
    });
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    const status = adminStkStatus(txn.status);
    res.json({
      status,
      message: txn.resultDesc || null,
    });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/pay/:invoiceToken/retry-eligible", retryCheckLimiter, async (req, res) => {
  try {
    const invoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    if (!invoice) return res.status(404).json({ eligible: false, reason: "not_found" });

    // Use ledger-derived balance — not student.paid vs student.fee
    const lb = await deriveStudentBalance(invoice.studentId);
    if (lb.outstanding === 0) {
      return res.json({ eligible: false, reason: "already_paid" });
    }

    // Check for any in-flight transaction (pending/awaiting_callback) in last 5 min
    const inFlight = await prisma.mpesaTransaction.findFirst({
      where: {
        studentId: invoice.studentId,
        status: { in: ["pending", "awaiting_callback", "processing", "callback_delayed"] },
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (inFlight) {
      return res.json({
        eligible: false,
        reason: "in_flight",
        message: inFlight.status === "callback_delayed"
          ? "A payment is still being confirmed. Please wait a few minutes before trying again. If it doesn't complete, contact the school."
          : "A payment is already being processed. Please enter your PIN on your phone. Don't send another request.",
        checkoutRequestId: inFlight.checkoutRequestId,
      });
    }

    // Cooldown: 60 seconds between attempts
    const lastAttempt = await prisma.mpesaTransaction.findFirst({
      where:   { studentId: invoice.studentId },
      orderBy: { createdAt: "desc" },
    });
    if (lastAttempt) {
      const elapsed    = Date.now() - new Date(lastAttempt.createdAt).getTime();
      const cooldownMs = 60 * 1000;
      if (elapsed < cooldownMs) {
        return res.json({
          eligible: false,
          reason: "cooldown",
          retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000),
        });
      }
    }

    // Daily limit: max 5 attempts per 24 hours
    const dayAgo   = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const attempts = await prisma.mpesaTransaction.count({
      where: { studentId: invoice.studentId, createdAt: { gte: dayAgo } },
    });
    const STK_DAILY_LIMIT = process.env.NODE_ENV === "development" ? 999 : 5;
    if (attempts >= STK_DAILY_LIMIT) {
      return res.json({
        eligible: false,
        reason: "limit_reached",
        message: "Too many payment attempts today. Please pay at the school office or contact the school directly.",
      });
    }

    res.json({ eligible: true });
  } catch { res.status(500).json({ eligible: false, reason: "error" }); }
});

// ─── PARENT PORTAL API ────────────────────────────────────────────────────────
app.get("/api/portal/:invoiceToken", async (req, res) => {
  try {
    const baseInvoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    const invoice = baseInvoice && await prisma.invoice.findFirst({
      where: { id: baseInvoice.id },
      include: {
        user: {
          select: {
            schoolName: true,
            schoolLogoUrl: true,
            schoolPrimaryColor: true,
            mpesaConfigured: true,
          },
        },
      },
    });
    if (!invoice) return res.status(404).json({ error: "Portal not found" });

    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } }) || {
      id: invoice.studentId, name: invoice.studentName, adm: invoice.admNo,
      cls: invoice.className,
      daysOverdue: 0,
    };
    const school  = invoice.user;

    const invoicePayments = invoice.termId
      ? await prisma.payment.findMany({
          where: {
            studentId: invoice.studentId,
            termId: invoice.termId,
            reversedAt: null,
            isReversal: false,
            deletedAt: null,
          },
          select: {
            id: true,
            amount: true,
            method: true,
            receivedAt: true,
            txnRef: true,
          },
          orderBy: { receivedAt: "desc" },
          take: 20,
        })
      : [];

    // TODO: Add receipt.invoiceId in a future migration so public portals can scope receipts exactly to one invoice.
    const invoiceReceipts = await prisma.receipt.findMany({
      where: {
        studentId: invoice.studentId,
        userId: invoice.userId,
        createdAt: { gte: invoice.createdAt },
      },
      select: {
        id: true,
        receiptNo: true,
        amount: true,
        method: true,
        paidAt: true,
        token: true,
        userId: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const BACKEND = backendPublicBaseUrl();

    // LEDGER-DERIVED balance — the parent sees the correct outstanding even if
    // extra fees were added after the invoice was originally issued.
    const lb = await deriveStudentBalance(student.id);
    const snap = invoiceSnapshot(invoice);
    const portalStudent = {
      name: student.name,
      adm: student.adm,
      cls: student.cls,
      totalPaid: snap.totalPaidToDate,
      totalCharges: snap.accountTotalCharges,
      outstanding: snap.totalDueNow,
    };

    logger.info("portal", "parent_portal_accessed", {
      invoiceId: invoice.id,
      studentId: invoice.studentId,
      userId: invoice.userId,
      ip: req.ip,
      reqId: req.reqId,
    });

    res.json({
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        amount: snap.totalDueNow,
        dueDate: invoice.dueDate,
        status: invoice.status,
        term: invoice.termName || null,
        issuedAt: invoice.createdAt,
      },
      student: portalStudent,
      payments: invoicePayments.map(p => ({
        id: p.id,
        amount: p.amount,
        method: p.method,
        txnRef: p.txnRef || null,
        receivedAt: p.receivedAt,
        time: new Date(p.receivedAt).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }),
      })),
      receipts: invoiceReceipts.map(r => ({
        id: r.id,
        receiptNo: r.receiptNo,
        amount: r.amount,
        method: r.method,
        paidAt: r.paidAt,
        token: r.token,
        link: BACKEND + "/r/" + (r.token || receiptLinkToken(r)),
        time: new Date(r.paidAt).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }),
      })),
      school: {
        name: school.schoolName || "School",
        logoUrl: school.schoolLogoUrl || null,
        primaryColor: school.schoolPrimaryColor || null,
        mpesaConfigured: school.mpesaConfigured || false,
      },
      balance: lb.outstanding,
      cleared: lb.outstanding === 0,
      degraded: outageState.degraded,
    });
  } catch (e) { return res.status(500).json({ error: "Could not load portal data. Please refresh the page." }); }
});

// ─── PARENT PORTAL SUBMISSION (Bank / Paybill) ───────────────────────────────
// Public POST endpoint for parents to submit bank/paybill confirmation from the
// existing portal. Stores submission for admin review (UNDER_REVIEW) and saves
// an uploaded proof file under uploads/proofs/.
app.post("/p/:invoiceToken/bank-submit", bankSubmitLimiter, proofUploadMiddleware, async (req, res) => {
  try {
    const invoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const existingAttempts = await prisma.parentBankPaymentSubmission.count({
      where: {
        invoiceId: invoice.id,
        submittedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (existingAttempts >= 5) {
      return res.status(429).json({
        message: "Maximum submission attempts reached for this invoice today. Please contact the school directly.",
      });
    }
    const user = await prisma.user.findUnique({ where: { id: invoice.userId } });

    const fields = req.multipartForm && req.multipartForm.fields ? req.multipartForm.fields : {};
    const txnRef = (fields.transactionRef || "").trim() || null;
    const amount = Number(fields.amount ?? NaN);
    const paidAt = fields.paidAt ? new Date(fields.paidAt) : null;
    const parentName = (fields.parentName || "").trim() || null;
    const parentPhone = (fields.parentPhone || "").trim() || null;
    const note = (fields.note || "").trim() || null;

    if (!txnRef) return res.status(400).json({ message: "Transaction reference is required" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Amount must be a positive number" });
    if (!paidAt || Number.isNaN(paidAt.getTime())) return res.status(400).json({ message: "Paid date is required and must be valid" });

    // Save proof file
    let proofPath = null;
    if (req.proofFile) {
      const dir = path.join(UPLOAD_ROOT, "proofs");
      await fsp.mkdir(dir, { recursive: true });
      const suffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
      const filename = `${invoice.userId}-${suffix}-${req.proofFile.safeBase}${req.proofFile.ext}`;
      const filePath = path.join(dir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) return res.status(400).json({ message: "Invalid proof upload path." });
      await fsp.writeFile(resolved, req.proofFile.buffer, { flag: "wx" });
      proofPath = resolved;
    }

    // Mark duplicates early for admin visibility (don't block submission)
    let status = "UNDER_REVIEW";
    if (txnRef) {
      const [existingPayment, existingBank, existingSubmission] = await Promise.all([
        prisma.payment.findFirst({ where: { userId: invoice.userId, txnRef } }),
        prisma.bankTransaction.findFirst({ where: { userId: invoice.userId, transactionRef: txnRef } }),
        prisma.parentBankPaymentSubmission.findFirst({ where: { userId: invoice.userId, transactionRef: txnRef } }),
      ]);
      if (existingPayment || existingBank || existingSubmission) status = "DUPLICATE";
    }

    const submission = await prisma.parentBankPaymentSubmission.create({ data: {
      userId: invoice.userId,
      invoiceId: invoice.id,
      studentId: invoice.studentId,
      parentName,
      parentPhone,
      transactionRef: txnRef,
      amount,
      paidAt,
      note,
      proofPath,
      status,
      metadata: {},
    } });

    // Notify admins (school owner)
    try {
      const subject = `New bank payment submission — Invoice ${invoice.invoiceNo}`;
      const html = renderEmailLayout({
        schoolName: user?.schoolName || "FeeFlow",
        title: escHtml(subject),
        bodyHtml: `<p>A parent submitted a bank/paybill confirmation for invoice <strong>${escHtml(String(invoice.invoiceNo))}</strong>.</p>`
          + `<p><strong>Student:</strong> ${escHtml(invoice.studentName || "Unknown")}<br/><strong>Amount:</strong> KES ${fmtKE(amount)}<br/><strong>Txn Ref:</strong> ${escHtml(txnRef || "N/A")}</p>`
          + `<p><a href="${backendPublicBaseUrl()}/admin/payments/bank-confirmations">Review submissions</a></p>`,
        ctaText: "Review",
        link: backendPublicBaseUrl() + "/admin/payments/bank-confirmations",
      });
      if (user?.email) await sendEmail(user.email, subject, html).catch(() => {});
      if (user?.phone) {
        await sendSMS(user.phone, `New bank payment submitted for invoice ${invoice.invoiceNo}. Check admin panel.`, user).catch(() => {});
        try {
          const bodyParams = [
            waText(user?.schoolName || "School"),
            waText(new Date().toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })),
            waText(invoice.studentName || "Student"),
            waText(invoice.admNo || "-"),
            waText(invoice.className || "-"),
            waText(user?.bankName || "-"),
            waText(submission.transactionRef || "-"),
            waText(waDate(submission.paidAt)),
            waText(Number(submission.amount || 0).toLocaleString()),
            waText(submission.parentName || "-"),
          ];
          enqueueWhatsApp(
            user.phone,
            "feeflow_admin",
            [],
            bodyParams,
            null,
            { bankSubmissionId: submission.id, schoolId: invoice.userId }
          ).catch(err => logger.warn("waQueue", "Bank submission WA enqueue error", { error: safeErrorMessage(err), submissionId: submission.id }));
        } catch (waErr) {
          logger.warn("whatsapp", "Bank submission admin WhatsApp failed", { error: safeErrorMessage(waErr) });
        }
      }
    } catch (notifyErr) { logger.warn("notify", "bank_submission_notify_failed", { error: notifyErr.message, reqId: req.reqId }); }

    await logAudit(req, { action: "parent_bank_submission_created", entityType: "parent_bank_submission", entityId: submission.id, schoolOwnerId: invoice.userId, metadata: { invoiceId: invoice.id, txnRef: txnRef } });
    res.status(201).json({ message: "Submission recorded", id: submission.id, status: submission.status });
  } catch (e) {
    logger.error("parent-bank-submit", safeErrorMessage(e), {
      reqId: req.reqId,
      invoiceTokenPrefix: req.params.invoiceToken
        ? req.params.invoiceToken.slice(0, 8) + "..."
        : null,
      code: e?.code,
    });
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    if (e.code === "P2002") return res.status(409).json({ message: "This transaction reference has already been submitted or recorded." });
    return res.status(500).json({ message: "Could not submit this bank payment for review. Please check the details and try again.", reqId: req.reqId });
  }
});

// ─── PARENT PORTAL PAGE ───────────────────────────────────────────────────────
// Full HTML page served at /p/:invoiceToken
// Shows student balance overview + payment history + receipts
app.get("/p/:invoiceToken", async (req, res) => {
  try {
    const baseInvoice = await findInvoiceByPublicToken(req.params.invoiceToken);
    const invoice = baseInvoice && await prisma.invoice.findFirst({
      where: { id: baseInvoice.id },
      include: { user: { select: { schoolName: true, mpesaConfigured: true, ...USER_BRANDING_SELECT, ...USER_BANK_PAYBILL_SELECT } } },
    });
    if (!invoice) return res.status(404).send(notFoundPage("Portal not found", "This link may be invalid or expired."));

    // Load live student data for current balance
    const st_portal = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    const st      = st_portal || {
      name: invoice.studentName, adm: invoice.admNo, cls: invoice.className,
      daysOverdue: 0,
    };
    const school  = invoice.user;
    const schoolBrand = brandingPayload(school);
    const schoolPrimary = DOC_PRIMARY;
    const schoolSecondary = DOC_ACCENT;
    const schoolLogo = schoolBrand.schoolLogoUrl
      ? `<img src="${escHtml(schoolBrand.schoolLogoUrl)}" alt="" />`
      : escHtml((school.schoolName || "S")[0].toUpperCase());
    const schoolSub = schoolBrand.schoolTagline || "Fee Management Portal";

    // LEDGER-DERIVED balance for the HTML page — same formula as the API
    const portalSnap = invoiceSnapshot(invoice);
    const previousOutstanding = portalSnap.previousOutstanding;
    const newChargesTotal = portalSnap.newChargesTotal;
    const liveBalance = await deriveStudentBalance(invoice.studentId);
    const portalTotalCharges = liveBalance.totalCharges;
    const portalTotalPaid = liveBalance.totalPaid;
    const balance = liveBalance.outstanding;
    const pct     = portalTotalCharges > 0 ? Math.min(100, Math.round((portalTotalPaid / portalTotalCharges) * 100)) : 0;
    const cleared = balance === 0;
    const BACKEND = backendPublicBaseUrl();
    const token   = req.params.invoiceToken;
    const bankPaymentRef = studentBankPaymentReference(st);
    const invoicePaymentRef = invoiceBankPaymentReference(invoice);
    const bankPaybillRows = renderBankPaybillRows(school);
    const bankPaybillBox = bankPaybillRows
      ? `<div class="bank-info-box"><div class="bank-info-title">Pay via Bank / Paybill</div>${bankPaybillRows}<div class="bank-info-help">After paying, submit your transaction reference below. The school will review and confirm before your balance is updated.</div></div>`
      : `<div class="bank-info-box"><div class="bank-info-title">Pay via Bank / Paybill</div><div class="bank-missing">Bank / Paybill details have not been added by the school yet.</div><div class="bank-info-help">After paying, submit your transaction reference below. The school will review and confirm before your balance is updated.</div></div>`;

    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',system-ui,sans-serif;background:#0b0f1a;color:#e8edf5;min-height:100vh;padding:0}
      .wrap{max-width:520px;margin:0 auto;padding:24px 16px 48px}
      .brand{text-align:center;padding:20px 0 16px;font-size:13px;font-weight:700;color:#22d3a4;letter-spacing:1px}
      .brand span{display:block;font-size:11px;font-weight:400;color:#4a5f80;margin-top:3px;letter-spacing:.5px}
      .school-hdr{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:20px 22px;margin-bottom:16px;display:flex;align-items:center;gap:14px}
      .school-avatar{width:72px;height:72px;border-radius:12px;background:rgba(34,211,164,.12);border:1px solid rgba(34,211,164,.2);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:${schoolPrimary};flex-shrink:0;overflow:hidden}
      .school-avatar img{width:72px;height:72px;object-fit:contain;display:block;padding:4px;background:#fff}
      .school-name{font-size:15px;font-weight:700;color:#e8edf5}
      .school-sub{font-size:12px;color:#4a5f80;margin-top:2px}
      .balance-card{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:22px;margin-bottom:16px}
      .balance-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
      .student-name{font-size:16px;font-weight:700;color:#e8edf5}
      .student-meta{font-size:12px;color:#4a5f80;margin-top:3px}
      .status-badge{padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.5px}
      .status-cleared{background:rgba(34,211,164,.12);color:#22d3a4;border:1px solid rgba(34,211,164,.2)}
      .status-partial{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.2)}
      .status-unpaid{background:rgba(248,113,113,.1);color:#f87171;border:1px solid rgba(248,113,113,.2)}
      .amounts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px}
      .amt-box{background:#1a2236;border:1px solid #1e2d47;border-radius:10px;padding:12px;text-align:center}
      .amt-lbl{font-size:10px;color:#4a5f80;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px}
      .amt-val{font-size:17px;font-weight:800}
      .progress-wrap{margin-bottom:4px}
      .progress-track{height:8px;background:#1a2236;border-radius:99px;overflow:hidden}
      .progress-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,${schoolPrimary},${schoolSecondary});transition:width .6s ease}
      .progress-lbl{font-size:11px;color:#4a5f80;text-align:right;margin-top:5px}
      .tabs{display:flex;gap:4px;background:#1a2236;border:1px solid #1e2d47;border-radius:10px;padding:4px;margin-bottom:16px}
      .tab{flex:1;padding:9px;border-radius:7px;border:none;background:transparent;color:#4a5f80;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s}
      .tab.active{background:#111827;color:#e8edf5;box-shadow:0 1px 4px rgba(0,0,0,.3)}
      .section{display:none}.section.active{display:block}
      .payment-row{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#111827;border:1px solid #1e2d47;border-radius:10px;margin-bottom:8px}
      .payment-left{display:flex;align-items:center;gap:10px}
      .payment-icon{width:34px;height:34px;border-radius:8px;background:rgba(34,211,164,.1);border:1px solid rgba(34,211,164,.15);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
      .payment-name{font-size:13px;font-weight:600;color:#e8edf5}
      .payment-meta{font-size:11px;color:#4a5f80;margin-top:2px}
      .payment-amount{font-size:14px;font-weight:700;color:#22d3a4;text-align:right}
      .payment-date{font-size:11px;color:#4a5f80;margin-top:2px;text-align:right}
      .receipt-row{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#111827;border:1px solid #1e2d47;border-radius:10px;margin-bottom:8px}
      .receipt-link{display:inline-block;padding:6px 12px;border-radius:7px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);color:#3b82f6;font-size:11.5px;font-weight:600;text-decoration:none}
      .receipt-link:hover{background:rgba(59,130,246,.18)}
      .pay-section{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:20px;margin-bottom:16px}
      .ref-card{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:16px 18px;margin-bottom:16px}
      .ref-label{font-size:10px;color:#4a5f80;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
      .ref-value{font-family:monospace;font-size:18px;font-weight:800;color:#e8edf5;word-break:break-word}
      .ref-help{font-size:12px;color:#8a9dbf;line-height:1.5;margin-top:8px}
      .pay-title{font-size:14px;font-weight:700;color:#e8edf5;margin-bottom:4px}
      .pay-sub{font-size:12px;color:#4a5f80;margin-bottom:16px}
      .phone-row{display:flex;gap:8px}
      .phone-input{flex:1;padding:11px 14px;background:#1a2236;border:1px solid #1e2d47;border-radius:9px;color:#e8edf5;font-size:14px;font-family:inherit;outline:none;transition:all .2s ease}
      .phone-input:focus{border-color:${schoolPrimary};box-shadow:0 0 0 3px rgba(34,211,164,.11)}
      .pay-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:88px;padding:11px 18px;border-radius:9px;border:1px solid transparent;font-size:13.5px;font-weight:800;cursor:not-allowed;font-family:inherit;white-space:nowrap;transition:all .2s ease;background:#1e293b;color:#64748b;opacity:.6;box-shadow:none}
      .pay-btn.is-enabled{background:#2563eb;border-color:#2563eb;color:#ffffff;opacity:1;cursor:pointer;box-shadow:none}
      .pay-btn.is-enabled:hover{filter:brightness(1.08);box-shadow:none}
      .pay-btn.is-enabled:active{box-shadow:none}
      .pay-btn:disabled{background:#1e293b;border-color:#1e293b;color:#64748b;opacity:.6;cursor:not-allowed;box-shadow:none;transform:none;filter:none}
      .pay-btn:focus-visible{outline:2px solid ${schoolPrimary};outline-offset:3px}
      .pay-spinner{width:13px;height:13px;border-radius:50%;border:2px solid rgba(7,23,18,.3);border-top-color:#071712;animation:spin .8s linear infinite}
      @keyframes spin{to{transform:rotate(360deg)}}
      .pay-status{margin-top:12px;padding:11px 14px;border-radius:9px;font-size:13px;font-weight:500;display:none}
      .pay-status.show{display:block}
      .pay-status.pending{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);color:#f59e0b}
      .pay-status.success{background:rgba(34,211,164,.1);border:1px solid rgba(34,211,164,.2);color:#22d3a4}
      .pay-status.error{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.2);color:#f87171}
      .empty{text-align:center;padding:32px 16px;color:#4a5f80;font-size:13px}
      .empty-icon{font-size:32px;margin-bottom:8px}
      .share-btn{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:11px;border-radius:9px;background:transparent;border:1px solid #1e2d47;color:#8a9dbf;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:8px;transition:all .15s}
      .share-btn:hover{border-color:${schoolPrimary};color:${schoolPrimary}}
      .pay-status.info{background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);color:#3b82f6}
      .bank-info-box{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:16px 18px;margin-bottom:14px}
      .bank-info-title{font-size:15px;font-weight:800;color:#e8edf5;margin-bottom:10px}
      .bank-info-row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid #1e2d47;font-size:13px;line-height:1.45}
      .bank-info-row:first-of-type{border-top:none}
      .bank-info-row span{color:#8a9dbf}
      .bank-info-row strong{color:#e8edf5;text-align:right;word-break:break-word}
      .bank-missing{font-size:13px;color:#f59e0b;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.22);border-radius:9px;padding:11px 12px}
      .bank-info-help{font-size:12.5px;color:#8a9dbf;line-height:1.55;margin-top:12px}
      .bank-form{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:18px;max-width:720px;margin:0 auto}
      .bank-form-grid{display:grid;grid-template-columns:1fr 140px;gap:8px;margin-bottom:8px}
      .bank-form-grid.two{grid-template-columns:160px 1fr}
      .bank-input,.bank-textarea,.bank-file{width:100%;padding:11px 13px;background:#1a2236;border:1px solid #1e2d47;border-radius:9px;color:#e8edf5;font-size:14px;font-family:inherit;outline:none}
      .bank-input::placeholder,.bank-textarea::placeholder{color:#647795}
      .bank-input:focus,.bank-textarea:focus{border-color:${schoolPrimary};box-shadow:0 0 0 2px rgba(34,211,164,.08)}
      .bank-textarea{min-height:80px;resize:vertical;margin-bottom:12px}
      .bank-submit-btn{padding:11px 18px;border-radius:9px;background:#22d3a4;border:none;color:#0b1a14;font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;transition:opacity .15s}
      .bank-submit-btn:disabled{opacity:.6;cursor:not-allowed}
      .bank-status{font-size:13px;line-height:1.5;color:#8a9dbf}
      .bank-status.success{color:#22d3a4}.bank-status.error{color:#f87171}
      .cooldown-bar{height:3px;background:#1a2236;border-radius:99px;overflow:hidden;margin-top:8px;display:none}
      .cooldown-fill{height:100%;background:#f59e0b;border-radius:99px;transition:width 1s linear}
      .outage-banner{display:none;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.25);border-radius:10px;padding:12px 14px;font-size:12.5px;color:#f59e0b;margin-bottom:14px;line-height:1.5}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
      .pulse-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;animation:pulse 1.4s ease-in-out infinite;margin-right:6px}
      @media(max-width:480px){.bank-form-grid,.bank-form-grid.two{grid-template-columns:1fr}}
      @media(max-width:400px){.amounts{grid-template-columns:1fr 1fr}.amt-box:last-child{grid-column:span 2}}
    `;

    const statusClass = cleared ? "status-cleared" : portalTotalPaid > 0 ? "status-partial" : "status-unpaid";
    const statusText  = cleared ? "CLEARED" : portalTotalPaid > 0 ? "PARTIAL" : "UNPAID";
    const mpesaSection = school.mpesaConfigured && balance > 0 ? `
      <div class="pay-section">
        <div id="outageBanner" class="outage-banner">
          ⚠ <strong>M-Pesa delays detected.</strong> Payments are still going through but confirmation may take longer than usual. Please enter your PIN once and wait — don't send multiple requests.
        </div>
        <div class="pay-title">💳 Pay Now via M-Pesa</div>
        <div class="pay-sub">Enter your M-Pesa number to pay KES ${fmtKE(balance)} directly</div>
        <div class="phone-row">
          <input class="phone-input" id="phone" type="tel" placeholder="Use format 0701475742, 0112345678, or 254..." maxlength="13" />
          <button class="pay-btn" id="payBtn" onclick="triggerPay()" disabled>Send</button>
        </div>
        <div class="cooldown-bar" id="cooldownBar"><div class="cooldown-fill" id="cooldownFill"></div></div>
        <div class="pay-status" id="payStatus"></div>
      </div>` : "";

    const portalPosthogKey = process.env.VITE_POSTHOG_KEY || "";
    const portalPosthogHost = process.env.VITE_POSTHOG_HOST || "https://app.posthog.com";
    const portalAnalyticsSnippet = portalPosthogKey ? `
<script>
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once reset".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(${JSON.stringify(portalPosthogKey)}, { api_host: ${JSON.stringify(portalPosthogHost)}, capture_pageview: false, disable_session_recording: false, session_recording: { maskAllInputs: true } });
function portalTrack(name, props){ try { posthog.capture(name, Object.assign({ invoiceId: ${JSON.stringify(invoice.id)}, studentId: ${JSON.stringify(st.id)}, path: location.pathname }, props || {})); } catch(e) {} }
portalTrack("parent_portal_opened");
portalTrack("parent_invoice_viewed", { balance: ${JSON.stringify(balance)} });
</script>` : `<script>function portalTrack(){}</script>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fee Portal — ${escHtml(st.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${css}</style>
${portalAnalyticsSnippet}
</head>
<body>
<div class="wrap">
  <div class="brand">FEEFLOW <span>Parent Fee Portal</span></div>

  <!-- School header -->
  <div class="school-hdr">
    <div class="school-avatar">${schoolLogo}</div>
    <div>
      <div class="school-name">${escHtml(school.schoolName || "School")}</div>
      <div class="school-sub">${escHtml(schoolSub)}</div>
    </div>
  </div>

  <!-- Balance card -->
  <div class="balance-card">
    <div class="balance-top">
      <div>
        <div class="student-name">${escHtml(st.name)}</div>
        <div class="student-meta">${escHtml(st.cls)}${st.adm ? " · Adm: " + escHtml(st.adm) : ""}</div>
      </div>
      <div id="statusBadge" class="status-badge ${statusClass}">${statusText}</div>
    </div>
    <div class="amounts">
      <div class="amt-box">
        <div class="amt-lbl">Account Total Charges</div>
        <div id="totalChargesVal" class="amt-val" style="color:#8a9dbf">KES ${fmtKE(portalTotalCharges)}</div>
      </div>
      <div class="amt-box">
        <div class="amt-lbl">Paid</div>
        <div id="paidVal" class="amt-val" style="color:#22d3a4">KES ${fmtKE(portalTotalPaid)}</div>
      </div>
      <div class="amt-box">
        <div class="amt-lbl">Total Due Now</div>
        <div class="amt-val" style="color:${balance > 0 ? "#f87171" : "#22d3a4"}">${balance > 0 ? "KES " + fmtKE(balance) : "✓ Nil"}</div>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-lbl">${pct}% paid</div>
    </div>
  </div>

  <div class="ref-card">
    <div class="ref-label">Bank Payment Reference</div>
    <div class="ref-value">${escHtml(bankPaymentRef || "N/A")}</div>
    <div class="ref-help">Use this in the bank narration/reference. Invoice reference: <strong>${escHtml(invoicePaymentRef || "N/A")}</strong>.</div>
  </div>

  ${mpesaSection}

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" onclick="showTab('payments',this)">Payments</button>
    <button class="tab" onclick="showTab('bank',this)">Bank / Paybill</button>
    <button class="tab" onclick="showTab('receipts',this)">Receipts</button>
  </div>

  <!-- Payments tab -->
  <div class="section active" id="tab-payments">
    <div id="payments-list">
      <div style="text-align:center;padding:20px;color:#4a5f80;font-size:13px">Loading payments…</div>
    </div>
  </div>

  <!-- Bank / Paybill tab -->
  <div class="section" id="tab-bank">
    ${bankPaybillBox}
    <form id="bankForm" enctype="multipart/form-data" class="bank-form">
      <div style="font-weight:700;font-size:15px;margin-bottom:6px">🏦 Bank / Paybill Submission</div>
      <div style="color:#8a9dbf;font-size:13px;margin-bottom:12px">Submit the transaction reference and optional proof after paying.</div>
      <div class="bank-form-grid">
        <input class="bank-input" id="bankTxnRef" name="transactionRef" placeholder="Transaction reference" />
        <input class="bank-input" id="bankAmount" name="amount" placeholder="Amount (KES)" value="${balance}" />
      </div>
      <div class="bank-form-grid two">
        <input class="bank-input" id="bankPaidAt" name="paidAt" type="date" />
        <input class="bank-input" id="bankParentName" name="parentName" placeholder="Your name" />
      </div>
      <div class="bank-form-grid two">
        <input class="bank-input" id="bankParentPhone" name="parentPhone" placeholder="Phone (e.g. 0712345678)" />
        <input class="bank-file" id="bankProof" name="proof" type="file" accept=".png,.jpg,.jpeg,.webp,.pdf" />
      </div>
      <textarea class="bank-textarea" id="bankNote" name="note" placeholder="Optional note"></textarea>
      <div style="display:flex;gap:8px;align-items:center">
        <button type="button" id="submitBankBtn" class="bank-submit-btn" onclick="submitBank()">Submit for review</button>
        <div id="bankStatus" class="bank-status"></div>
      </div>
    </form>
  </div>

  <!-- Receipts tab -->
  <div class="section" id="tab-receipts">
    <div id="receipts-list">
      <div style="text-align:center;padding:20px;color:#4a5f80;font-size:13px">Loading receipts…</div>
    </div>
  </div>

  <!-- Share portal link -->
  <button class="share-btn" onclick="sharePortal()">🔗 Share / Bookmark this page</button>
  <div style="text-align:center;margin-top:16px;font-size:11px;color:#4a5f80">Powered by FeeFlow</div>
</div>

<script>
const BACKEND = "${BACKEND}";
const TOKEN   = "${token}";

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer        = null;
let cooldownTimer    = null;
let cooldownSeconds  = 0;
let originalBalance  = ${balance};
let currentCheckoutId = null;
let payState         = "idle"; // idle | sending | awaiting | success | error | in_flight | cooldown | limit

// ── On load: check status immediately (handles page refresh mid-payment) ──────
window.addEventListener("DOMContentLoaded", () => {
  setupPayControls();
  loadPortal();
  checkCurrentStatus();
});

async function checkCurrentStatus() {
  try {
    const r = await fetch(BACKEND + "/api/pay/" + TOKEN + "/status");
    const d = await r.json();

    // Show outage banner if Safaricom is currently degraded
    if (d.degraded) {
      const banner = document.getElementById("outageBanner");
      if (banner) banner.style.display = "block";
    }

    if (d.cleared || d.balance === 0) {
      setPayState("success", "✅ This invoice is fully paid. Thank you!");
      disablePayForm();
      return;
    }
    // Resume polling if there's an in-flight transaction
    if (d.txStatus && ["awaiting_callback","pending","callback_delayed"].includes(d.txStatus)) {
      setPayState("awaiting", "⏳ A payment is still being confirmed. Don't send another request.");
      currentCheckoutId = d.checkoutRequestId || currentCheckoutId;
      disablePayBtn(true);
      startPolling(currentCheckoutId);
    } else if (d.txStatus === "callback_delayed") {
      setPayState("awaiting", "⏳ Payment is taking longer than usual to confirm. Please wait — don't pay again.");
      currentCheckoutId = d.checkoutRequestId || currentCheckoutId;
      disablePayBtn(true);
      startPolling(currentCheckoutId);
    }
  } catch {}
}

// ── Load portal data ──────────────────────────────────────────────────────────
async function loadPortal() {
  try {
    const r = await fetch(BACKEND + "/api/portal/" + TOKEN);
    const d = await r.json();
    renderPayments(d.payments || []);
    renderReceipts(d.receipts || []);
  } catch {
    document.getElementById("payments-list").innerHTML = "<div class='empty'><div class='empty-icon'>⚠️</div>Could not load data. Please refresh.</div>";
  }
}

function fmtMethod(m) {
  return m === "mpesa" ? "M-Pesa" : m === "bank" ? "Bank Transfer" : "Cash";
}

function renderPayments(payments) {
  const el = document.getElementById("payments-list");
  if (!payments.length) { el.innerHTML = "<div class='empty'><div class='empty-icon'>💸</div>No payments recorded yet</div>"; return; }
  el.innerHTML = payments.map(p => \`
    <div class="payment-row">
      <div class="payment-left">
        <div class="payment-icon">\${p.method === "mpesa" ? "📱" : p.method === "bank" ? "🏦" : "💵"}</div>
        <div>
          <div class="payment-name">KES \${Number(p.amount).toLocaleString("en-KE")}</div>
          <div class="payment-meta">\${fmtMethod(p.method)}\${p.txnRef ? " · " + p.txnRef : ""}</div>
        </div>
      </div>
      <div>
        <div class="payment-amount">+KES \${Number(p.amount).toLocaleString("en-KE")}</div>
        <div class="payment-date">\${p.time}</div>
      </div>
    </div>
  \`).join("");
}

function renderReceipts(receipts) {
  const el = document.getElementById("receipts-list");
  if (!receipts.length) { el.innerHTML = "<div class='empty'><div class='empty-icon'>🧾</div>No receipts issued yet</div>"; return; }
  el.innerHTML = receipts.map(r => \`
    <div class="receipt-row">
      <div>
        <div style="font-size:13px;font-weight:600;color:#e8edf5">KES \${Number(r.amount).toLocaleString("en-KE")}</div>
        <div style="font-size:11px;color:#4a5f80;margin-top:2px">\${r.receiptNo} · \${r.time}</div>
      </div>
      <a href="\${r.link}" target="_blank" class="receipt-link">View Receipt ↗</a>
    </div>
  \`).join("");
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function showTab(name, btn) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  btn.classList.add("active");
}

// ── Bank submission (client) ───────────────────────────────────────────────
async function submitBank() {
  const btn = document.getElementById("submitBankBtn");
  const statusEl = document.getElementById("bankStatus");
  if (!btn) return;
  btn.disabled = true; statusEl.textContent = "Submitting…";

  try {
    const form = document.getElementById("bankForm");
    const fd = new FormData();
    fd.append("transactionRef", document.getElementById("bankTxnRef").value.trim());
    fd.append("amount", document.getElementById("bankAmount").value.trim());
    fd.append("paidAt", document.getElementById("bankPaidAt").value);
    fd.append("parentName", document.getElementById("bankParentName").value.trim());
    fd.append("parentPhone", document.getElementById("bankParentPhone").value.trim());
    fd.append("note", document.getElementById("bankNote").value.trim());
    const fileEl = document.getElementById("bankProof");
    if (fileEl && fileEl.files && fileEl.files[0]) fd.append("proof", fileEl.files[0]);

    const r = await fetch(BACKEND + "/p/" + TOKEN + "/bank-submit", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) {
      statusEl.textContent = d?.message || "Submission failed.";
      btn.disabled = false; return;
    }
    statusEl.textContent = "✅ Submission received. School will review and confirm.";
    btn.style.display = "none";
  } catch (e) {
    document.getElementById("bankStatus").textContent = "Unable to submit — try again.";
    btn.disabled = false;
  }
}

// ── Pay Now ───────────────────────────────────────────────────────────────────
window.submitBank = async function submitBankImproved() {
  const btn = document.getElementById("submitBankBtn");
  const statusEl = document.getElementById("bankStatus");
  if (!btn || !statusEl) return;
  btn.disabled = true;
  btn.textContent = "Submitting...";
  statusEl.className = "bank-status";
  statusEl.textContent = "";

  try {
    const form = document.getElementById("bankForm");
    const fd = new FormData(form);
    const attemptedAmount = Number(fd.get("amount") || 0);
    const fileEl = document.getElementById("bankProof");
    if (!fileEl?.files?.[0]) fd.delete("proof");

    const r = await fetch(BACKEND + "/p/" + TOKEN + "/bank-submit", { method: "POST", body: fd });
    const contentType = r.headers.get("content-type") || "";
    const d = contentType.includes("application/json") ? await r.json() : { message: await r.text() };
    if (!r.ok) {
      statusEl.className = "bank-status error";
      statusEl.textContent = d?.message || d?.error || "Submission failed.";
      btn.textContent = "Submit for review";
      btn.disabled = false;
      return;
    }
    portalTrack("bank_payment_submitted", { amount: attemptedAmount });
    statusEl.className = "bank-status success";
    statusEl.textContent = "Submitted for review. The school will confirm your payment.";
    btn.textContent = "Submit for review";
  } catch (e) {
    statusEl.className = "bank-status error";
    statusEl.textContent = e?.message || "Unable to submit. Please try again.";
    btn.textContent = "Submit for review";
    btn.disabled = false;
  }
};

function normalizeSafaricomStkPhone(phone) {
  const rawPhone = String(phone || "");
  let cleanedPhone = "";
  for (const ch of rawPhone) {
    if (ch >= "0" && ch <= "9") cleanedPhone += ch;
  }

  let normalizedPhone = cleanedPhone;
  if (cleanedPhone.startsWith("0")) normalizedPhone = "254" + cleanedPhone.slice(1);
  else if (cleanedPhone.startsWith("7")) normalizedPhone = "254" + cleanedPhone;
  else if (cleanedPhone.startsWith("1")) normalizedPhone = "254" + cleanedPhone;
  else if (cleanedPhone.startsWith("254")) normalizedPhone = cleanedPhone;

  const valid =
    normalizedPhone.length === 12 &&
    normalizedPhone.startsWith("254") &&
    (normalizedPhone[3] === "7" || normalizedPhone[3] === "1");

  console.debug("[STK Phone Validation]", {
    rawPhone,
    cleanedPhone,
    normalizedPhone,
    valid,
  });

  return valid ? normalizedPhone : null;
}

function getNormalizedPayPhone() {
  const input = document.getElementById("phone");
  return normalizeSafaricomStkPhone(input ? input.value.trim() : "");
}

function setPayButtonText(text, loading = false) {
  const btn = document.getElementById("payBtn");
  if (!btn) return;
  btn.innerHTML = loading ? '<span class="pay-spinner" aria-hidden="true"></span>' + text : text;
}

function isPayLocked() {
  return ["sending", "awaiting", "in_flight", "cooldown", "success"].includes(payState);
}

function updatePayButton(forceDisabled = false) {
  const btn = document.getElementById("payBtn");
  if (!btn) return;
  const valid = !!getNormalizedPayPhone();
  const enabled = valid && !forceDisabled && !isPayLocked();
  btn.disabled = !enabled;
  btn.classList.toggle("is-enabled", enabled);
}

function setupPayControls() {
  const input = document.getElementById("phone");
  const btn = document.getElementById("payBtn");
  if (!input || !btn) return;
  input.addEventListener("input", () => {
    if (payState === "error") setPayState("idle", "");
    updatePayButton();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      updatePayButton();
      if (!btn.disabled) triggerPay();
    }
  });
  updatePayButton();
}

async function triggerPay() {
  if (payState === "awaiting" || payState === "sending" || payState === "cooldown" || payState === "success") return;

  const phone = document.getElementById("phone").value.trim();
  const normalizedPhone = getNormalizedPayPhone();
  portalTrack("parent_payment_attempted", { paymentMethod: "mpesa", amount: originalBalance });
  if (!phone) { setPayState("error", "Please enter your M-Pesa phone number."); return; }
  if (!normalizedPhone) {
    setPayState("error", "Enter a valid Safaricom number, e.g. 0701475742 or 0112345678");
    updatePayButton();
    return;
  }

  // Check retry eligibility before sending — prevents duplicate charges
  setPayState("sending", "⏳ Checking…");
  disablePayBtn(true);
  setPayButtonText("Checking...", true);

  try {
    const eligR = await fetch(BACKEND + "/api/pay/" + TOKEN + "/retry-eligible");
    const elig  = await eligR.json();

    if (!elig.eligible) {
      if (elig.reason === "already_paid") {
        setPayState("success", "✅ This invoice is fully paid. Thank you!");
        disablePayForm(); return;
      }
      if (elig.reason === "in_flight") {
        currentCheckoutId = elig.checkoutRequestId || currentCheckoutId;
        setPayState("in_flight", "⏳ A payment request is already being processed. Please enter your PIN on your phone — don't send another request.");
        disablePayBtn(true);
        startPolling(currentCheckoutId); return;
      }
      if (elig.reason === "cooldown") {
        startCooldown(elig.retryAfterSeconds || 60); return;
      }
      if (elig.reason === "limit_reached") {
        setPayState("error", "❌ Too many payment attempts today. Please pay at the school office or contact the school directly.");
        disablePayBtn(true); return;
      }
      setPayState("error", "❌ " + (elig.message || "Unable to process payment right now."));
      setPayButtonText("Try Again");
      disablePayBtn(false); return;
    }
  } catch {
    // If eligibility check fails, allow the attempt (fail-open)
  }

  setPayState("sending", "⏳ Sending M-Pesa request to your phone…");
  setPayButtonText("Sending...", true);

  try {
    const r = await fetch(BACKEND + "/api/pay/" + TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: normalizedPhone }),
    });
    const d = await r.json();

    if (d.success) {
      currentCheckoutId = d.CheckoutRequestID || d.checkoutRequestId || null;
      setPayState("awaiting", "<span class='pulse-dot'></span>M-Pesa request sent. <strong>Check your phone</strong> and enter your PIN to complete payment of KES " + Number(d.amount).toLocaleString("en-KE") + ".");
      setPayButtonText("Waiting...");
      // Show outage banner if Safaricom is degraded
      if (d.degraded) {
        const banner = document.getElementById("outageBanner");
        if (banner) banner.style.display = "block";
      }
      startPolling(currentCheckoutId);
    } else if (r.status === 409 || d.inFlight) {
      currentCheckoutId = d.CheckoutRequestID || d.checkoutRequestId || currentCheckoutId;
      setPayState("in_flight", "⏳ A payment is already being processed for this account. Please enter your PIN on your phone — don't send a new request.");
      startPolling(currentCheckoutId);
    } else {
      const msg = d.error || "Payment failed. Please try again.";
      setPayState("error", "❌ " + msg);
      setPayButtonText("Try Again");
      disablePayBtn(false);
    }
  } catch {
    setPayState("error", "❌ Network error. Please check your connection and try again.");
    setPayButtonText("Try Again");
    disablePayBtn(false);
  }
}

// ── Poll for payment completion every 2.5 seconds ─────────────────────────────
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshInvoiceData() {
  const r = await fetch(BACKEND + "/api/pay/" + TOKEN + "/status");
  const d = await r.json();
  updateBalanceCard(d);
  await loadPortal();
  return d;
}

function updateBalanceCard(d) {
  const paid = Number(d.totalPaid || 0);
  const charges = Number(d.totalCharges || 0);
  const balance = Number(d.balance || 0);
  const pct = charges > 0 ? Math.min(100, Math.round((paid / charges) * 100)) : 100;
  const boxes = document.querySelectorAll(".amounts .amt-box .amt-val");
  const paidEl = document.getElementById("paidVal") || boxes[1];
  const dueEl = document.getElementById("dueVal") || boxes[2];
  const fillEl = document.getElementById("progressFill") || document.querySelector(".progress-fill");
  const labelEl = document.getElementById("progressLabel") || document.querySelector(".progress-lbl");
  const badgeEl = document.getElementById("statusBadge") || document.querySelector(".status-badge");
  if (paidEl) paidEl.textContent = "KES " + paid.toLocaleString("en-KE");
  if (dueEl) {
    dueEl.textContent = balance > 0 ? "KES " + balance.toLocaleString("en-KE") : "Nil";
    dueEl.style.color = balance > 0 ? "#f87171" : "#22d3a4";
  }
  if (fillEl) fillEl.style.width = pct + "%";
  if (labelEl) labelEl.textContent = pct + "% paid";
  if (badgeEl) {
    badgeEl.className = "status-badge " + (balance <= 0 ? "status-cleared" : paid > 0 ? "status-partial" : "status-unpaid");
    badgeEl.textContent = balance <= 0 ? "CLEARED" : paid > 0 ? "PARTIAL" : "UNPAID";
  }
  originalBalance = balance;
}

function startPolling(checkoutRequestId) {
  currentCheckoutId = checkoutRequestId || currentCheckoutId;
  if (!currentCheckoutId) {
    checkCurrentStatus();
    return;
  }
  const startedAt = Date.now();
  stopPolling();
  setPayState("awaiting", "Waiting for payment...");
  setPayButtonText("Waiting...");
  disablePayBtn(true);

  pollTimer = setInterval(async () => {
    if (Date.now() - startedAt > 90_000) {
      stopPolling();
      setPayState("error", "M-Pesa request timed out. Please try again.");
      setPayButtonText("Try Again");
      disablePayBtn(false);
      return;
    }
    try {
      const r = await fetch(BACKEND + "/api/pay/" + TOKEN + "/stk-status/" + currentCheckoutId);
      const d = await r.json();
      if (d.status === "PENDING") {
        setPayState("awaiting", "Waiting for payment...");
        return;
      }
      if (d.status === "SUCCESS") {
        stopPolling();
        setPayState("success", "Payment confirmed");
        setPayButtonText("Confirmed");
        const latest = await refreshInvoiceData();
        if (Number(latest.balance || 0) <= 0) {
          disablePayBtn(true);
          return;
        }
        setTimeout(() => {
          payState = "idle";
          setPayButtonText("Send");
          disablePayBtn(false);
        }, 1500);
        return;
      }
      if (["FAILED", "CANCELLED", "TIMEOUT"].includes(d.status)) {
        stopPolling();
        const msg = d.message || (d.status === "CANCELLED" ? "Payment was cancelled. Please try again." : d.status === "TIMEOUT" ? "M-Pesa request timed out. Please try again." : "Payment failed. Please try again.");
        setPayState("error", msg);
        setPayButtonText("Try Again");
        disablePayBtn(false);
      }
    } catch {
      stopPolling();
      setPayState("error", "Could not confirm payment status. Please try again.");
      setPayButtonText("Try Again");
      disablePayBtn(false);
    }
  }, 2500);
}

// ── Cooldown — prevents retry spam ───────────────────────────────────────────
function startCooldown(seconds) {
  clearInterval(cooldownTimer);
  cooldownSeconds = seconds;
  const bar  = document.getElementById("cooldownBar");
  const fill = document.getElementById("cooldownFill");
  if (bar) { bar.style.display = "block"; fill.style.width = "100%"; }
  disablePayBtn(true);

  cooldownTimer = setInterval(() => {
    cooldownSeconds--;
    if (fill) fill.style.width = ((cooldownSeconds / seconds) * 100) + "%";
    setPayButtonText("Wait " + cooldownSeconds + "s...");
    if (cooldownSeconds <= 0) {
      clearInterval(cooldownTimer);
      setPayButtonText("Try Again");
      if (bar) bar.style.display = "none";
      payState = "idle";
      disablePayBtn(false);
    }
  }, 1000);
  payState = "cooldown";
}

function setPayState(state, msg) {
  payState = state;
  const el = document.getElementById("payStatus");
  if (!el) return;
  if (state === "idle" || !msg) {
    el.className = "pay-status";
    el.innerHTML = "";
    return;
  }
  const typeMap = { sending: "pending", awaiting: "pending", in_flight: "pending", success: "success", error: "error", idle: "" };
  const cls = typeMap[state] || "pending";
  el.className = "pay-status show " + cls;
  el.innerHTML = msg;
}

function disablePayBtn(disabled) {
  updatePayButton(disabled);
}

function disablePayForm() {
  disablePayBtn(true);
  const inp = document.getElementById("phone");
  if (inp) inp.disabled = true;
  setPayButtonText("Paid ✓");
}

window.addEventListener("beforeunload", () => {
  stopPolling();
  if (cooldownTimer) clearInterval(cooldownTimer);
});

// ── Share portal ──────────────────────────────────────────────────────────────
function sharePortal() {
  const url = window.location.href;
  if (navigator.share) {
    navigator.share({ title: "Fee Portal — ${escHtml(st.name)}", url });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.querySelector(".share-btn");
      btn.textContent = "✓ Link copied!";
      setTimeout(() => btn.innerHTML = "🔗 Share / Bookmark this page", 2000);
    });
  }
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) {
    logger.error("portal", "Parent portal page render failed", {
      error: safeErrorMessage(e),
      reqId: req.reqId,
    });
    res.status(500).send("Server error");
  }
});

// ─── MPESA TRANSACTION TIMEOUT JOB (runs every 2 minutes) ───────────────────
if (process.env.NODE_ENV !== "test") {
  setInterval(async () => {
  try {
    const now           = new Date();
    const timeoutCutoff = new Date(now - 5 * 60 * 1000);
    const delayCutoff   = new Date(now - 2 * 60 * 1000);

    const timedOut = await prisma.mpesaTransaction.updateMany({
      where: { status: { in: ["pending", "awaiting_callback"] }, createdAt: { lt: timeoutCutoff } },
      data:  { status: "timeout", resolvedAt: now },
    });
    if (timedOut.count > 0) logger.warn("timeout-job", `Marked ${timedOut.count} transaction(s) as timed out`);

    const delayed = await prisma.mpesaTransaction.updateMany({
      where: { status: "awaiting_callback", createdAt: { lt: delayCutoff, gte: timeoutCutoff } },
      data:  { status: "callback_delayed" },
    });
    if (delayed.count > 0) logger.info("timeout-job", `Marked ${delayed.count} as callback_delayed`);
  } catch (e) { logger.error("timeout-job", e.message); }
  }, 2 * 60 * 1000);
}

// ─── SAFARICOM HEALTH MONITOR (runs every 5 minutes) ─────────────────────────
// Reads the 15-minute window success rate and updates outageState.
// Routes and the parent portal read outageState.degraded to suppress retries.
if (process.env.NODE_ENV !== "test") {
  setInterval(async () => {
  try {
    const windowStart = new Date(Date.now() - 15 * 60 * 1000);
    const [total, succeeded] = await Promise.all([
      prisma.mpesaTransaction.count({ where: { createdAt: { gte: windowStart } } }),
      prisma.mpesaTransaction.count({ where: { createdAt: { gte: windowStart }, status: "success" } }),
    ]);
    if (total >= 5) {
      const rate = succeeded / total;
      const shouldDegrade = rate < 0.5;
      if (shouldDegrade !== outageState.degraded) {
        logger.warn("health", `M-Pesa outage mode: ${shouldDegrade ? "ON" : "OFF"} (rate=${Math.round(rate * 100)}%, ${succeeded}/${total})`);
        await setDegradedMode(shouldDegrade, rate);
      }
    } else if (total === 0 && outageState.degraded) {
      // No traffic — clear degraded mode
      await setDegradedMode(false, 1.0);
    }
  } catch (e) { logger.error("health", "Monitor error", { error: e.message }); }
  }, 5 * 60 * 1000);
}

// ─── NIGHTLY FINANCIAL CONSISTENCY JOB ───────────────────────────────────────
function scheduleNightlyConsistency() {
  const now    = new Date();
  const target = new Date();
  target.setUTCHours(23, 0, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  const delay = target - now;
  logger.info("consistency", `Next consistency job in ${Math.round(delay / 60000)} minutes`);

  setTimeout(async function runJob() {
    try {
      logger.info("consistency", "Starting nightly financial consistency check");
      const schools = await prisma.balanceLedger.findMany({
        distinct: ["userId"], select: { userId: true },
      });

      let mismatches = 0;
      for (const { userId } of schools) {
        const students = await prisma.student.findMany({
          where: { userId, deletedAt: null },
          select: { id: true, name: true },
        });

        for (const student of students) {
          const lb = await deriveStudentBalance(student.id);
          const expected = Math.max(0, lb.totalCharges - lb.totalPaid - lb.totalCredit);
          if (Math.abs(expected - lb.outstanding) > 1) {
            mismatches++;
            logger.warn("consistency", "ledger invariant failed", {
              userId, studentId: student.id, name: student.name,
              totalCharges: lb.totalCharges, totalPaid: lb.totalPaid,
              totalCredit: lb.totalCredit, outstanding: lb.outstanding, expected,
            });
            logAudit(null, { action: "ledger_invariant_failed", entityType: "student", entityId: student.id, schoolOwnerId: userId, metadata: { totalCharges: lb.totalCharges, totalPaid: lb.totalPaid, totalCredit: lb.totalCredit, outstanding: lb.outstanding, expected } });
          }
        }
      }

      logger.info("consistency", `Consistency check complete. Mismatches: ${mismatches}`);
    } catch (e) {
      logger.error("consistency", "Nightly job failed", { error: e.message });
    } finally {
      setTimeout(runJob, 24 * 60 * 60 * 1000);
    }
  }, delay);
}
if (process.env.NODE_ENV !== "test") {
  scheduleNightlyConsistency();
}

// ─── ACCOUNTING SUMMARY (admin/accountant report endpoint) ────────────────────
// Returns a mathematically consistent financial summary derived entirely from
// the ledger — never from student.fee / student.paid fields.
// Principals and accountants can use this to verify the dashboard totals.
app.get("/api/accounting/summary", requireAuth, requirePermission("reports.view"), async (req, res) => {
  try {
    const { termId } = req.query;
    const activeTerm = termId
      ? await prisma.term.findFirst({ where: { id: termId, userId: req.userId } })
      : null;

    const students = await prisma.student.findMany({
      where: { userId: req.userId, deletedAt: null },
      select: { id: true, name: true, adm: true, cls: true },
    });
    const studentIds = students.map(s => s.id);

    // Derive ALL balances from ledger in one batch
    const balances = await deriveStudentBalancesBatch(studentIds);

    // Total charges (from StudentCharge) — immutable historical record
    const chargeAgg = await prisma.studentCharge.aggregate({
      where: { userId: req.userId, voidedAt: null, ...(activeTerm?.id ? { termId: activeTerm.id } : {}) },
      _sum: { amount: true },
    });
    // Total valid payments
    const paymentAgg = await prisma.payment.aggregate({
      where: { userId: req.userId, reversedAt: null, isReversal: false, deletedAt: null },
      _sum: { amount: true },
    });
    // Total reversals (for reporting transparency)
    const reversalAgg = await prisma.payment.aggregate({
      where: { userId: req.userId, isReversal: true },
      _sum: { amount: true },
    });
    // Available credits
    const creditAgg = await prisma.creditMemo.aggregate({
      where: { userId: req.userId, status: "available" },
      _sum: { remainingAmount: true },
    });

    const totalCharges   = Number(chargeAgg._sum.amount ?? 0);
    const totalPaid      = Number(paymentAgg._sum.amount ?? 0);
    const totalReversals = Number(reversalAgg._sum.amount ?? 0);
    const totalCredits   = Number(creditAgg._sum.remainingAmount ?? 0);

    const effectiveCharges = totalCharges;

    const totalOutstanding = Math.max(0, effectiveCharges - totalPaid - totalCredits);
    const collectionRate   = effectiveCharges > 0 ? (totalPaid / effectiveCharges * 100).toFixed(1) : "0.0";

    // Per-student breakdown for reconciliation
    const studentBreakdown = students.map(s => {
      const b = balances.get(s.id) || { totalCharges: 0, totalPaid: 0, outstanding: 0 };
      return {
        id: s.id, name: s.name, adm: s.adm, cls: s.cls,
        totalCharges:  b.totalCharges,
        totalPaid:     b.totalPaid,
        outstanding:   b.outstanding,
        creditBalance: b.creditBalance || 0,
        isOverpaid:    b.isOverpaid || false,
        ledgerSource:  b.ledgerSource,
      };
    }).sort((a, b) => b.outstanding - a.outstanding);

    res.json({
      term:           activeTerm ? { id: activeTerm.id, name: activeTerm.name } : null,
      summary: {
        totalCharges:   effectiveCharges,
        totalPaid,
        totalReversals,
        totalCredits,
        totalOutstanding,
        collectionRate: collectionRate + "%",
        ledgerSource:   "StudentCharge ledger",
      },
      // Accounting equation: totalCharges = totalPaid + totalOutstanding + totalCredits
      // If this doesn't balance to within KES 1, something is wrong.
      accountingCheck: {
        equation:  "charges = paid + outstanding + credits",
        lhs:       effectiveCharges,
        rhs:       totalPaid + totalOutstanding + totalCredits,
        balanced:  Math.abs(effectiveCharges - (totalPaid + totalOutstanding + totalCredits)) < 1,
      },
      studentCount:   students.length,
      studentBreakdown,
    });
  } catch (e) { return apiError(res, e, "accounting summary", req); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
// Used by uptime monitors, load balancers, and ops runbooks.
// Returns 200 when DB is reachable; 503 when not.
app.get("/health", async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true, version: "3.3",
      db: "connected",
      mpesa: { degraded: outageState.degraded, successRate: outageState.successRate, degradedSince: outageState.degradedSince },
    });
  } catch (e) {
    logger.error("health", "DB connectivity check failed", { error: e.message });
    res.status(503).json({ ok: false, db: "unreachable", error: "Database connectivity check failed" });
  }
});
const PORT = process.env.PORT || 3000;
let server;

async function runPostListenBoot() {
  try {
    await prisma.$connect();
    console.log("Prisma connected");
  } catch (e) {
    logger.error("startup", "Prisma connection failed after listen", {
      error: safeErrorMessage(e),
      code: e?.code,
      stack: e?.stack,
    });
  }

  await restoreOutageState();
  await migrateCbcCredentialsToGcm().catch(e => logger.warn("startup", "GCM migration failed", { error: e.message }));
  await backfillUnmatchedC2bPhonesFromRawMetadata().catch(e => logger.warn("startup", "Unmatched C2B phone backfill failed", { error: safeErrorMessage(e) }));

  if (process.env.NODE_ENV !== "test") {
    warnIfDuplicateActiveCharges().catch(error => logger.warn("ledger", "Startup duplicate-charge audit failed", { error: safeErrorMessage(error) }));
  }

  console.log("Boot complete");
}


// ─── PLATFORM BILLING — M-PESA PLAN UPGRADES ──────────────────────────────────
// Uses FeeFlow's own Daraja credentials (BILLING_MPESA_*) — completely isolated
// from per-school credentials stored on the User model.

if (process.env.NODE_ENV === "production") {
  const billingRequired = ["BILLING_MPESA_CONSUMER_KEY","BILLING_MPESA_CONSUMER_SECRET","BILLING_MPESA_SHORTCODE","BILLING_MPESA_PASSKEY","BILLING_MPESA_CALLBACK_SECRET"];
  const billingMissing = billingRequired.filter(k => !process.env[k]);
  if (billingMissing.length > 0) {
    logger.error("startup", "Missing billing M-Pesa env vars — billing disabled", { missing: billingMissing });
  }
}

const SUBSCRIPTION_PLANS = { pro: { amount: 15000, label: "Pro", months: 1 } };

const billingInitiateLimiter = rateLimit({
  windowMs: 60 * 1000, max: 3,
  keyGenerator: (req) => req.userId || ipKeyGenerator(req),
  standardHeaders: true, legacyHeaders: false,
  message: { message: "Too many payment attempts. Please wait a minute and try again." },
  handler: (req, res, _next, options) => {
    logger.warn("billing", "Rate limit hit on billing initiate", { userId: req.userId, reqId: req.reqId });
    res.status(429).json(options.message);
  },
});
const billingPollLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, keyGenerator: ipKeyGenerator,
  standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false },
  message: { status: "unknown", message: "Polling too fast. Please slow down." },
});
const billingCallbackLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, keyGenerator: ipKeyGenerator,
  standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false },
  message: { ResultCode: 1, ResultDesc: "Rate limit exceeded" },
});

function getBillingMpesaCredentials() {
  const CK = (process.env.BILLING_MPESA_CONSUMER_KEY    || "").trim();
  const CS = (process.env.BILLING_MPESA_CONSUMER_SECRET || "").trim();
  const SC = (process.env.BILLING_MPESA_SHORTCODE       || "").trim();
  const PK = (process.env.BILLING_MPESA_PASSKEY         || "").trim();
  if (!CK || !CS || !SC || !PK) return null;
  return { CK, CS, SC, PK };
}

let _billingToken = null;
let _billingTokenExpiresAt = 0;

async function getBillingMpesaToken() {
  if (_billingToken && Date.now() < _billingTokenExpiresAt) return _billingToken;
  const creds = getBillingMpesaCredentials();
  if (!creds) throw Object.assign(new Error("Platform billing M-Pesa credentials are not configured. Contact support."), { statusCode: 503 });
  const auth = Buffer.from(creds.CK + ":" + creds.CS).toString("base64");
  const res = await fetchWithTimeout("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", { headers: { Authorization: "Basic " + auth } }, 20000);
  const data = await res.json();
  if (!data.access_token) {
    logger.error("billing", "Failed to get billing Daraja token", { httpStatus: res.status });
    throw Object.assign(new Error("Could not authenticate with M-Pesa. Please try again later."), { statusCode: 502 });
  }
  _billingToken = data.access_token;
  _billingTokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return _billingToken;
}

function invalidateBillingToken() { _billingToken = null; _billingTokenExpiresAt = 0; }

function billingCallbackUrl() {
  const secret = (process.env.BILLING_MPESA_CALLBACK_SECRET || "").trim();
  const base   = (process.env.BACKEND_URL || "http://localhost:3000").replace(/\/+$/, "");
  if (!secret) logger.warn("billing", "BILLING_MPESA_CALLBACK_SECRET not set");
  return secret ? `${base}/api/billing/mpesa/callback/${secret}` : `${base}/api/billing/mpesa/callback/open`;
}

function billingSTKPassword(shortcode, passkey) {
  const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
  const pw = Buffer.from(shortcode + passkey + ts).toString("base64");
  return { ts, pw };
}

const billingInitiateSchema = z.object({ plan: z.enum(["pro"]), phone: z.string().min(9).max(15) });

app.post("/api/billing/subscribe", requireAuth, requireOwner, billingInitiateLimiter, async (req, res) => {
  const parsed = billingInitiateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const { plan: planName, phone: rawPhone } = parsed.data;
  const digits = String(rawPhone).replace(/\D/g, "");
  let stkPhone;
  if      (/^254[17]\d{8}$/.test(digits)) stkPhone = digits;
  else if (/^0[17]\d{8}$/.test(digits))   stkPhone = "254" + digits.slice(1);
  else if (/^[17]\d{8}$/.test(digits))    stkPhone = "254" + digits;
  else return res.status(400).json({ message: "Enter a valid Safaricom phone number (07XX or 01XX)." });
  const planMeta = SUBSCRIPTION_PLANS[planName];
  if (!planMeta) return res.status(400).json({ message: "Unknown plan." });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "Account not found." });
    if (user.plan === planName && user.planExpiry && new Date(user.planExpiry) > new Date()) {
      return res.status(409).json({ message: `You already have an active ${planMeta.label} plan until ${new Date(user.planExpiry).toLocaleDateString("en-KE")}.` });
    }
    const inFlight = await prisma.subscriptionPayment.findFirst({
      where: { userId: req.userId, status: "pending", createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
    });
    if (inFlight) return res.status(409).json({ message: "A payment is already in progress. Check your phone for the M-Pesa prompt.", checkoutRequestId: inFlight.checkoutRequestId });
    let token;
    try { token = await getBillingMpesaToken(); }
    catch (tokenErr) { return res.status(tokenErr.statusCode || 502).json({ message: tokenErr.message }); }
    const creds = getBillingMpesaCredentials();
    if (!creds) return res.status(503).json({ message: "Platform billing is not configured. Contact support." });
    const { ts, pw } = billingSTKPassword(creds.SC, creds.PK);
    const callbackUrl = billingCallbackUrl();
    logger.info("billing", "Initiating billing STK push", { userId: req.userId, plan: planName, amount: planMeta.amount, phone: maskSafaricomPhone(stkPhone), shortcode: creds.SC, reqId: req.reqId });
    const stkRes = await fetchWithTimeout("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: creds.SC, Password: pw, Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: planMeta.amount, PartyA: stkPhone, PartyB: creds.SC,
        PhoneNumber: stkPhone, CallBackURL: callbackUrl,
        AccountReference: "FFSUB-" + planName.toUpperCase() + "-" + req.userId.slice(0, 8),
        TransactionDesc: `FeeFlow ${planMeta.label} Plan - ${planMeta.months} month`,
      }),
    }, 20000);
    const d = await stkRes.json().catch(() => ({}));
    logger.info("billing", "Daraja billing STK response", { reqId: req.reqId, userId: req.userId, httpStatus: stkRes.status, ResponseCode: d.ResponseCode || null });
    if (stkRes.status === 401) { invalidateBillingToken(); return res.status(502).json({ message: "M-Pesa authentication failed. Please try again." }); }
    if (d.ResponseCode !== "0") return res.status(400).json(darajaStkErrorPayload(d));
    const subPayment = await prisma.subscriptionPayment.create({
      data: { userId: req.userId, plan: planName, amount: planMeta.amount, phone: stkPhone, checkoutRequestId: d.CheckoutRequestID, merchantRequestId: d.MerchantRequestID || null, status: "pending", monthsGranted: planMeta.months },
    });
    await logAudit(req, { action: "billing_stk_push_initiated", entityType: "subscription_payment", entityId: subPayment.id, schoolOwnerId: req.userId, actorUserId: req.userId, metadata: { plan: planName, amount: planMeta.amount, phone: maskSafaricomPhone(stkPhone), checkoutRequestId: d.CheckoutRequestID } });
    return res.json({ success: true, checkoutRequestId: d.CheckoutRequestID, message: "Check your phone and enter your M-Pesa PIN to complete payment." });
  } catch (e) {
    if (e.name === "AbortError") { logger.warn("billing", "Daraja billing STK timed out", { userId: req.userId, reqId: req.reqId }); return res.status(504).json({ message: "M-Pesa request timed out. Please try again." }); }
    return apiError(res, e, "billing subscribe", req);
  }
});

app.get("/api/billing/status/:checkoutRequestId", requireAuth, requireOwner, billingPollLimiter, async (req, res) => {
  const { checkoutRequestId } = req.params;
  if (!checkoutRequestId || !/^[A-Za-z0-9_-]{10,60}$/.test(checkoutRequestId)) return res.status(400).json({ message: "Invalid checkout ID." });
  try {
    const subPayment = await prisma.subscriptionPayment.findFirst({ where: { checkoutRequestId, userId: req.userId } });
    if (!subPayment) return res.status(404).json({ message: "Payment not found." });
    let status;
    switch (subPayment.status) {
      case "success":   status = "SUCCESS"; break;
      case "failed": case "cancelled": case "expired": status = "FAILED"; break;
      default: status = "PENDING";
    }
    let freshUser = null;
    if (status === "SUCCESS") {
      const dbUser = await prisma.user.findUnique({ where: { id: req.userId } });
      if (dbUser) freshUser = pick(await normalizeUserPlan(dbUser));
    }
    return res.json({ status, plan: subPayment.plan, planExpiry: subPayment.planExpiry, mpesaRef: subPayment.mpesaRef || null, resultDesc: subPayment.resultDesc || null, user: freshUser });
  } catch (e) { return apiError(res, e, "billing status", req); }
});

app.post("/api/billing/mpesa/callback/:secret", billingCallbackLimiter, async (req, res) => {
  const configuredSecret = (process.env.BILLING_MPESA_CALLBACK_SECRET || "").trim();
  const suppliedSecret   = req.params.secret || "";
  const secretValid = configuredSecret === "open" ? true : configuredSecret.length > 0 ? timingSafeEqualString(suppliedSecret, configuredSecret) : false;
  if (!secretValid) {
    logger.warn("billing", "Billing callback: invalid path secret", { suppliedPrefix: suppliedSecret.slice(0, 8), ip: req.ip, reqId: req.reqId });
    await logAudit(null, { action: "billing_callback_rejected", entityType: "subscription_payment", metadata: { reason: "invalid_secret", ip: req.ip } }).catch(() => {});
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
  const cb = req.body?.Body?.stkCallback;
  if (!cb || typeof cb.ResultCode === "undefined" || !cb.CheckoutRequestID) {
    logger.warn("billing", "Billing callback: malformed payload", { bodyPreview: JSON.stringify(scrubAuditValue(req.body || {})).slice(0, 200), reqId: req.reqId });
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  processBillingCallback(req.body, req).catch(e =>
    logger.error("billing", "Unhandled error in billing callback processing", { error: e.message, checkoutRequestId: cb?.CheckoutRequestID })
  );
});

async function processBillingCallback(body, req = null) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return;
  const checkoutId = String(cb.CheckoutRequestID || "");
  const resultCode = Number(cb.ResultCode);
  const resultDesc = String(cb.ResultDesc || "");
  logger.payment("billing_callback_received", { checkoutId, resultCode, reqId: req?.reqId });
  await prisma.mpesaCallbackLog.create({
    data: { userId: null, checkoutRequestId: checkoutId, merchantRequestId: cb.MerchantRequestID || null, resultCode, resultDesc, status: "received", rawCallback: scrubAuditValue(body || {}), ipAddress: req?.ip || null, userAgent: req?.headers?.["user-agent"] || null },
  }).catch(e => logger.warn("billing", "Failed to log billing callback", { error: e.message }));
  const subPayment = checkoutId ? await prisma.subscriptionPayment.findFirst({ where: { checkoutRequestId: checkoutId } }) : null;
  if (!subPayment) {
    logger.warn("billing", "Billing callback: no matching SubscriptionPayment", { checkoutId, resultCode });
    await logAudit(null, { action: "billing_callback_unmatched", entityType: "subscription_payment", metadata: { checkoutId, resultCode, resultDesc } }).catch(() => {});
    return;
  }
  if (subPayment.status === "success") { logger.info("billing", "Billing callback: already processed", { checkoutId }); return; }
  if (resultCode !== 0) {
    const failedStatus = resultCode === 1032 ? "cancelled" : "failed";
    await prisma.subscriptionPayment.update({ where: { id: subPayment.id }, data: { status: failedStatus, resultCode, resultDesc, callbackReceivedAt: new Date() } });
    await logAudit(null, { action: "billing_payment_failed", entityType: "subscription_payment", entityId: subPayment.id, schoolOwnerId: subPayment.userId, metadata: { checkoutId, resultCode, resultDesc, plan: subPayment.plan } }).catch(() => {});
    logger.payment("billing_payment_failed", { checkoutId, userId: subPayment.userId, resultCode, resultDesc, plan: subPayment.plan });
    return;
  }
  const items   = cb.CallbackMetadata?.Item || [];
  const getItem = (name) => items.find(i => i.Name === name)?.Value;
  const amount  = parseFloat(getItem("Amount"));
  const mpesaRef = String(getItem("MpesaReceiptNumber") || "").trim();
  const phone   = String(getItem("PhoneNumber") || "").trim();
  if (!amount || !mpesaRef) {
    logger.error("billing", "Billing success callback missing metadata", { checkoutId, hasAmount: !!amount, hasMpesaRef: !!mpesaRef });
    await prisma.subscriptionPayment.update({ where: { id: subPayment.id }, data: { status: "failed", resultDesc: "Success callback missing payment metadata", callbackReceivedAt: new Date() } });
    return;
  }
  const duplicate = await prisma.subscriptionPayment.findFirst({ where: { mpesaRef, status: "success" } });
  if (duplicate) { logger.warn("billing", "Duplicate billing mpesaRef — already activated", { mpesaRef, checkoutId }); return; }
  if (Math.round(amount) < subPayment.amount) {
    logger.warn("billing", "Billing callback: amount mismatch", { expected: subPayment.amount, received: amount, checkoutId, userId: subPayment.userId });
    await prisma.subscriptionPayment.update({ where: { id: subPayment.id }, data: { status: "failed", resultCode, resultDesc: `Amount mismatch: expected KES ${subPayment.amount}, received KES ${Math.round(amount)}`, callbackReceivedAt: new Date(), mpesaRef } });
    await logAudit(null, { action: "billing_amount_mismatch", entityType: "subscription_payment", entityId: subPayment.id, schoolOwnerId: subPayment.userId, metadata: { expected: subPayment.amount, received: amount, mpesaRef, checkoutId } }).catch(() => {});
    return;
  }
  const now  = new Date();
  const user = await prisma.user.findUnique({ where: { id: subPayment.userId } });
  const base = user?.plan === subPayment.plan && user?.planExpiry && new Date(user.planExpiry) > now ? new Date(user.planExpiry) : now;
  const planExpiry = new Date(base);
  planExpiry.setMonth(planExpiry.getMonth() + (subPayment.monthsGranted || 1));
  await prisma.$transaction(async (tx) => {
    await tx.subscriptionPayment.update({ where: { id: subPayment.id }, data: { status: "success", mpesaRef, resultCode: 0, resultDesc, callbackReceivedAt: now, activatedAt: now, planExpiry } });
    await tx.user.update({ where: { id: subPayment.userId }, data: { plan: subPayment.plan, planExpiry } });
  });
  logger.payment("billing_plan_activated", { userId: subPayment.userId, plan: subPayment.plan, mpesaRef, amount: Math.round(amount), planExpiry: planExpiry.toISOString(), checkoutId });
  await logAudit(null, { action: "billing_plan_activated", entityType: "subscription_payment", entityId: subPayment.id, schoolOwnerId: subPayment.userId, metadata: { plan: subPayment.plan, mpesaRef, amount: Math.round(amount), phone: maskSafaricomPhone(String(phone)), planExpiry: planExpiry.toISOString() } }).catch(() => {});
  try {
    const owner = await prisma.user.findUnique({ where: { id: subPayment.userId } });
    if (owner?.email) {
      const emailHtml = renderEmailLayout({
        schoolName: owner.schoolName || "FeeFlow",
        title: "Your FeeFlow plan has been activated!",
        bodyHtml: `<p>Hi ${escHtml(owner.name || "there")},</p><p>Your <strong>FeeFlow ${escHtml(subPayment.plan.toUpperCase())} plan</strong> is now active.</p><table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px"><tr><td style="padding:8px 0;color:#666;width:40%">Plan</td><td><strong>${escHtml(subPayment.plan.toUpperCase())}</strong></td></tr><tr><td style="padding:8px 0;color:#666">Amount paid</td><td><strong>KES ${subPayment.amount.toLocaleString()}</strong></td></tr><tr><td style="padding:8px 0;color:#666">M-Pesa receipt</td><td><strong>${escHtml(mpesaRef)}</strong></td></tr><tr><td style="padding:8px 0;color:#666">Valid until</td><td><strong>${planExpiry.toLocaleDateString("en-KE", { year: "numeric", month: "long", day: "numeric" })}</strong></td></tr></table><p>You can now access all ${escHtml(subPayment.plan.toUpperCase())} features from your dashboard.</p><p style="color:#999;font-size:12px">If you did not make this payment, contact us immediately at feeflow254@gmail.com</p>`,
        ctaText: "Go to Dashboard",
        link: (process.env.FRONTEND_URL || "https://feeflowafrica.co.ke") + "/dashboard",
        accent: "#22d3a4",
      });
      await sendEmail(owner.email, `FeeFlow ${subPayment.plan.toUpperCase()} Plan Activated`, emailHtml).catch(e =>
        logger.warn("billing", "Failed to send plan activation email", { error: e.message, userId: subPayment.userId })
      );
    }
  } catch (emailErr) {
    logger.warn("billing", "Error sending billing confirmation email", { error: emailErr.message });
  }
}

app.get("/api/billing/history", requireAuth, requireOwner, async (req, res) => {
  try {
    const payments = await prisma.subscriptionPayment.findMany({
      where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 12,
      select: { id: true, plan: true, amount: true, status: true, mpesaRef: true, resultDesc: true, planExpiry: true, activatedAt: true, createdAt: true },
    });
    return res.json(payments);
  } catch (e) { return apiError(res, e, "billing history", req); }
});

// ─── END PLATFORM BILLING ──────────────────────────────────────────────────────

// ─── PLATFORM ADMIN DASHBOARD ───────────────────────────────────────────────────
// Internal-only routes for FeeFlow's own admin dashboard (not school-facing).
// All read-only aggregation — no writes, no mutation of existing models.
// Guarded by requirePlatformAdmin, which itself requires requireAuth to run first.

// Business overview — schools, students, revenue collected FROM schools' own
// parents (fee revenue, NOT FeeFlow's subscription revenue — see /subscriptions below).
app.get("/api/admin/stats/overview", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [totalSchools, totalStudents, newSchoolsThisWeek, newSchoolsThisMonth] = await Promise.all([
      prisma.user.count(),
      prisma.student.count(),
      prisma.user.count({ where: { createdAt: { gte: startOfWeek } } }),
      prisma.user.count({ where: { createdAt: { gte: startOfMonth } } }),
    ]);

    return res.json({
      totalSchools,
      totalStudents,
      newSchoolsThisWeek,
      newSchoolsThisMonth,
    });
  } catch (e) { return apiError(res, e, "admin stats overview", req); }
});

// FeeFlow's own subscription revenue — what schools pay YOU for the platform.
// Distinct from schools' fee-collection revenue (that's Payment/ledger data, not this).
app.get("/api/admin/subscriptions", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // ── Historical revenue (all-time + this month) — only successful payments count ──
    const [allTimeAgg, thisMonthAgg, byPlanAgg] = await Promise.all([
      prisma.subscriptionPayment.aggregate({
        where: { status: "success" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.subscriptionPayment.aggregate({
        where: { status: "success", createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.subscriptionPayment.groupBy({
        by: ["plan"],
        where: { status: "success" },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    // ── MRR — snapshot, recalculated live, not stored/accumulated ──
    // Definition: sum of each currently-active paying school's most recent
    // successful payment amount. Uses actual paid amount per school rather than
    // a flat plan price, since Max pricing varies by student count and this
    // avoids drift if a plan's price changes over time.
    const activeSchools = await prisma.user.findMany({
      where: {
        plan: { not: "free" },
        planExpiry: { gte: now },
      },
      select: { id: true, plan: true, planExpiry: true },
    });

    let mrr = 0;
    const mrrByPlan = {};
    if (activeSchools.length > 0) {
      const activeIds = activeSchools.map(u => u.id);
      const latestPayments = await prisma.subscriptionPayment.findMany({
        where: { userId: { in: activeIds }, status: "success" },
        orderBy: { createdAt: "desc" },
        select: { userId: true, plan: true, amount: true, createdAt: true },
      });
      const latestByUser = new Map();
      for (const p of latestPayments) {
        if (!latestByUser.has(p.userId)) latestByUser.set(p.userId, p);
      }
      for (const school of activeSchools) {
        const latest = latestByUser.get(school.id);
        if (latest) {
          mrr += latest.amount;
          mrrByPlan[school.plan] = (mrrByPlan[school.plan] || 0) + latest.amount;
        }
      }
    }

    // ── Renewal funnel — expiring soon + payment attempt outcomes ──
    const [expiringIn7, expiringIn30, expired, pendingPayments, failedPayments] = await Promise.all([
      prisma.user.count({ where: { plan: { not: "free" }, planExpiry: { gte: now, lte: in7Days } } }),
      prisma.user.count({ where: { plan: { not: "free" }, planExpiry: { gte: now, lte: in30Days } } }),
      prisma.user.count({ where: { plan: { not: "free" }, planExpiry: { lt: now } } }),
      prisma.subscriptionPayment.count({ where: { status: "pending" } }),
      prisma.subscriptionPayment.count({ where: { status: { in: ["failed", "expired", "cancelled"] } } }),
    ]);

    return res.json({
      mrr,
      mrrByPlan,
      activePayingSchools: activeSchools.length,
      revenue: {
        allTime: allTimeAgg._sum.amount || 0,
        allTimeCount: allTimeAgg._count || 0,
        thisMonth: thisMonthAgg._sum.amount || 0,
        thisMonthCount: thisMonthAgg._count || 0,
        byPlan: byPlanAgg.map(p => ({ plan: p.plan, total: p._sum.amount || 0, count: p._count })),
      },
      renewals: {
        expiringIn7Days: expiringIn7,
        expiringIn30Days: expiringIn30,
        expired,
      },
      funnel: {
        pending: pendingPayments,
        failedOrAbandoned: failedPayments,
      },
    });
  } catch (e) { return apiError(res, e, "admin subscriptions", req); }
});
// ─── END PLATFORM ADMIN DASHBOARD ───────────────────────────────────────────────

// ─── WHATSAPP INBOX ──────────────────────────────────────────────────────────
// One shared FeeFlow number receives messages from parents across all schools.
// AI drafts/auto-sends only simple, safe answers; everything else is flagged
// needs_human and only Yaya replies. See Conversation/Message models.

const last9Digits = (phone) => String(phone || "").replace(/\D/g, "").slice(-9);

const normaliseIncomingWaPhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (/^254\d{9}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return "254" + digits.slice(1);
  if (/^\d{9}$/.test(digits)) return "254" + digits;
  return digits;
};

// Resolve which school/student a parent's phone belongs to, by matching the
// last 9 digits against Student.parentPhone (format-agnostic — schools store
// phone numbers in a mix of 07xx/2547xx/etc). If multiple students share the
// same parent phone across schools, the first match is used; this is a known
// limitation acceptable at pilot scale.
async function resolveConversationOwner(waPhone) {
  const last9 = last9Digits(waPhone);
  if (!last9) return { studentId: null, ownerUserId: null };
  const student = await prisma.student.findFirst({
    where: { parentPhone: { contains: last9 }, deletedAt: null },
    select: { id: true, userId: true, name: true },
  });
  if (!student) return { studentId: null, ownerUserId: null };
  return { studentId: student.id, ownerUserId: student.userId };
}

// Builds the factual context handed to the AI classifier. Everything here is
// pulled straight from the ledger/DB — the AI is never allowed to invent a
// balance, due date, or contact detail that isn't in this object.
async function buildInboxContext(conversation) {
  if (!conversation.ownerUserId) {
    return { matched: false };
  }

  const [school, student] = await Promise.all([
    prisma.user.findUnique({
      where: { id: conversation.ownerUserId },
      select: { schoolName: true, phone: true, email: true, contactPhone: true, contactEmail: true },
    }),
    conversation.studentId
      ? prisma.student.findUnique({ where: { id: conversation.studentId }, select: { id: true, name: true, termId: true } })
      : null,
  ]);

  let balance = null;
  if (student) {
    try { balance = await deriveStudentBalance(student.id, student.termId || null); }
    catch (e) { logger.warn("inbox", "Failed to derive balance for inbox context", { studentId: student.id, error: safeErrorMessage(e) }); }
  }

  return {
    matched: true,
    schoolName: school?.schoolName || null,
    schoolContactPhone: school?.contactPhone || school?.phone || null,
    schoolContactEmail: school?.contactEmail || school?.email || null,
    studentName: student?.name || null,
    outstanding: balance ? balance.outstanding : null,
    totalCharges: balance ? balance.totalCharges : null,
    totalPaid: balance ? balance.totalPaid : null,
  };
}

const INBOX_SYSTEM_PROMPT = `You are a WhatsApp assistant for FeeFlow, a school fee management platform. You help parents with SIMPLE, FACTUAL questions using ONLY the context data provided below. You never invent numbers, names, or contact details that are not explicitly present in the context.

You MAY auto-answer:
- "What's my balance?" / "How much do I owe?" — use outstanding/totalCharges/totalPaid from context
- "How do I contact the school?" — use schoolContactPhone/schoolContactEmail from context
- General questions about how FeeFlow/payment works (e.g. "how do I pay?")

You MUST escalate (reply with canAutoAnswer: false) for:
- Any complaint, dispute, or angry/upset message
- Requests for discounts, payment plans, or fee waivers
- Any claim about a payment not reflected in the context
- Anything where "matched" is false (we don't know which school/student this is)
- Anything ambiguous, or where you are not fully certain
- Any topic unrelated to school fees/payments

Never confirm a payment was received unless the context explicitly shows it. When in doubt, escalate.

Respond with ONLY valid JSON, no markdown, no preamble:
{"canAutoAnswer": boolean, "reply": string or null}`;

// Calls Gemini (free tier) to classify + optionally draft a reply. Returns
// { canAutoAnswer: false } on any failure — fail safe, never fail open into
// an unsupervised auto-reply.
async function classifyInboxMessage(messageText, context) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    logger.warn("inbox", "AI_API_KEY not configured - all messages will escalate");
    return { canAutoAnswer: false, reply: null };
  }

  const model = process.env.AI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `${INBOX_SYSTEM_PROMPT}\n\nContext:\n${JSON.stringify(context)}\n\nParent's message:\n${messageText}`;

  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
      },
      15000
    );
    const data = await res.json();
    if (!res.ok) {
      logger.warn("inbox", "Gemini API error", { status: res.status, error: data?.error?.message });
      return { canAutoAnswer: false, reply: null };
    }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { canAutoAnswer: false, reply: null };
    const parsed = JSON.parse(text);
    if (typeof parsed?.canAutoAnswer !== "boolean") return { canAutoAnswer: false, reply: null };
    return { canAutoAnswer: parsed.canAutoAnswer, reply: parsed.reply || null };
  } catch (e) {
    logger.warn("inbox", "Failed to classify inbox message", { error: safeErrorMessage(e) });
    return { canAutoAnswer: false, reply: null };
  }
}

// Verifies Meta's X-Hub-Signature-256 against the raw request body, using the
// app secret. Requires WA_APP_SECRET to be set — if it's missing, verification
// is skipped with a warning (fails open only in that specific case, matching
// how the rest of the app behaves when optional integrations aren't configured).
function verifyMetaSignature(req) {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret) {
    logger.warn("inbox", "WA_APP_SECRET not configured - skipping signature verification");
    return true;
  }
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Webhook verification handshake — Meta calls this once when you register the
// webhook URL in the Meta App dashboard.
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Inbound message events. Always ack 200 immediately — Meta retries aggressively
// on non-200 responses, and we don't want duplicate deliveries.
app.post("/webhooks/whatsapp", async (req, res) => {
  res.sendStatus(200);

  if (!verifyMetaSignature(req)) {
    logger.warn("inbox", "WhatsApp webhook signature verification failed");
    return;
  }

  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = entry?.messages;
    if (!messages?.length) return; // status update events, etc — nothing to do

    for (const msg of messages) {
      if (msg.type !== "text" || !msg.text?.body) continue; // MVP: text only

      const waPhone = normaliseIncomingWaPhone(msg.from);
      const existing = await prisma.message.findFirst({ where: { waMessageId: msg.id } });
      if (existing) continue; // dedup — Meta occasionally redelivers

      let conversation = await prisma.conversation.findFirst({
        where: { parentPhone: waPhone },
        orderBy: { lastMessageAt: "desc" },
      });

      if (!conversation) {
        const { studentId, ownerUserId } = await resolveConversationOwner(waPhone);
        conversation = await prisma.conversation.create({
          data: { parentPhone: waPhone, studentId, ownerUserId, status: ownerUserId ? "open" : "needs_human" },
        });
      }

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: "inbound",
          sender: "customer",
          waMessageId: msg.id,
          body: msg.text.body,
        },
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });

      if (!conversation.aiEnabled) {
        await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "needs_human" } });
        continue;
      }

      const context = await buildInboxContext(conversation);
      const classification = await classifyInboxMessage(msg.text.body, context);

      if (classification.canAutoAnswer && classification.reply) {
        const sendResult = await sendWhatsAppText(waPhone, classification.reply);
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: "outbound",
            sender: "ai",
            body: classification.reply,
            status: sendResult.success ? "sent" : "failed",
          },
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      } else {
        await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "needs_human" } });
      }
    }
  } catch (e) {
    logger.error("inbox", "Failed processing WhatsApp webhook", { error: safeErrorMessage(e) });
  }
});

// ── Inbox management API — platform-admin only (Yaya is the sole responder) ──

app.get("/api/admin/inbox/conversations", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const conversations = await prisma.conversation.findMany({
      where: status ? { status: String(status) } : {},
      orderBy: { lastMessageAt: "desc" },
      take: 200,
      include: {
        owner: { select: { schoolName: true } },
        student: { select: { name: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    res.json(conversations.map(c => ({
      id: c.id,
      parentPhone: c.parentPhone,
      schoolName: c.owner?.schoolName || null,
      studentName: c.student?.name || null,
      status: c.status,
      aiEnabled: c.aiEnabled,
      lastMessageAt: c.lastMessageAt,
      lastMessage: c.messages[0]?.body || null,
    })));
  } catch (e) { return apiError(res, e, "admin inbox list", req); }
});

app.get("/api/admin/inbox/conversations/:id/messages", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId: req.params.id },
      orderBy: { createdAt: "asc" },
    });
    res.json(messages);
  } catch (e) { return apiError(res, e, "admin inbox thread", req); }
});

app.post("/api/admin/inbox/conversations/:id/reply", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ message: "Message body is required." });

    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ message: "Conversation not found." });

    const sendResult = await sendWhatsAppText(conversation.parentPhone, body);
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "outbound",
        sender: "yaya",
        body: String(body),
        status: sendResult.success ? "sent" : "failed",
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), status: "open" },
    });

    if (!sendResult.success) {
      return res.status(502).json({ message: "WhatsApp send failed.", error: sendResult.error, saved: message });
    }
    res.json(message);
  } catch (e) { return apiError(res, e, "admin inbox reply", req); }
});

app.patch("/api/admin/inbox/conversations/:id", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { status, aiEnabled, ownerUserId, studentId } = req.body || {};
    const data = {};
    if (status !== undefined) data.status = String(status);
    if (aiEnabled !== undefined) data.aiEnabled = !!aiEnabled;
    if (ownerUserId !== undefined) data.ownerUserId = ownerUserId || null;
    if (studentId !== undefined) data.studentId = studentId || null;
    if (!Object.keys(data).length) return res.status(400).json({ message: "No fields to update." });

    const conversation = await prisma.conversation.update({ where: { id: req.params.id }, data });
    res.json(conversation);
  } catch (e) { return apiError(res, e, "admin inbox update", req); }
});
// ─── END WHATSAPP INBOX ──────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, req, res, next) => {
  logger.error("express", "Unhandled error reached global handler", {
    error: safeErrorMessage(err),
    reqId: req?.reqId || null,
    path: req?.path ? redactPathTokens(req.path) : null,
    method: req?.method || null,
  });
  res.status(500).json({ message: "Internal server error" });
});

function startServer() {
  try {
    server = app.listen(PORT, "0.0.0.0", () => {
      console.log("Listening on PORT " + PORT);
      console.log("FeeFlow API -> http://0.0.0.0:" + PORT + "  [" + (process.env.NODE_ENV || "development") + "]");
      console.log("C2B validation route active");
      console.log("C2B confirmation route active");
      if (isSupabaseConfigured()) {
        logger.info("startup", "Logo storage: Supabase (persistent across deploys)");
      } else {
        logger.warn("startup", "Logo storage: local filesystem (logos will be lost on redeploy). Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET for persistent logo storage.");
      }

      if (process.env.DISABLE_LEGACY_C2B !== "true") {
        logger.warn("startup", "Legacy unauthenticated C2B routes are ACTIVE. Set DISABLE_LEGACY_C2B=true once all schools have tokenised Daraja URLs configured.");
      } else {
        logger.info("startup", "Legacy C2B routes are disabled. Only tokenised callbacks accepted.");
      }

      if (!process.env.SMS_WEBHOOK_SECRET) {
        logger.warn("startup", "SMS_WEBHOOK_SECRET is not set. SMS delivery status webhooks from Africa's Talking will be rejected with 401. Set this env var and configure the webhook URL in your AT dashboard to enable delivery tracking.");
      }

      if (!process.env.ENCRYPTION_KEY) {
        logger.warn("startup", "ENCRYPTION_KEY is not set. M-Pesa credentials are being encrypted with the insecure default key. Set ENCRYPTION_KEY in your environment immediately.");
      }

      runPostListenBoot().catch(error => {
        logger.error("startup", "Post-listen boot failed", {
          error: safeErrorMessage(error),
          stack: error?.stack,
        });
      });
    });
    server.on("error", (error) => {
      logger.error("startup", "HTTP server failed to listen", {
        error: safeErrorMessage(error),
        code: error?.code,
        port: PORT,
        stack: error?.stack,
      });
      process.exitCode = 1;
    });
  } catch (e) {
    logger.error("startup", "Synchronous startup failure before listen", {
      error: safeErrorMessage(e),
      stack: e?.stack,
    });
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
  if (!server) {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }
  server.close(async () => {
    await prisma.$disconnect();
    console.log("Database disconnected. Exiting.");
    process.exit(0);
  });
  // Force exit if it takes too long
  setTimeout(() => { console.error("Forced shutdown after timeout."); process.exit(1); }, 10_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

export {
  normalizeLookup,
  normalizeCompact,
  normalizePhone,
  normalizeSafaricomStkPhone,
  fuzzyScore,
  hintBankTransaction,
  matchBankTransaction,
  matchC2bPaybillTransaction,
  matchMpesaEvent,
  MATCH_STATUS,
};

export default app;
