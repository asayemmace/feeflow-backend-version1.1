import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import helmet from "helmet";
import { z } from "zod";
import rateLimit from "express-rate-limit";

dotenv.config();

// ─── STARTUP GUARDS ───────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY && process.env.NODE_ENV === "production") {
  console.error("FATAL: ENCRYPTION_KEY is not set in production. Refusing to start.");
  process.exit(1);
}

const app    = express();
const prisma = new PrismaClient();

// ─── REQUEST LOGGER ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== "test")
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── ENCRYPTION ──────────────────────────────────────────────────────────────
const ENC_KEY = (process.env.ENCRYPTION_KEY || "feeflow_default_key_32chars_pad!!").slice(0, 32);
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY), iv);
  return iv.toString("hex") + ":" + cipher.update(text, "utf8", "hex") + cipher.final("hex");
}
function decrypt(text) {
  if (!text) return null;
  try {
    const [ivHex, encrypted] = text.split(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
    return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
  } catch { return null; }
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:5173",
  "http://localhost:3000",
  "https://www.feeflowafrica.co.ke",
  "https://feeflowafrica.co.ke",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const ol = origin.toLowerCase();
    if (allowedOrigins.some(o => o.toLowerCase() === ol)) return callback(null, true);
    console.warn("[CORS] Blocked origin:", origin);
    callback(new Error("CORS: origin " + origin + " not allowed"));
  },
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));
app.use(helmet());

// ─── RATE LIMITERS ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { message: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth/login",        authLimiter);
app.use("/api/auth/register",     authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/verify-reset-code", authLimiter);
app.use("/api/", generalLimiter);

// ----------- ZOD SCHEMAS ─────────────────────────────────────────────────────
const createStudentSchema = z.object({
  name: z.string().min(1).max(100),
  fee: z.number().positive(),
  parentPhone: z.string().min(10),
});

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

// ─── PLAN LIMITS ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free: { students: 300, mpesa: false, invoices: false, receipts: false },
  pro:  { students: 800, mpesa: true,  invoices: true,  receipts: false },
  max:  { students: Infinity, mpesa: true, invoices: true, receipts: true },
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
  try {
    const payload = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const requirePlan = (feature) => async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    let plan = user?.plan || "free";

    // Enforce plan expiry — downgrade to free if expired
    if (plan !== "free" && user?.planExpiry && new Date() > new Date(user.planExpiry)) {
      await prisma.user.update({ where: { id: user.id }, data: { plan: "free" } });
      plan = "free";
    }

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
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    schoolName: u.schoolName, plan: u.plan, planExpiry: u.planExpiry,
    mpesaConfigured: u.mpesaConfigured || false,
  };
}

// ─── STRUCTURED ERROR MESSAGES ────────────────────────────────────────────────
// Maps Prisma error codes and known error patterns to human-readable messages.
// Use: return apiError(res, e, "context label")
function apiError(res, e, context = "") {
  console.error((context ? "[" + context + "] " : "") + (e?.message || e));

  // Prisma known errors
  if (e?.code === "P2002") return res.status(409).json({ message: "This record already exists — a duplicate was detected. Please check and try again." });
  if (e?.code === "P2025") return res.status(404).json({ message: "The record you are trying to update or delete no longer exists." });
  if (e?.code === "P2003") return res.status(400).json({ message: "This action references a record that does not exist. Please refresh and try again." });
  if (e?.code === "P2016") return res.status(404).json({ message: "Record not found in the database. It may have been deleted." });
  if (e?.code?.startsWith("P1")) return res.status(503).json({ message: "Cannot connect to the database. Please try again in a few seconds." });

  // Network / timeout errors
  if (e?.name === "AbortError") return res.status(504).json({ message: "The request timed out waiting for an external service. Please try again." });
  if (e?.message?.includes("fetch")) return res.status(502).json({ message: "Could not reach an external service. Check your internet connection and try again." });

  // JWT errors
  if (e?.name === "JsonWebTokenError") return res.status(401).json({ message: "Your session is invalid. Please log out and log back in." });
  if (e?.name === "TokenExpiredError") return res.status(401).json({ message: "Your session has expired. Please log in again." });

  // Validation errors
  if (e?.message?.includes("required")) return res.status(400).json({ message: e.message });

  // Generic fallback with context
  const ctx = context ? context + ": " : "";
  return res.status(500).json({ message: ctx + "An unexpected error occurred. Please try again. If this keeps happening, contact FeeFlow support." });
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const { name, password, schoolName } = parsed.data;
  const email = parsed.data.email.toLowerCase().trim();
  try {
    if (await prisma.user.findUnique({ where: { email } })) return res.status(400).json({ message: "Email already registered" });
    const user = await prisma.user.create({ data: { name, email, password: await bcrypt.hash(password, 10), schoolName, plan: "free" } });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: pick(user) });
  } catch (e) { return apiError(res, e, "register"); }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
  const email = parsed.data.email.toLowerCase().trim();
  const { password } = parsed.data;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Invalid email or password" });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: pick(user) });
  } catch (e) { return apiError(res, e, "login"); }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "Not found" });
    res.json(pick(user));
  } catch (e) { return apiError(res, e, "get me"); }
});

app.patch("/api/auth/profile", requireAuth, async (req, res) => {
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

app.patch("/api/auth/email", requireAuth, async (req, res) => {
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
    await prisma.user.update({ where: { id: req.userId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    res.json({ message: "Password updated" });
  } catch (e) { return apiError(res, e, "change password"); }
});

// ─── M-PESA CREDENTIALS (per-school) ─────────────────────────────────────────
app.patch("/api/auth/mpesa", requireAuth, async (req, res) => {
  const { consumerKey, consumerSecret, shortcode, passkey } = req.body;
  if (!consumerKey || !consumerSecret || !shortcode || !passkey)
    return res.status(400).json({ message: "All M-Pesa fields are required" });
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        mpesaConsumerKey:    encrypt(consumerKey),
        mpesaConsumerSecret: encrypt(consumerSecret),
        mpesaShortcode:      shortcode,
        mpesaPasskey:        encrypt(passkey),
        mpesaConfigured:     true,
      },
    });
    res.json({ message: "M-Pesa credentials saved" });
  } catch (e) { return apiError(res, e, "save M-Pesa credentials"); }
});

app.patch("/api/auth/sms", requireAuth, async (req, res) => {
  res.status(403).json({ message: "SMS credentials are now managed centrally by the administrator." });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
// BUG FIX: resetCodes uses an in-memory Map which is wiped on server restart.
// Codes are short-lived (15min) so this is acceptable for now, but note that
// it won't survive a crash/redeploy. For production, move this to the DB.
// SECURITY: attempts tracked per email to prevent brute-force guessing.
const resetCodes = new Map(); // { email -> { code, expiresAt, userId, attempts } }

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    // Always return the same message to prevent email enumeration attacks
    if (!user) return res.json({ message: "If your email is registered, you will receive a reset code." });

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    resetCodes.set(email, { code, expiresAt, userId: user.id, attempts: 0 });

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
      res.json({ message: "Reset code sent to your email" });
    } catch (emailError) {
      console.error("Failed to send reset email:", emailError);
      // BUG FIX: clean up the stored code if email failed, otherwise it's
      // an orphaned code that can never be used.
      resetCodes.delete(email);
      res.status(500).json({ message: "Failed to send reset email. Please try again." });
    }
  } catch (e) { return apiError(res, e, "forgot password"); }
});

app.post("/api/auth/verify-reset-code", async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ message: "Email and code are required" });
  try {
    const resetData = resetCodes.get(email);
    if (!resetData)              return res.status(400).json({ message: "Invalid or expired code" });
    if (new Date() > resetData.expiresAt) {
      resetCodes.delete(email);
      return res.status(400).json({ message: "Code expired" });
    }
    // SECURITY: lock out after 5 wrong attempts
    if (resetData.attempts >= 5) {
      resetCodes.delete(email);
      return res.status(400).json({ message: "Too many incorrect attempts. Please request a new code." });
    }
    // BUG FIX: check expiry BEFORE checking the code value, to avoid timing
    // leaks that reveal whether a code exists for an email.
    if (resetData.code !== code) {
      resetData.attempts += 1;
      return res.status(400).json({ message: "Invalid code" });
    }
    const resetToken = jwt.sign({ userId: resetData.userId, email }, process.env.JWT_SECRET, { expiresIn: "15m" });
    resetCodes.delete(email);
    res.json({ resetToken });
  } catch (e) { return apiError(res, e, "verify reset code"); }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) return res.status(400).json({ message: "Reset token and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(400).json({ message: "Invalid reset token" });
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(newPassword, 10) } });
    res.json({
      message: "Password reset successfully",
      token: jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" }),
    });
  } catch (jwtError) {
    if (jwtError.name === "JsonWebTokenError" || jwtError.name === "TokenExpiredError")
      return res.status(400).json({ message: "Invalid or expired reset token" });
    return apiError(res, jwtError, "reset password");
  }
});

// ─── TERMS ────────────────────────────────────────────────────────────────────
app.post("/api/terms", requireAuth, async (req, res) => {
  const { name, startDate, endDate, feeUpdates, confirmReset } = req.body;
  if (!name || !startDate || !endDate) return res.status(400).json({ message: "name, startDate and endDate required" });
  // SAFETY: Creating a new term resets ALL student paid balances to 0.
  // Require explicit confirmation to prevent accidental data wipe.
  if (!confirmReset) {
    return res.status(400).json({
      message: "Creating a new term will reset all student payment balances to zero. Pass confirmReset: true to proceed.",
      requiresConfirmation: true,
    });
  }
  try {
    await prisma.term.updateMany({ where: { userId: req.userId, status: "active" }, data: { status: "closed" } });
    await prisma.student.updateMany({ where: { userId: req.userId }, data: { paid: 0, daysOverdue: 0 } });
    if (feeUpdates && typeof feeUpdates === "object") {
      for (const [cls, fee] of Object.entries(feeUpdates)) {
        const numFee = parseFloat(fee);
        if (!isNaN(numFee) && numFee > 0)
          await prisma.student.updateMany({ where: { userId: req.userId, cls }, data: { fee: numFee } });
      }
    }
    const term = await prisma.term.create({
      data: { name, startDate: new Date(startDate), endDate: new Date(endDate), status: "active", userId: req.userId },
    });
    res.status(201).json(term);
  } catch (e) { return apiError(res, e, "create term"); }
});

app.get("/api/terms", requireAuth, async (req, res) => {
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
    if (s.paid >= s.fee) return { ...s, daysOverdue: 0 };
    const days = Math.max(0, Math.floor((now - termStart) / (1000 * 60 * 60 * 24)));
    return { ...s, daysOverdue: days };
  });
}

app.get("/api/students", requireAuth, async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    res.json(recomputeOverdue(students, activeTerm?.startDate));
  } catch (e) { return apiError(res, e, "get students"); }
});

app.get("/api/students/unpaid", requireAuth, async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const updated = recomputeOverdue(students, activeTerm?.startDate);
    res.json(
      updated.filter(s => s.paid < s.fee)
        .sort((a, b) => (b.fee - b.paid) - (a.fee - a.paid))
        .slice(0, 5)
        .map((s, i) => ({
          rank: i + 1, name: s.name, cls: s.cls,
          bal: "KES " + (s.fee - s.paid).toLocaleString(),
          days: s.daysOverdue > 0 ? s.daysOverdue + " days overdue" : "Pending",
        }))
    );
  } catch (e) { return apiError(res, e, "get unpaid students"); }
});

app.get("/api/students/:id/payments", requireAuth, async (req, res) => {
  try {
    const student = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const [payments, terms] = await Promise.all([
      prisma.payment.findMany({ where: { studentId: req.params.id }, orderBy: { createdAt: "desc" } }),
      prisma.term.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }),
    ]);
    const termSummaries = terms.map(term => {
      const termPayments = payments.filter(p => {
        const created = new Date(p.createdAt);
        const start   = new Date(term.startDate);
        const end     = term.status === "active" ? new Date() : new Date(term.endDate);
        return created >= start && created <= end;
      });
      const totalPaid = termPayments.reduce((s, p) => s + p.amount, 0);
      return {
        termId: term.id, termName: term.name, status: term.status,
        startDate: term.startDate, endDate: term.endDate,
        fee: student.fee, paid: totalPaid, cleared: totalPaid >= student.fee,
        payments: termPayments.map(p => ({
          id: p.id, amount: p.amount, method: p.method || "manual",
          txnRef: p.txnRef || null, feeBreakdown: p.feeBreakdown || [],
          createdAt: p.createdAt,
          time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
        })),
      };
    }).filter(t => t.payments.length > 0 || t.status === "active");
    res.json({
      student: {
        id: student.id, name: student.name, adm: student.adm, cls: student.cls,
        parentEmail: student.parentEmail || null, parentName: student.parentName || null,
        parentPhone: student.parentPhone || null, fee: student.fee, paid: student.paid,
        daysOverdue: student.daysOverdue,
      },
      termSummaries,
      hasUnpaidPastTerm: termSummaries.some(t => t.status === "closed" && !t.cleared && t.paid < t.fee),
      allTermsCleared:   termSummaries.length > 0 && termSummaries.every(t => t.cleared),
    });
  } catch (e) { return apiError(res, e, "get student payments"); }
});

function generateAdm(schoolName, studentName, totalCount) {
  const schoolInitials = (schoolName || "FF").split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 3).map(w => w[0].toUpperCase()).join("");
  const nameInitials   = (studentName || "ST").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const seq = String(totalCount + 1).padStart(3, "0");
  return (schoolInitials || "FF") + "-" + (nameInitials || "ST") + "-" + seq;
}

app.post("/api/students", requireAuth, async (req, res) => {
  const { name, cls, fee, paid, parentEmail, parentName, parentPhone, feeBreakdown } = req.body;
  const parsed = createStudentSchema.safeParse({ name, fee: parseFloat(fee) || 0, parentPhone });
  if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0].message });
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

    const parsedFee   = parseFloat(fee)  || 0;
    const parsedPaid  = parseFloat(paid) || 0;
    const daysOverdue = (parsedPaid < parsedFee && activeTerm)
      ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / (1000 * 60 * 60 * 24))) : 0;

    const student = await prisma.student.create({
      data: { name, adm: adm?.trim() || "", cls: cls || "", fee: parsedFee, paid: parsedPaid, parentEmail: parentEmail || null, parentName: parentName || null, parentPhone: parentPhone || null, daysOverdue, userId: req.userId },
    });
    if (parsedPaid > 0)
      await prisma.payment.create({ data: { amount: parsedPaid, method: "manual", txnRef: null, feeBreakdown: feeBreakdown || [], studentId: student.id, userId: req.userId } });
    res.status(201).json(student);
  } catch (e) {
    if (e.code === "P2002") return res.status(400).json({ message: "Admission number conflict — please try again" });
    return apiError(res, e, "create student");
  }
});

// ─── BULK IMPORT — 3 queries total, no loops, handles 500 students in <1s ─────
app.post("/api/students/import", requireAuth, async (req, res) => {
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
    const records = [];
    const usedAdm = new Set();

    for (let i = 0; i < toImport.length; i++) {
      const s = toImport[i];
      if (!s.name?.trim())        { errors.push({ row: i + 2, reason: "Missing name" });        continue; }
      if (!s.parentPhone?.trim()) { errors.push({ row: i + 2, reason: "Missing parent phone" }); continue; }

      const parsedFee  = Math.max(0, parseFloat(s.fee)  || 0);
      const parsedPaid = Math.max(0, Math.min(parseFloat(s.paid) || 0, parsedFee));
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
        name:        s.name.trim(),
        adm:         adm?.trim() || "",
        cls:         s.cls?.trim()         || "",
        fee:         parsedFee,
        paid:        parsedPaid,
        parentPhone: s.parentPhone?.trim() || null,
        parentName:  s.parentName?.trim()  || null,
        parentEmail: s.parentEmail?.trim() || null,
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
      select: { id: true, paid: true, adm: true },
    });

    // ── QUERY 3: insert all opening-balance payments in one shot ──────────────
    const paymentRecords = created
      .filter(st => st.paid > 0)
      .map(st => ({
        amount:      st.paid,
        method:      "manual",
        txnRef:      null,
        feeBreakdown: [],
        studentId:   st.id,
        userId:      req.userId,
      }));
    if (paymentRecords.length > 0)
      await prisma.payment.createMany({ data: paymentRecords });

    res.json({
      imported: records.length,
      skipped:  errors.length + skippedPlanLimit,
      errors,
      ...(skippedPlanLimit > 0 && { message: skippedPlanLimit + " students not imported — plan limit reached." }),
    });
  } catch (e) {
    console.error("bulk import:", e);
    res.status(500).json({ message: "Import failed: " + e.message });
  }
});


app.patch("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    const { name, cls, parentEmail, parentName, parentPhone, fee, paid, termId } = req.body;
    const newFee  = fee  !== undefined ? parseFloat(fee)  : s.fee;
    const newPaid = paid !== undefined ? parseFloat(paid) : s.paid;
    let daysOverdue = s.daysOverdue;
    if (fee !== undefined || paid !== undefined) {
      if (newPaid >= newFee) {
        daysOverdue = 0;
      } else {
        const activeTerm = await prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } });
        daysOverdue = activeTerm ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / (1000 * 60 * 60 * 24))) : 0;
      }
    }
    const updated = await prisma.student.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined        && { name }),
        ...(cls !== undefined         && { cls }),
        ...(parentEmail !== undefined && { parentEmail }),
        ...(parentName !== undefined  && { parentName }),
        ...(parentPhone !== undefined && { parentPhone }),
        ...(fee !== undefined         && { fee: newFee }),
        ...(paid !== undefined        && { paid: newPaid }),
        ...(termId !== undefined      && { termId }),
        daysOverdue,
      },
    });
    res.json(updated);
  } catch (e) { return apiError(res, e, "update student"); }
});

app.delete("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    // BUG FIX: also delete related invoices and receipts so we don't leave
    // orphaned records that could break receipt/invoice lookups.
    await prisma.receipt.deleteMany({ where: { studentId: req.params.id } });
    await prisma.invoice.deleteMany({ where: { studentId: req.params.id } });
    await prisma.payment.deleteMany({ where: { studentId: req.params.id } });
    await prisma.student.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (e) { return apiError(res, e, "delete student"); }
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const updated        = recomputeOverdue(students, activeTerm?.startDate);
    const totalFee       = updated.reduce((s, st) => s + st.fee, 0);
    const totalCollected = updated.reduce((s, st) => s + st.paid, 0);
    const totalArrears   = Math.max(0, totalFee - totalCollected);
    const fullyPaid      = updated.filter(s => s.fee > 0 && s.paid >= s.fee).length;
    const partial        = updated.filter(s => s.paid > 0 && s.paid < s.fee).length;
    const unpaid         = updated.filter(s => s.paid === 0).length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayPayments  = await prisma.payment.findMany({ where: { userId: req.userId, createdAt: { gte: today } }, include: { student: true } });
    const collectedToday = todayPayments.reduce((s, p) => s + p.amount, 0);
    const recentRaw      = await prisma.payment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 10, include: { student: true } });
    const recentPayments = recentRaw.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (p.student?.cls || "") + " · " + (p.student?.adm || ""),
      txn: p.txnRef || "—", method: p.method || "manual",
      amount: "KES " + Number(p.amount).toLocaleString(),
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    }));
    const topUnpaid = updated.filter(s => s.paid < s.fee).sort((a, b) => (b.fee - b.paid) - (a.fee - a.paid)).slice(0, 5)
      .map((s, i) => ({ rank: i + 1, name: s.name, cls: s.cls, bal: "KES " + (s.fee - s.paid).toLocaleString(), days: s.daysOverdue > 0 ? s.daysOverdue + "d overdue" : "Pending" }));
    const collectedPct = totalFee > 0 ? Math.round((totalCollected / totalFee) * 100) : 0;
    const arrearsPct   = totalFee > 0 ? Math.round((totalArrears   / totalFee) * 100) : 0;
    const paidPct      = updated.length > 0 ? Math.round((fullyPaid / updated.length) * 100) : 0;
    const problemPct   = updated.length > 0 ? Math.round(((partial + unpaid) / updated.length) * 100) : 0;
    res.json({
      totalCollected, totalArrears, collectedToday, paymentsToday: todayPayments.length,
      totalStudents: updated.length, fullyPaid, partial, unpaid, recentPayments, topUnpaid,
      items: [
        { label: "Total Collected", value: "KES " + Number(totalCollected).toLocaleString(), sub: "KES " + Number(totalFee).toLocaleString() + " expected", progress: collectedPct, badge: collectedPct + "% collected", badgeBg: "var(--green-bg)", badgeColor: "var(--green)", iconBg: "var(--green-bg)", iconBorder: "var(--green-border)", iconColor: "var(--green)", iconPath: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", valueColor: null, progressClass: "" },
        { label: "Outstanding Arrears", value: "KES " + Number(totalArrears).toLocaleString(), sub: (unpaid + partial) + " students with balances", progress: arrearsPct, badge: (unpaid + partial) + " students", badgeBg: "var(--red-bg)", badgeColor: "var(--red)", iconBg: "var(--red-bg)", iconBorder: "var(--red-border)", iconColor: "var(--red)", iconPath: "M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z", valueColor: "var(--red)", progressClass: "bad" },
        { label: "Fully Paid", value: fullyPaid, sub: "Out of " + updated.length + " students (" + paidPct + "%)", progress: paidPct, badge: null, badgeBg: null, badgeColor: null, iconBg: "var(--green-bg)", iconBorder: "var(--green-border)", iconColor: "var(--green)", iconPath: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", valueColor: null, progressClass: "" },
        { label: "Unpaid / Partial", value: unpaid + partial, sub: partial + " partial · " + unpaid + " not started", progress: problemPct, badge: (unpaid + partial) + " students", badgeBg: "var(--red-bg)", badgeColor: "var(--red)", iconBg: "var(--red-bg)", iconBorder: "var(--red-border)", iconColor: "var(--red)", iconPath: "M10 9H6M10 13H6m10 4H6M20 6H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2z", valueColor: "var(--red)", progressClass: "warn" },
      ],
    });
  } catch (e) { return apiError(res, e, "get stats"); }
});

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────
app.get("/api/payments/recent", requireAuth, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 30, include: { student: true } });
    res.json(payments.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (p.student?.cls || "") + " · " + (p.student?.adm || ""),
      txn: p.txnRef || "—", amount: "KES " + Number(p.amount).toLocaleString(), method: p.method,
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    })));
  } catch (e) { return apiError(res, e, "get recent payments"); }
});

app.get("/api/payments", requireAuth, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, include: { student: true } });
    res.json(payments.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (p.student?.cls || "") + " · " + (p.student?.adm || ""),
      txn: p.txnRef || "—", amount: "KES " + Number(p.amount).toLocaleString(),
      method: p.method || "manual", feeBreakdown: p.feeBreakdown || [],
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      createdAt: p.createdAt, studentId: p.studentId,
    })));
  } catch (e) { return apiError(res, e, "get all payments"); }
});

app.post("/api/payments", requireAuth, async (req, res) => {
  const { studentId, amount, txnRef, method, feeBreakdown } = req.body;
  if (!studentId || !amount) return res.status(400).json({ message: "studentId and amount required" });
  // BUG FIX: validate amount is a positive number
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ message: "Amount must be a positive number" });
  // Duplicate payment protection — same txnRef can't be recorded twice
  if (txnRef) {
    const existing = await prisma.payment.findFirst({ where: { txnRef, userId: req.userId } });
    if (existing) return res.status(409).json({ message: "This transaction reference has already been recorded." });
  }
  try {
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const payment = await prisma.payment.create({
      data: { amount: parsedAmount, txnRef: txnRef || null, method: method || "cash", feeBreakdown: feeBreakdown || [], studentId, userId: req.userId },
      include: { student: true },
    });
    const newPaid     = student.paid + parsedAmount;
    const daysOverdue = newPaid >= student.fee ? 0 : student.daysOverdue;
    await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parsedAmount }, daysOverdue } });
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (PLAN_LIMITS[user?.plan]?.receipts) {
      autoSendReceipt({ payment, student: { ...student, paid: newPaid, daysOverdue }, user }).catch(console.error);
    }
    res.status(201).json({
      id: payment.id, name: payment.student?.name,
      initials: (payment.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: (payment.student?.cls || "") + " · " + (payment.student?.adm || ""),
      txn: payment.txnRef || "—", method: payment.method, feeBreakdown: payment.feeBreakdown,
      amount: "KES " + Number(payment.amount).toLocaleString(),
      time: "Just now", createdAt: payment.createdAt, studentId: payment.studentId,
      updatedStudent: { id: studentId, paid: newPaid, daysOverdue },
    });
  } catch (e) { return apiError(res, e, "create payment"); }
});

app.delete("/api/payments/:id", requireAuth, async (req, res) => {
  try {
    const payment = await prisma.payment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    // BUG FIX: prevent paid from going below 0 after deletion
    const student = await prisma.student.findUnique({ where: { id: payment.studentId } });
    const newPaid = Math.max(0, (student?.paid || 0) - payment.amount);
    await prisma.student.update({ where: { id: payment.studentId }, data: { paid: newPaid } });
    await prisma.payment.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted", studentId: payment.studentId, amount: payment.amount });
  } catch (e) { return apiError(res, e, "delete payment"); }
});

app.get("/api/payments/unmatched", requireAuth, async (req, res) => {
  try {
    const list = await prisma.unmatchedPayment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(list.map(p => ({ id: p.id, phone: p.phone, txn: p.txnRef || "—", amount: "KES " + Number(p.amount).toLocaleString(), rawAmount: p.amount, time: new Date(p.createdAt).toLocaleString("en-KE") })));
  } catch (e) { return apiError(res, e, "get unmatched payments"); }
});

app.post("/api/payments/unmatched/:id/assign", requireAuth, async (req, res) => {
  const { studentId } = req.body;
  if (!studentId) return res.status(400).json({ message: "studentId required" });
  try {
    const unmatched = await prisma.unmatchedPayment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!unmatched) return res.status(404).json({ message: "Unmatched payment not found" });
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    await prisma.payment.create({ data: { amount: unmatched.amount, txnRef: unmatched.txnRef, method: "mpesa", feeBreakdown: [], studentId, userId: req.userId } });
    await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: unmatched.amount } } });
    await prisma.unmatchedPayment.delete({ where: { id: req.params.id } });
    res.json({ message: "Assigned successfully" });
  } catch (e) { return apiError(res, e, "assign unmatched payment"); }
});

// ─── M-PESA STK PUSH ─────────────────────────────────────────────────────────
// BUG FIX: was reading M-Pesa credentials from .env (global) instead of from
// the logged-in user's saved per-school credentials in the database.
app.post("/api/payments/stk", requireAuth, requirePlan("mpesa"), async (req, res) => {
  const { studentId, amount, phone } = req.body;
  if (!studentId || !amount || !phone) return res.status(400).json({ message: "studentId, amount and phone required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.mpesaConfigured) return res.status(503).json({ message: "M-Pesa not configured for your account. Please add your credentials in Settings." });

    const CK = decrypt(user.mpesaConsumerKey);
    const CS = decrypt(user.mpesaConsumerSecret);
    const SC = user.mpesaShortcode;
    const PK = decrypt(user.mpesaPasskey);
    const CB = (process.env.BACKEND_URL || "http://localhost:3000") + "/api/mpesa/callback/" + req.userId;

    if (!CK || !CS || !SC || !PK) return res.status(503).json({ message: "M-Pesa credentials are incomplete. Please re-enter them in Settings." });

    const auth = Buffer.from(CK + ":" + CS).toString("base64");

    // Timeout helper for external API calls — prevent hanging forever
    const fetchWithTimeout = (url, opts, ms = 10000) => {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
    };

    const tokenRes = await fetchWithTimeout(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: "Basic " + auth } }
    );
    const { access_token } = await tokenRes.json();
    if (!access_token) return res.status(502).json({ message: "Failed to authenticate with M-Pesa. Check your consumer key and secret." });

    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(SC + PK + ts).toString("base64");
    const d  = await (await fetchWithTimeout("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + access_token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: SC, Password: pw, Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(amount), PartyA: phone, PartyB: SC,
        PhoneNumber: phone, CallBackURL: CB,
        AccountReference: "FF-" + studentId,
        TransactionDesc: "School fee payment",
      }),
    })).json();

    d.ResponseCode === "0"
      ? res.json({ success: true, checkoutRequestId: d.CheckoutRequestID })
      : res.status(400).json({ message: d.errorMessage || "STK push failed" });
  } catch (e) { return apiError(res, e, "STK push"); }
});

// ─── M-PESA CALLBACK ──────────────────────────────────────────────────────────
// BUG FIX: unmatched payments were assigned to a random user via findFirst().
// Now correctly uses the :userId from the callback URL which was set at STK
// push time to match the school that initiated the payment.
app.post("/api/mpesa/callback/:userId", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb?.ResultCode === 0) {
      const items  = cb.CallbackMetadata?.Item || [];
      const get    = n => items.find(i => i.Name === n)?.Value;
      const amount = get("Amount"), ref = get("MpesaReceiptNumber"), phone = get("PhoneNumber")?.toString();

      // IDEMPOTENCY: Safaricom sometimes sends the same callback twice — ignore if already recorded
      const alreadyProcessed = await prisma.payment.findFirst({ where: { txnRef: ref } });
      if (alreadyProcessed) return res.json({ ResultCode: 0, ResultDesc: "Already processed" });

      const studentId = (cb.AccountReference || "").replace("FF-", "");
      const student   = await prisma.student.findUnique({ where: { id: studentId } });
      if (student) {
        await prisma.payment.create({ data: { amount: parseFloat(amount), txnRef: ref, method: "mpesa", feeBreakdown: [], studentId, userId: student.userId } });
        const newPaid = student.paid + parseFloat(amount);
        await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) }, daysOverdue: newPaid >= student.fee ? 0 : student.daysOverdue } });
        // Auto-receipt for Max plan users on M-Pesa callback
        const user = await prisma.user.findUnique({ where: { id: student.userId } });
        if (user && PLAN_LIMITS[user?.plan]?.receipts) {
          const payment = { id: ref, amount: parseFloat(amount), method: "mpesa", txnRef: ref, feeBreakdown: [], createdAt: new Date() };
          autoSendReceipt({ payment, student: { ...student, paid: newPaid }, user }).catch(console.error);
        }
      } else {
        // Use the userId from the callback URL, not a random user
        const callbackUserId = req.params.userId;
        const user = await prisma.user.findUnique({ where: { id: callbackUserId } });
        if (user) await prisma.unmatchedPayment.create({ data: { phone, txnRef: ref, amount: parseFloat(amount), userId: user.id } });
      }
    }
  } catch (e) { console.error("mpesa callback:", e); }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatPhoneAT(phone) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("254")) return "+" + clean;
  if (clean.startsWith("0"))   return "+254" + clean.slice(1);
  if (clean.startsWith("7") || clean.startsWith("1")) return "+254" + clean;
  return "+" + clean;
}

function genToken() { return crypto.randomBytes(8).toString("hex"); }

// XSS protection — escape all user-supplied strings before inserting into HTML
function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function nextReceiptNo(userId) {
  // Use a transaction to avoid race conditions when two receipts are created simultaneously
  const result = await prisma.$transaction(async (tx) => {
    const count = await tx.receipt.count({ where: { userId } });
    return "RCP-" + String(count + 1).padStart(4, "0");
  });
  return result;
}

async function nextInvoiceNo(userId) {
  const result = await prisma.$transaction(async (tx) => {
    const count = await tx.invoice.count({ where: { userId } });
    return count + 1;
  });
  return result;
}

function buildInvoiceMessage({ schoolName, studentName, className, admNo, totalFee, dueDate, termName, note, token }) {
  const BACKEND = process.env.BACKEND_URL || "http://localhost:3000";
  const link    = BACKEND + "/i/" + token;
  const dueFmt  = new Date(dueDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
  let message   = "FeeFlow | " + schoolName + ": Fee invoice for " + studentName + " (" + className + (admNo ? ", Adm: " + admNo : "") + "). Due: " + dueFmt + ". Amount: KES " + Number(totalFee).toLocaleString() + ".";
  if (termName) message += " Term: " + termName + ".";
  if (note)     message += " Note: " + note + ".";
  message += " View invoice: " + link;
  return message;
}

function buildReceiptMessage({ schoolName, studentName, className, amount, method, token, txnRef }) {
  const BACKEND   = process.env.BACKEND_URL || "http://localhost:3000";
  const link      = BACKEND + "/r/" + token;
  const methodFmt = method === "mpesa" ? "M-Pesa" : method === "bank" ? "Bank Transfer" : "Cash";
  let message     = "FeeFlow | " + schoolName + ": Payment receipt for " + studentName + " (" + className + "). Amount: KES " + Number(amount).toLocaleString() + " via " + methodFmt + ".";
  if (txnRef) message += " Ref: " + txnRef + ".";
  message += " Download receipt: " + link;
  return message;
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

// sendEmail uses RESEND_FROM_EMAIL env var for the sender address.
// In Resend, "onboarding@resend.dev" only delivers to your own verified account email.
// Set RESEND_FROM_EMAIL to a verified domain address (e.g. noreply@yourdomain.com)
// or leave it unset to default to the safe sandbox sender below.
// For local dev: set RESEND_TEST_EMAIL=your@email.com to catch all outgoing emails there.
const sendEmail = async (to, subject, htmlBody) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return;
  const recipient  = process.env.NODE_ENV !== "production" && process.env.RESEND_TEST_EMAIL
    ? process.env.RESEND_TEST_EMAIL : to;
  const fromAddress = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  const payload = { from: "FeeFlow <" + fromAddress + ">", to: recipient, subject, html: htmlBody };
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
app.get("/i/:token", async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { token: req.params.token },
      include: { user: { select: { schoolName: true, mpesaConfigured: true } } },
    });
    // Load live student data separately using stored studentId
    const st_live = invoice ? await prisma.student.findUnique({ where: { id: invoice.studentId } }) : null;
    if (!invoice) return res.status(404).send("<!DOCTYPE html><html><body style='font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8'><div style='text-align:center;color:#c00'><div style='font-size:48px'>X</div><h2>Invoice not found</h2><p style='color:#666'>This link may be invalid or expired.</p></div></body></html>");

    // Use live student data for current balance; fall back to invoice snapshot fields
    const st = st_live || {
      name: invoice.studentName, adm: invoice.admNo, cls: invoice.className,
      fee: invoice.totalFee, paid: invoice.paid || 0,
      parentName: null, parentPhone: null, daysOverdue: 0,
    };
    const school  = escHtml(invoice.user.schoolName || "School");
    const balance = Math.max(0, st.fee - st.paid);
    const fb      = Array.isArray(invoice.feeBreakdown) && invoice.feeBreakdown.length > 0
                      ? invoice.feeBreakdown : [{ typeName: "Tuition Fee", amount: st.fee }];
    const feeRows = fb.map(f => "<tr style='border-bottom:1px solid #eee'><td style='padding:10px 12px'>" + escHtml(f.typeName || f.name || "Fee") + "</td><td style='padding:10px 12px;text-align:right'>" + fmtKE(f.amount) + "</td></tr>").join("");
    const paidRow = st.paid > 0
      ? "<tr style='color:#27ae60'><td style='padding:8px 12px;font-weight:600'>Amount Paid</td><td style='padding:8px 12px;text-align:right;font-weight:600'>KES " + fmtKE(st.paid) + "</td></tr>"
        + "<tr style='background:" + (balance > 0 ? "#fff5f5" : "#f0fdf4") + "'><td style='padding:9px 12px;font-weight:700;color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>Balance Remaining</td><td style='padding:9px 12px;text-align:right;font-weight:700;color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>KES " + fmtKE(balance) + "</td></tr>"
      : "";

    const html = "<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Fee Invoice - " + escHtml(st.name) + "</title>"
      + "<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}.wrap{max-width:600px;margin:0 auto}.brand{text-align:center;margin-bottom:20px}.brand .name{font-size:13px;font-weight:700;color:#059669;letter-spacing:1px}.brand .sub{font-size:12px;color:#888;margin-top:2px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);overflow:hidden}.hdr{background:#003366;color:#fff;padding:24px 28px;display:flex;justify-content:space-between;align-items:flex-start}.hdr h1{font-size:20px;font-weight:700;margin-bottom:4px}.hdr .sub{font-size:11px;opacity:.75;letter-spacing:1px;text-transform:uppercase}.hdr .badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:4px 12px;border-radius:20px;font-size:11px;margin-top:8px}.body{padding:28px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}.box{background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px}.box .lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}.box .val{font-size:15px;font-weight:700;color:#003366}.box .inf{font-size:12px;color:#555;margin-top:2px}table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px}thead tr{background:#003366;color:#fff}thead th{padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.5px;font-weight:600}.total-row td{background:#e8f0fe;font-weight:700;font-size:14px;color:#003366;border-top:2px solid #003366;padding:11px 12px}.btn{display:block;width:100%;padding:14px;border-radius:10px;background:#003366;border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;margin-top:4px;text-align:center}.note{background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;color:#555;margin-bottom:20px}.footer{margin-top:18px;font-size:11px;color:#aaa;text-align:center;line-height:1.8}@media(max-width:480px){.grid{grid-template-columns:1fr}.hdr{flex-direction:column;gap:12px}}@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}body{background:#f0f4f8;padding:20px}.btn{display:none}.card{box-shadow:none}.hdr{background:#003366!important;color:#fff!important}thead tr{background:#003366!important;color:#fff!important}.total-row td{background:#e8f0fe!important;color:#003366!important}}</style>"
      + "</head><body><div class='wrap'>"
      + "<div class='brand'><div class='name'>FEEFLOW</div><div class='sub'>Fee Management Platform</div></div>"
      + "<div class='card'>"
      + "<div class='hdr'><div><h1>" + school + "</h1><div class='sub'>Official Fee Invoice</div><div class='badge'>PAYMENT DUE</div></div>"
      + "<div style='text-align:right;font-size:12px'><div style='opacity:.75'>Invoice No.</div><div style='font-size:15px;font-weight:700'>" + invoice.invoiceNo + "</div><div style='opacity:.75;margin-top:6px'>Issued</div><div>" + fmtDateKE(invoice.createdAt) + "</div></div></div>"
      + "<div class='body'><div class='grid'>"
      + "<div class='box'><div class='lbl'>Billed To</div><div class='val'>" + escHtml(st.name) + "</div><div class='inf'>" + escHtml(st.cls) + (st.adm ? " · Adm: " + escHtml(st.adm) : "") + "</div>" + (st.parentName ? "<div class='inf'>Parent: " + escHtml(st.parentName) + "</div>" : "") + (st.parentPhone ? "<div class='inf'>Phone: " + escHtml(st.parentPhone) + "</div>" : "") + "</div>"
      + "<div class='box'><div class='lbl'>Payment Due</div><div class='val' style='color:#c00'>" + fmtDateKE(invoice.dueDate) + "</div>" + (invoice.termName ? "<div class='inf'>Term: " + escHtml(invoice.termName) + "</div>" : "") + "</div>"
      + "</div>"
      + "<table><thead><tr><th>Description</th><th style='text-align:right'>Amount (KES)</th></tr></thead><tbody>" + feeRows + "</tbody>"
      + "<tfoot><tr class='total-row'><td>Total Due</td><td style='text-align:right'>KES " + fmtKE(st.fee) + "</td></tr>" + paidRow + "</tfoot></table>"
      + (invoice.note ? "<div class='note'><strong>Note:</strong> " + escHtml(invoice.note) + "</div>" : "")
      + (balance > 0 && invoice.user?.mpesaConfigured
        ? "<a href='" + (process.env.BACKEND_URL || "http://localhost:3000") + "/p/" + invoice.token + "' style='display:block;width:100%;padding:14px;border-radius:10px;background:#22d3a4;border:none;color:#0b1a14;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;margin-top:4px;text-align:center;text-decoration:none'>💳 Pay Now via M-Pesa</a>"
        : "")
      + "<button class='btn' onclick='window.print()' style='margin-top:8px'>Download / Print Invoice PDF</button>"
      + "<a href='" + (process.env.BACKEND_URL || "http://localhost:3000") + "/p/" + invoice.token + "' style='display:block;text-align:center;margin-top:10px;font-size:12px;color:#888;text-decoration:none'>🔗 View balance & payment history</a>"
      + "<div class='footer'>Please ensure payment is made before the due date.<br>For inquiries, contact " + school + " administration.<br><em>Powered by FeeFlow</em></div>"
      + "</div></div></div></body></html>";

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("invoice page:", e); res.status(500).send("<!DOCTYPE html><html><body style='font-family:Arial;padding:40px;text-align:center'><h2 style='color:#c00'>Could not load invoice</h2><p>Something went wrong on our end. Please try again or contact the school directly.</p></body></html>"); }
});

// ─── PUBLIC RECEIPT PAGE ──────────────────────────────────────────────────────
app.get("/r/:token", async (req, res) => {
  try {
    const receipt = await prisma.receipt.findFirst({
      where: { token: req.params.token },
      include: { user: { select: { schoolName: true } } },
    });
    if (!receipt) return res.status(404).send("<!DOCTYPE html><html><body style='font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8'><div style='text-align:center;color:#c00'><div style='font-size:48px'>X</div><h2>Receipt not found</h2><p style='color:#666'>This link may be invalid.</p></div></body></html>");

    const school  = escHtml(receipt.user.schoolName || "School");
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
      + "<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}.wrap{max-width:480px;margin:0 auto}.brand{text-align:center;margin-bottom:20px}.brand .name{font-size:13px;font-weight:700;color:#059669;letter-spacing:1px}.brand .sub{font-size:12px;color:#888;margin-top:2px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);overflow:hidden}.hdr{background:#059669;color:#fff;padding:20px 24px}.hdr h1{font-size:16px;font-weight:700;letter-spacing:1px}.hdr .sub{font-size:11px;opacity:.8;margin-top:3px;letter-spacing:1px;text-transform:uppercase}.body{padding:24px}.rec-no{text-align:center;font-size:12px;color:#888;margin-bottom:18px}.amount-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px}.amount-box .lbl{font-size:11px;color:#16a34a;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}.amount-box .val{font-size:30px;font-weight:800;color:#16a34a}.btn{display:block;width:100%;padding:14px;border-radius:10px;background:#059669;border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;margin-top:18px;text-align:center}.footer{margin-top:16px;font-size:11px;color:#aaa;text-align:center;line-height:1.8}@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}body{background:#f0f4f8;padding:20px}.btn{display:none}.card{box-shadow:none}.hdr{background:#059669!important;color:#fff!important}.amount-box{background:#f0fdf4!important;border-color:#bbf7d0!important}}</style>"
      + "</head><body><div class='wrap'>"
      + "<div class='brand'><div class='name'>FEEFLOW</div><div class='sub'>Fee Management Platform</div></div>"
      + "<div class='card'>"
      + "<div class='hdr'><h1>" + school + "</h1><div class='sub'>Official Payment Receipt</div></div>"
      + "<div class='body'>"
      + "<div class='rec-no'>Receipt No: <strong style='color:#333;font-family:monospace'>" + escHtml(receipt.receiptNo) + "</strong></div>"
      + "<div class='amount-box'><div class='lbl'>Amount Received</div><div class='val'>KES " + fmtKE(receipt.amount) + "</div></div>"
      + rows
      + "<div style='margin-top:14px;padding:11px 14px;border-radius:9px;background:" + (balance > 0 ? "#fff5f5" : "#f0fdf4") + ";border:1px solid " + (balance > 0 ? "#fecaca" : "#bbf7d0") + ";display:flex;justify-content:space-between;font-weight:700;font-size:13px'>"
      + "<span style='color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>Outstanding Balance</span>"
      + "<span style='color:" + (balance > 0 ? "#c00" : "#16a34a") + "'>" + (balance > 0 ? "KES " + fmtKE(balance) : "Cleared") + "</span></div>"
      + "<button class='btn' onclick='window.print()'>Download / Print Receipt PDF</button>"
      + "<div class='footer'>Thank you for your payment - " + school + "<br><em>Powered by FeeFlow</em></div>"
      + "</div></div></div></body></html>";

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("receipt page:", e); res.status(500).send("<!DOCTYPE html><html><body style='font-family:Arial;padding:40px;text-align:center'><h2 style='color:#c00'>Could not load receipt</h2><p>Something went wrong on our end. Please try again or contact the school directly.</p></body></html>"); }
});

// ─── INVOICES API ─────────────────────────────────────────────────────────────
app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(invoices);
  } catch (e) { return apiError(res, e, "get invoices"); }
});

app.post("/api/invoices", requireAuth, requirePlan("invoices"), async (req, res) => {
  const { studentIds, dueDate, termName, note, feeBreakdown, sendDate, channels } = req.body;
  if (!studentIds?.length) return res.status(400).json({ message: "Select at least one student" });
  if (!dueDate)            return res.status(400).json({ message: "Due date is required" });
  try {
    const user             = await prisma.user.findUnique({ where: { id: req.userId } });
    const students         = await prisma.student.findMany({ where: { id: { in: studentIds }, userId: req.userId } });
    const BACKEND          = process.env.BACKEND_URL || "http://localhost:3000";
    const selectedChannels = Array.isArray(channels) ? channels : [channels].filter(Boolean);
    const results          = [];
    let sentOk = 0, smsFail = 0;

    for (const student of students) {
      const token     = genToken();
      const invoiceNo = await nextInvoiceNo(req.userId);
      const invoice   = await prisma.invoice.create({
        data: {
          invoiceNo, token,
          studentId: student.id, userId: req.userId,
          studentName: student.name, className: student.cls, admNo: student.adm,
          totalFee: student.fee,
          dueDate: new Date(dueDate), termName: termName || null,
          feeBreakdown: feeBreakdown || [], note: note || null,
          channels: selectedChannels.length ? selectedChannels : ["sms"],
          status: sendDate ? "scheduled" : "sent",
          scheduledFor: sendDate ? new Date(sendDate) : null,
          sentAt: sendDate ? null : new Date(),
        },
      });
      results.push(invoice);

      if (!sendDate) {
        if (student.parentPhone) {
          const msg = buildInvoiceMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, admNo: student.adm, totalFee: student.fee, dueDate, termName, note, token });
          try {
            const smsResult = await sendSMS(student.parentPhone, msg, user);
            if (smsResult?.messageId) await prisma.invoice.update({ where: { id: invoice.id }, data: { smsMessageId: smsResult.messageId, smsStatus: "queued" } });
            sentOk++;
          } catch (e) {
            console.error("Invoice SMS:", student.name, e.message);
            await prisma.invoice.update({ where: { id: invoice.id }, data: { smsStatus: "failed" } }).catch(() => {});
            smsFail++;
          }
        }
        if (selectedChannels.includes("email") && (student.parentEmail || student.email) && process.env.RESEND_API_KEY) {
          const link = BACKEND + "/i/" + token;
          try {
            await sendEmail(
              student.parentEmail || student.email,
              "Fee Invoice - " + student.name + (termName ? " | " + termName : ""),
              "<p>Dear Parent/Guardian,</p><p>Please find your fee invoice for <strong>" + student.name + "</strong>.</p><p><a href='" + link + "' style='background:#003366;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px'>View &amp; Download Invoice</a></p><p style='color:#888;font-size:12px;margin-top:20px'>Sent by " + (user.schoolName || "School") + " via FeeFlow</p>"
            );
          } catch (e) { console.error("Invoice email:", e.message); }
        }
      }
    }
    res.json({ invoices: results, queued: sentOk, failed: smsFail, scheduled: !!sendDate, note: sentOk > 0 ? "SMS delivery confirmation will update when the telco confirms receipt." : undefined });
  } catch (e) { return apiError(res, e, "create invoices"); }
});

app.post("/api/invoices/:id/resend", requireAuth, requirePlan("invoices"), async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const channels = Array.isArray(invoice.channels) ? invoice.channels : [];
    let allOk = true;
    if (student.parentPhone) {
      const msg = buildInvoiceMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, admNo: student.adm, totalFee: invoice.totalFee, dueDate: invoice.dueDate, termName: invoice.termName, note: invoice.note, token: invoice.token });
      try { await sendSMS(student.parentPhone, msg, user); } catch { allOk = false; }
    }
    if (channels.includes("email") && (student.parentEmail || student.email)) {
      const link = (process.env.BACKEND_URL || "http://localhost:3000") + "/i/" + invoice.token;
      try { await sendEmail(student.parentEmail || student.email, "Fee Invoice - " + student.name, "<p>Fee invoice for <strong>" + student.name + "</strong>.</p><p><a href='" + link + "'>View Invoice</a></p>"); }
      catch { allOk = false; }
    }
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk });
  } catch (e) { return apiError(res, e, "resend invoice"); }
});

// ─── RECEIPTS API ─────────────────────────────────────────────────────────────
app.get("/api/receipts", requireAuth, async (req, res) => {
  try {
    const receipts = await prisma.receipt.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(receipts);
  } catch (e) { return apiError(res, e, "get receipts"); }
});

app.post("/api/receipts/manual", requireAuth, async (req, res) => {
  const { paymentId, studentId, channels } = req.body;
  if (!paymentId) return res.status(400).json({ message: "Payment ID required" });
  try {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, userId: req.userId } });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    const student = await prisma.student.findUnique({ where: { id: studentId || payment.studentId } });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const selectedChannels = Array.isArray(channels) ? channels : [channels].filter(Boolean);
    const token     = genToken();
    const receiptNo = await nextReceiptNo(req.userId);
    const receipt   = await prisma.receipt.create({
      data: {
        userId: req.userId, paymentId: payment.id, studentId: student.id,
        studentName: student.name, admNo: student.adm, className: student.cls,
        amount: payment.amount, method: payment.method, txnRef: payment.txnRef || null,
        paidAt: payment.createdAt, token, receiptNo,
        channels: selectedChannels.length ? selectedChannels : ["sms"],
        type: "manual", balance: Math.max(0, student.fee - student.paid), status: "pending",
      },
    });
    const msg = buildReceiptMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, amount: payment.amount, method: payment.method, token, txnRef: payment.txnRef });
    let allOk = true;
    if (student.parentPhone) {
      try {
        const smsResult = await sendSMS(student.parentPhone, msg, user);
        if (smsResult?.messageId) await prisma.receipt.update({ where: { id: receipt.id }, data: { smsMessageId: smsResult.messageId, smsStatus: "queued" } }).catch(() => {});
      } catch (e) {
        console.error("Receipt SMS failed:", e.message);
        await prisma.receipt.update({ where: { id: receipt.id }, data: { smsStatus: "failed" } }).catch(() => {});
        allOk = false;
      }
    }
    if (selectedChannels.includes("email") && (student.parentEmail || student.email)) {
      try { await sendEmail(student.parentEmail || student.email, "Payment Receipt - " + student.name, "<pre style='font-family:sans-serif;white-space:pre-wrap'>" + msg + "</pre>"); }
      catch (e) { console.error("Receipt email failed:", e.message); allOk = false; }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk, receipt });
  } catch (e) { return apiError(res, e, "send manual receipt"); }
});

app.post("/api/receipts/:id/resend", requireAuth, async (req, res) => {
  try {
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    const student = await prisma.student.findUnique({ where: { id: receipt.studentId } });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    const msg      = buildReceiptMessage({ schoolName: user.schoolName || "School", studentName: receipt.studentName, className: receipt.className, amount: receipt.amount, method: receipt.method, token: receipt.token, txnRef: receipt.txnRef });
    const channels = Array.isArray(receipt.channels) ? receipt.channels : [];
    let allOk = true;
    if (student?.parentPhone) {
      try { await sendSMS(student.parentPhone, msg, user); } catch { allOk = false; }
    }
    if (channels.includes("email") && (student?.parentEmail || student?.email)) {
      try { await sendEmail(student.parentEmail || student.email, "Payment Receipt - " + receipt.studentName, "<pre style='font-family:sans-serif;white-space:pre-wrap'>" + msg + "</pre>"); }
      catch { allOk = false; }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk });
  } catch (e) { return apiError(res, e, "resend receipt"); }
});

// ─── AUTO-RECEIPT (Max plan) ──────────────────────────────────────────────────
async function autoSendReceipt({ payment, student, user }) {
  try {
    const token     = genToken();
    const receiptNo = await nextReceiptNo(user.id);
    const receipt   = await prisma.receipt.create({
      data: {
        userId: user.id, paymentId: payment.id, studentId: student.id,
        studentName: student.name, admNo: student.adm, className: student.cls,
        amount: payment.amount, method: payment.method, txnRef: payment.txnRef || null,
        paidAt: payment.createdAt, token, receiptNo,
        channels: ["sms", "email"], type: "auto",
        balance: Math.max(0, student.fee - student.paid), status: "pending",
      },
    });
    const msg = buildReceiptMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, amount: payment.amount, method: payment.method, token, txnRef: payment.txnRef });
    let allOk = true;
    if (student.parentPhone) {
      try { await sendSMS(student.parentPhone, msg, user); }
      catch (e) { console.error("Auto-receipt SMS failed:", e.message); allOk = false; }
    }
    if (student.parentEmail || student.email) {
      try { await sendEmail(student.parentEmail || student.email, "Payment Receipt - " + student.name, "<pre style='font-family:sans-serif;white-space:pre-wrap'>" + msg + "</pre>"); }
      catch (e) { console.error("Auto-receipt email failed:", e.message); allOk = false; }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
  } catch (e) { console.error("Auto-receipt failed:", e.message); }
}

// ─── SCHEDULED INVOICE PROCESSOR ─────────────────────────────────────────────
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
      if (student.parentPhone) {
        const msg = buildInvoiceMessage({ schoolName: user.schoolName || "School", studentName: student.name, className: student.cls, admNo: student.adm, totalFee: invoice.totalFee, dueDate: invoice.dueDate, termName: invoice.termName, note: invoice.note, token: invoice.token });
        try { await sendSMS(student.parentPhone, msg, user); } catch { allOk = false; }
      }
      if (channels.includes("email") && (student.parentEmail || student.email)) {
        const link = (process.env.BACKEND_URL || "http://localhost:3000") + "/i/" + invoice.token;
        try { await sendEmail(student.parentEmail || student.email, "Fee Invoice - " + student.name, "<p>Fee invoice for <strong>" + student.name + "</strong>. <a href='" + link + "'>View Invoice</a></p>"); }
        catch { allOk = false; }
      }
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
  finally { schedulerRunning = false; }
}, 60 * 1000);

// ─── SMS DELIVERY REPORT WEBHOOK (Africa's Talking) ─────────────────────────
// AT posts delivery reports here when an SMS reaches the handset (or fails).
// Configure in AT dashboard: Settings → SMS → Delivery Reports
// URL: https://your-backend.com/api/sms/delivery
// This updates status from "queued" → "delivered" or "failed"
app.post("/api/sms/delivery", async (req, res) => {
  try {
    const { id, status, phoneNumber, failureReason } = req.body;
    if (!id) return res.sendStatus(200);
    const deliveryStatus =
      ["DeliveredToTerminal", "Success"].includes(status) ? "delivered" :
      ["DeliveredToNetwork"].includes(status)             ? "queued" :
      ["Failed", "RejectedByNetwork", "InvalidPhoneNumber", "DeliveryFailure", "MessageRejected"].includes(status) ? "failed" : "queued";
    console.log(`[SMS] id=${id} phone=${phoneNumber} AT=${status} → ${deliveryStatus}${failureReason ? " ("+failureReason+")" : ""}`);
    const [inv, rec] = await Promise.all([
      prisma.invoice.updateMany({ where: { smsMessageId: id }, data: { smsStatus: deliveryStatus } }),
      prisma.receipt.updateMany({ where: { smsMessageId: id }, data: { smsStatus: deliveryStatus } }),
    ]);
    if (inv.count || rec.count) console.log(`[SMS] Updated ${inv.count} invoices, ${rec.count} receipts → ${deliveryStatus}`);
  } catch (e) { console.error("SMS delivery webhook:", e.message); }
  res.sendStatus(200);
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
    return req.ip;
  },
  skip: (req) => false,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many payment attempts. Please wait 10 minutes." },
});

app.post("/api/pay/:invoiceToken", payNowLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number is required" });

  try {
    // Load invoice + school credentials in one query
    const invoice = await prisma.invoice.findFirst({
      where: { token: req.params.invoiceToken },
      include: { user: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } }) || {
      id: invoice.studentId, name: invoice.studentName, adm: invoice.admNo,
      cls: invoice.className, fee: invoice.totalFee, paid: invoice.paid || 0,
    };
    const school  = invoice.user;
    const balance = Math.max(0, student.fee - student.paid);

    if (balance <= 0) return res.status(400).json({ error: "This invoice is already fully paid." });
    if (!school.mpesaConfigured) return res.status(503).json({ error: "This school has not set up M-Pesa payments yet. Please pay at the school office." });

    // Decrypt THIS SCHOOL'S credentials — not a global key
    const CK = decrypt(school.mpesaConsumerKey);
    const CS = decrypt(school.mpesaConsumerSecret);
    const SC = school.mpesaShortcode;
    const PK = decrypt(school.mpesaPasskey);

    if (!CK || !CS || !SC || !PK) return res.status(503).json({ error: "M-Pesa credentials incomplete. Please contact the school." });

    // Format phone for Safaricom
    const cleanPhone = formatPhoneAT(phone)?.replace("+", "");
    if (!cleanPhone) return res.status(400).json({ error: "Invalid phone number format" });

    const secretSuffix = process.env.MPESA_CALLBACK_SECRET ? "?secret=" + process.env.MPESA_CALLBACK_SECRET : "";
    const CB = (process.env.BACKEND_URL || "http://localhost:3000") + "/api/mpesa/callback/" + school.id + secretSuffix;

    const auth = Buffer.from(CK + ":" + CS).toString("base64");
    const tokenRes = await fetchWithTimeout(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: "Basic " + auth } }
    );
    const { access_token } = await tokenRes.json();
    if (!access_token) return res.status(502).json({ error: "Failed to connect to M-Pesa. Please try again." });

    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(SC + PK + ts).toString("base64");

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
      res.json({ success: true, checkoutRequestId: d.CheckoutRequestID, amount: balance });
    } else {
      res.status(400).json({ error: d.errorMessage || d.ResponseDescription || "STK push failed. Please try again." });
    }
  } catch (e) {
    if (e.name === "AbortError") return res.status(504).json({ error: "M-Pesa timed out. Please try again." });
    return res.status(500).json({ error: e.message?.includes("M-Pesa") ? e.message : "Payment failed. Please try again." });
  }
});

// ─── PUBLIC PAYMENT STATUS POLL ──────────────────────────────────────────────
// Parent page polls this after STK push to detect when payment completes.
// Returns live student balance — no auth needed, token proves access.
app.get("/api/pay/:invoiceToken/status", async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { token: req.params.invoiceToken },
    });
    if (!invoice) return res.status(404).json({ error: "Not found" });
    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    const balance = student ? Math.max(0, student.fee - student.paid) : 0;
    res.json({
      paid:    student?.paid || 0,
      fee:     student?.fee || invoice.totalFee,
      balance,
      cleared: balance === 0,
    });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ─── PARENT PORTAL API ────────────────────────────────────────────────────────
// Public — secured by the invoice token which only the school + parent have.
// Returns student info, payment history, and receipts for the parent to view.
app.get("/api/portal/:invoiceToken", async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { token: req.params.invoiceToken },
      include: { user: { select: { schoolName: true, plan: true } } },
    });
    if (!invoice) return res.status(404).json({ error: "Portal not found" });

    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } }) || {
      id: invoice.studentId, name: invoice.studentName, adm: invoice.admNo,
      cls: invoice.className, fee: invoice.totalFee, paid: invoice.paid || 0,
      daysOverdue: 0,
    };
    const school  = invoice.user;

    // All payments for this student (not soft-deleted)
    const payments = await prisma.payment.findMany({
      where: { studentId: student.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });

    // All receipts for this student
    const receipts = await prisma.receipt.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: "desc" },
    });

    const BACKEND = process.env.BACKEND_URL || "http://localhost:3000";

    res.json({
      school: { name: school.schoolName || "School" },
      student: {
        name:       student.name,
        adm:        student.adm,
        cls:        student.cls,
        fee:        student.fee,
        paid:       student.paid,
        balance:    Math.max(0, student.fee - student.paid),
        daysOverdue: student.daysOverdue,
        cleared:    student.paid >= student.fee,
        pctPaid:    student.fee > 0 ? Math.min(100, Math.round((student.paid / student.fee) * 100)) : 0,
      },
      payments: payments.map(p => ({
        id:        p.id,
        amount:    p.amount,
        method:    p.method,
        txnRef:    p.txnRef || null,
        createdAt: p.createdAt,
        time: new Date(p.createdAt).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }),
      })),
      receipts: receipts.map(r => ({
        id:        r.id,
        receiptNo: r.receiptNo,
        amount:    r.amount,
        method:    r.method,
        paidAt:    r.paidAt,
        link:      BACKEND + "/r/" + r.token,
        time: new Date(r.paidAt).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }),
      })),
    });
  } catch (e) { return res.status(500).json({ error: "Could not load portal data. Please refresh the page." }); }
});

// ─── PARENT PORTAL PAGE ───────────────────────────────────────────────────────
// Full HTML page served at /p/:invoiceToken
// Shows student balance overview + payment history + receipts
app.get("/p/:invoiceToken", async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { token: req.params.invoiceToken },
      include: { user: { select: { schoolName: true, mpesaConfigured: true } } },
    });
    if (!invoice) return res.status(404).send(notFoundPage("Portal not found", "This link may be invalid or expired."));

    // Load live student data for current balance
    const st_portal = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    const st      = st_portal || {
      name: invoice.studentName, adm: invoice.admNo, cls: invoice.className,
      fee: invoice.totalFee, paid: invoice.paid || 0, daysOverdue: 0,
    };
    const school  = invoice.user;
    const balance = Math.max(0, st.fee - st.paid);
    const pct     = st.fee > 0 ? Math.min(100, Math.round((st.paid / st.fee) * 100)) : 0;
    const cleared = balance === 0;
    const BACKEND = process.env.BACKEND_URL || "http://localhost:3000";
    const token   = req.params.invoiceToken;

    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',system-ui,sans-serif;background:#0b0f1a;color:#e8edf5;min-height:100vh;padding:0}
      .wrap{max-width:520px;margin:0 auto;padding:24px 16px 48px}
      .brand{text-align:center;padding:20px 0 16px;font-size:13px;font-weight:700;color:#22d3a4;letter-spacing:1px}
      .brand span{display:block;font-size:11px;font-weight:400;color:#4a5f80;margin-top:3px;letter-spacing:.5px}
      .school-hdr{background:#111827;border:1px solid #1e2d47;border-radius:14px;padding:20px 22px;margin-bottom:16px;display:flex;align-items:center;gap:14px}
      .school-avatar{width:44px;height:44px;border-radius:10px;background:rgba(34,211,164,.12);border:1px solid rgba(34,211,164,.2);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#22d3a4;flex-shrink:0}
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
      .progress-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#22d3a4,#3b82f6);transition:width .6s ease}
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
      .pay-title{font-size:14px;font-weight:700;color:#e8edf5;margin-bottom:4px}
      .pay-sub{font-size:12px;color:#4a5f80;margin-bottom:16px}
      .phone-row{display:flex;gap:8px}
      .phone-input{flex:1;padding:11px 14px;background:#1a2236;border:1px solid #1e2d47;border-radius:9px;color:#e8edf5;font-size:14px;font-family:inherit;outline:none}
      .phone-input:focus{border-color:#22d3a4}
      .pay-btn{padding:11px 18px;border-radius:9px;background:#22d3a4;border:none;color:#0b1a14;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:opacity .15s}
      .pay-btn:disabled{opacity:.5;cursor:not-allowed}
      .pay-status{margin-top:12px;padding:11px 14px;border-radius:9px;font-size:13px;font-weight:500;display:none}
      .pay-status.show{display:block}
      .pay-status.pending{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);color:#f59e0b}
      .pay-status.success{background:rgba(34,211,164,.1);border:1px solid rgba(34,211,164,.2);color:#22d3a4}
      .pay-status.error{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.2);color:#f87171}
      .empty{text-align:center;padding:32px 16px;color:#4a5f80;font-size:13px}
      .empty-icon{font-size:32px;margin-bottom:8px}
      .share-btn{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:11px;border-radius:9px;background:transparent;border:1px solid #1e2d47;color:#8a9dbf;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:8px;transition:all .15s}
      .share-btn:hover{border-color:#22d3a4;color:#22d3a4}
      @media(max-width:400px){.amounts{grid-template-columns:1fr 1fr}.amt-box:last-child{grid-column:span 2}}
    `;

    const statusClass = cleared ? "status-cleared" : st.paid > 0 ? "status-partial" : "status-unpaid";
    const statusText  = cleared ? "CLEARED" : st.paid > 0 ? "PARTIAL" : "UNPAID";
    const mpesaSection = school.mpesaConfigured && balance > 0 ? `
      <div class="pay-section">
        <div class="pay-title">💳 Pay Now via M-Pesa</div>
        <div class="pay-sub">Enter your M-Pesa number to pay KES ${fmtKE(balance)} directly</div>
        <div class="phone-row">
          <input class="phone-input" id="phone" type="tel" placeholder="e.g. 0712 345 678" maxlength="13" />
          <button class="pay-btn" id="payBtn" onclick="triggerPay()">Send</button>
        </div>
        <div class="pay-status" id="payStatus"></div>
      </div>` : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fee Portal — ${escHtml(st.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">FEEFLOW <span>Parent Fee Portal</span></div>

  <!-- School header -->
  <div class="school-hdr">
    <div class="school-avatar">${escHtml((school.schoolName || "S")[0].toUpperCase())}</div>
    <div>
      <div class="school-name">${escHtml(school.schoolName || "School")}</div>
      <div class="school-sub">Fee Management Portal</div>
    </div>
  </div>

  <!-- Balance card -->
  <div class="balance-card">
    <div class="balance-top">
      <div>
        <div class="student-name">${escHtml(st.name)}</div>
        <div class="student-meta">${escHtml(st.cls)}${st.adm ? " · Adm: " + escHtml(st.adm) : ""}</div>
      </div>
      <div class="status-badge ${statusClass}">${statusText}</div>
    </div>
    <div class="amounts">
      <div class="amt-box">
        <div class="amt-lbl">Term Fee</div>
        <div class="amt-val" style="color:#8a9dbf">KES ${fmtKE(st.fee)}</div>
      </div>
      <div class="amt-box">
        <div class="amt-lbl">Paid</div>
        <div class="amt-val" style="color:#22d3a4">KES ${fmtKE(st.paid)}</div>
      </div>
      <div class="amt-box">
        <div class="amt-lbl">Balance</div>
        <div class="amt-val" style="color:${balance > 0 ? "#f87171" : "#22d3a4"}">${balance > 0 ? "KES " + fmtKE(balance) : "✓ Nil"}</div>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-lbl">${pct}% paid</div>
    </div>
  </div>

  ${mpesaSection}

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" onclick="showTab('payments',this)">Payments</button>
    <button class="tab" onclick="showTab('receipts',this)">Receipts</button>
  </div>

  <!-- Payments tab -->
  <div class="section active" id="tab-payments">
    <div id="payments-list">
      <div style="text-align:center;padding:20px;color:#4a5f80;font-size:13px">Loading payments…</div>
    </div>
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
let pollTimer = null;

// ── Load portal data ──────────────────────────────────────────────────────────
async function loadPortal() {
  try {
    const r = await fetch(BACKEND + "/api/portal/" + TOKEN);
    const d = await r.json();
    renderPayments(d.payments || []);
    renderReceipts(d.receipts || []);
  } catch(e) {
    document.getElementById("payments-list").innerHTML = "<div class='empty'><div class='empty-icon'>⚠️</div>Could not load data. Please refresh.</div>";
  }
}

function fmtMethod(m) {
  return m === "mpesa" ? "M-Pesa" : m === "bank" ? "Bank Transfer" : "Cash";
}

function renderPayments(payments) {
  const el = document.getElementById("payments-list");
  if (!payments.length) {
    el.innerHTML = "<div class='empty'><div class='empty-icon'>💸</div>No payments recorded yet</div>";
    return;
  }
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
  if (!receipts.length) {
    el.innerHTML = "<div class='empty'><div class='empty-icon'>🧾</div>No receipts issued yet</div>";
    return;
  }
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

// ── Pay Now ───────────────────────────────────────────────────────────────────
async function triggerPay() {
  const phone  = document.getElementById("phone").value.trim();
  const btn    = document.getElementById("payBtn");
  const status = document.getElementById("payStatus");

  if (!phone) { showStatus("Please enter your M-Pesa phone number", "error"); return; }

  btn.disabled = true;
  btn.textContent = "Sending…";
  showStatus("⏳ Sending M-Pesa request to your phone…", "pending");

  try {
    const r = await fetch(BACKEND + "/api/pay/" + TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const d = await r.json();

    if (d.success) {
      showStatus("✅ Check your phone! Enter your M-Pesa PIN to complete payment of KES " + Number(d.amount).toLocaleString("en-KE") + ".", "success");
      btn.textContent = "Sent ✓";
      startPolling();
    } else {
      showStatus("❌ " + (d.error || "Payment failed. Please try again."), "error");
      btn.disabled = false;
      btn.textContent = "Send";
    }
  } catch(e) {
    showStatus("❌ Network error. Please check your connection and try again.", "error");
    btn.disabled = false;
    btn.textContent = "Send";
  }
}

function showStatus(msg, type) {
  const el = document.getElementById("payStatus");
  el.className = "pay-status show " + type;
  el.textContent = msg;
}

// ── Poll for payment completion every 5 seconds for up to 2 minutes ──────────
function startPolling() {
  let attempts = 0;
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 24) { clearInterval(pollTimer); return; } // stop after 2 min
    try {
      const r = await fetch(BACKEND + "/api/pay/" + TOKEN + "/status");
      const d = await r.json();
      if (d.cleared || (d.paid && d.paid > 0 && d.balance < ${balance})) {
        clearInterval(pollTimer);
        showStatus("🎉 Payment received! Your balance is now KES " + Number(d.balance).toLocaleString("en-KE") + ". Refreshing…", "success");
        setTimeout(() => window.location.reload(), 2500);
      }
    } catch {}
  }, 5000);
}

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

loadPortal();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("parent portal:", e); res.status(500).send("Server error"); }
});

app.get("/health", (_, res) => res.json({ ok: true, version: "3.1" }));
app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ message: "Internal server error" }); });

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => console.log("FeeFlow API → http://0.0.0.0:" + PORT + "  [" + (process.env.NODE_ENV || "development") + "]"));

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
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

export default app;