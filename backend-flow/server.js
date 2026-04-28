import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

dotenv.config();

const app    = express();
const prisma = new PrismaClient();

// ─── Credential encryption ────────────────────────────────────────────────────
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

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:5173",
  "http://localhost:3000",
  "https://asayflow.netlify.app",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));

const PLAN_LIMITS = {
  free: { students: 300, mpesa: false, invoices: false, receipts: false },
  pro:  { students: 800, mpesa: true,  invoices: true,  receipts: false },
  max:  { students: Infinity, mpesa: true, invoices: true, receipts: true },
};

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
    const plan = user?.plan || "free";
    if (!PLAN_LIMITS[plan]?.[feature]) {
      return res.status(403).json({
        message: `This feature requires a Pro or Max plan. You are on ${plan.toUpperCase()}.`,
        upgradeRequired: true, feature,
      });
    }
    req.user = user;
    next();
  } catch { res.status(500).json({ message: "Something went wrong" }); }
};

function pick(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, schoolName: u.schoolName, plan: u.plan, planExpiry: u.planExpiry };
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, schoolName } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: "Name, email and password are required" });
  try {
    if (await prisma.user.findUnique({ where: { email } })) return res.status(400).json({ message: "Email already registered" });
    const user = await prisma.user.create({ data: { name, email, password: await bcrypt.hash(password, 10), schoolName, plan: "free" } });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: pick(user) });
  } catch (e) { console.error("register:", e); res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Invalid email or password" });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: pick(user) });
  } catch (e) { console.error("login:", e); res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "Not found" });
    res.json(pick(user));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/profile", requireAuth, async (req, res) => {
  const { name, phone, schoolName } = req.body;
  try {
    const user = await prisma.user.update({ where: { id: req.userId }, data: { ...(name && { name }), ...(phone !== undefined && { phone }), ...(schoolName !== undefined && { schoolName }) } });
    res.json(pick(user));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/email", requireAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and current password required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Current password is incorrect" });
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists && exists.id !== req.userId) return res.status(400).json({ message: "Email already in use" });
    const updated = await prisma.user.update({ where: { id: req.userId }, data: { email } });
    res.json(pick(updated));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both passwords required" });
  if (newPassword.length < 6) return res.status(400).json({ message: "Min 6 characters" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ message: "Current password is incorrect" });
    await prisma.user.update({ where: { id: req.userId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    res.json({ message: "Password updated" });
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

// PATCH /api/auth/mpesa — save encrypted M-Pesa credentials per school
app.patch("/api/auth/mpesa", requireAuth, async (req, res) => {
  const { consumerKey, consumerSecret, shortcode, passkey } = req.body;
  if (!consumerKey || !consumerSecret || !shortcode || !passkey)
    return res.status(400).json({ message: "All M-Pesa fields are required" });
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: { mpesaConsumerKey: encrypt(consumerKey), mpesaConsumerSecret: encrypt(consumerSecret), mpesaShortcode: shortcode, mpesaPasskey: encrypt(passkey), mpesaConfigured: true },
    });
    res.json({ message: "M-Pesa credentials saved" });
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

// PATCH /api/auth/sms — deprecated endpoint (SMS now centralized)
app.patch("/api/auth/sms", requireAuth, async (req, res) => {
  res.status(403).json({ message: "SMS credentials are now managed centrally by the administrator. Individual school credentials are no longer required." });
});

// ─── Forgot Password ─────────────────────────────────────────────────────────────
// Store reset codes in memory (in production, use Redis or database)
const resetCodes = new Map();

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });
  
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't reveal if email exists or not for security
      return res.json({ message: "If your email is registered, you will receive a reset code." });
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    
    // Store reset code
    resetCodes.set(email, { code, expiresAt, userId: user.id });
    
    // Send email with Resend
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #003366;">Password Reset - FeeFlow</h2>
        <p>Hi ${user.name},</p>
        <p>You requested a password reset for your FeeFlow account.</p>
        <div style="background: #f0f4f8; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <p style="margin: 0; font-size: 24px; font-weight: bold; color: #003366; letter-spacing: 3px;">${code}</p>
        </div>
        <p>This code will expire in 15 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        <p style="color: #666; font-size: 12px;">Sent by FeeFlow Fee Management Platform</p>
      </div>
    `;
    
    try {
      await sendEmail(email, "Password Reset Code - FeeFlow", emailHtml, null);
      res.json({ message: "Reset code sent to your email" });
    } catch (emailError) {
      console.error("Failed to send reset email:", emailError);
      res.status(500).json({ message: "Failed to send reset email. Please try again." });
    }
  } catch (e) {
    console.error("Forgot password error:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

app.post("/api/auth/verify-reset-code", async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ message: "Email and code are required" });
  
  try {
    const resetData = resetCodes.get(email);
    if (!resetData) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    
    if (resetData.code !== code) {
      return res.status(400).json({ message: "Invalid code" });
    }
    
    if (new Date() > resetData.expiresAt) {
      resetCodes.delete(email);
      return res.status(400).json({ message: "Code expired" });
    }
    
    // Generate reset token
    const resetToken = jwt.sign({ userId: resetData.userId, email }, process.env.JWT_SECRET, { expiresIn: '15m' });
    
    // Clear the used code
    resetCodes.delete(email);
    
    res.json({ resetToken });
  } catch (e) {
    console.error("Verify reset code error:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) return res.status(400).json({ message: "Reset token and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
  
  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    
    if (!user) {
      return res.status(400).json({ message: "Invalid reset token" });
    }
    
    // Update password
    await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(newPassword, 10) }
    });
    
    res.json({ message: "Password reset successfully", token: jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" }) });
  } catch (jwtError) {
    if (jwtError.name === 'JsonWebTokenError' || jwtError.name === 'TokenExpiredError') {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }
    console.error("Reset password error:", jwtError);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Terms ────────────────────────────────────────────────────────────────────
app.post("/api/terms", requireAuth, async (req, res) => {
  const { name, startDate, endDate, feeUpdates } = req.body;
  // feeUpdates: { [cls]: number } — optional, updates fee for all students in that class
  if (!name || !startDate || !endDate) return res.status(400).json({ message: "name, startDate and endDate required" });
  try {
    await prisma.term.updateMany({ where: { userId: req.userId, status: "active" }, data: { status: "closed" } });

    // Reset paid + daysOverdue for all students
    await prisma.student.updateMany({ where: { userId: req.userId }, data: { paid: 0, daysOverdue: 0 } });

    // Apply fee updates per class if provided
    if (feeUpdates && typeof feeUpdates === "object") {
      for (const [cls, fee] of Object.entries(feeUpdates)) {
        const numFee = parseFloat(fee);
        if (!isNaN(numFee) && numFee > 0) {
          await prisma.student.updateMany({
            where: { userId: req.userId, cls },
            data: { fee: numFee },
          });
        }
      }
    }

    const term = await prisma.term.create({
      data: { name, startDate: new Date(startDate), endDate: new Date(endDate), status: "active", userId: req.userId },
    });
    res.status(201).json(term);
  } catch (e) {
    console.error("create term:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

app.get("/api/terms", requireAuth, async (req, res) => {
  try {
    const terms = await prisma.term.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(terms);
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Students ──────────────────────────────────────────────────────────────────
// Helper: recompute daysOverdue for a list of students given an active term start
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
    // Recompute daysOverdue live on every fetch — fixes the staleness bug
    const updated = recomputeOverdue(students, activeTerm?.startDate);
    res.json(updated);
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/students/unpaid", requireAuth, async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);
    const updated = recomputeOverdue(students, activeTerm?.startDate);
    res.json(
      updated
        .filter(s => s.paid < s.fee)
        .sort((a, b) => (b.fee - b.paid) - (a.fee - a.paid))
        .slice(0, 5)
        .map((s, i) => ({
          rank: i + 1, name: s.name, cls: s.cls,
          bal: `KES ${(s.fee - s.paid).toLocaleString()}`,
          days: s.daysOverdue > 0 ? `${s.daysOverdue} days overdue` : "Pending",
        }))
    );
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

// Student payment history
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
        fee: student.fee, paid: totalPaid,
        cleared: totalPaid >= student.fee,
        payments: termPayments.map(p => ({
          id: p.id, amount: p.amount, method: p.method || "manual",
          txnRef: p.txnRef || null, feeBreakdown: p.feeBreakdown || [],
          createdAt: p.createdAt,
          time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
        })),
      };
    }).filter(t => t.payments.length > 0 || t.status === "active");

    const hasUnpaidPastTerm  = termSummaries.some(t => t.status === "closed" && !t.cleared && t.paid < t.fee);
    const allTermsCleared    = termSummaries.length > 0 && termSummaries.every(t => t.cleared);

    res.json({
      student: { id: student.id, name: student.name, adm: student.adm, cls: student.cls, parentEmail: student.parentEmail || null, parentName: student.parentName || null, parentPhone: student.parentPhone || null, fee: student.fee, paid: student.paid, daysOverdue: student.daysOverdue },
      termSummaries, hasUnpaidPastTerm, allTermsCleared,
    });
  } catch (e) { console.error("student payments:", e); res.status(500).json({ message: "Something went wrong" }); }
});

// Helper: generate school-specific admission number
// Format: <SchoolInitials>-<StudentInitials>-<Sequence>
// e.g. "Yahya High School" + "Ahmed Farah" + 7th student → YH-AF-007
function generateAdm(schoolName, studentName, totalCount) {
  const schoolInitials = (schoolName || "FF")
    .split(/\s+/)
    .filter(w => /^[A-Za-z]/.test(w))
    .slice(0, 3)
    .map(w => w[0].toUpperCase())
    .join("");
  const nameInitials = (studentName || "ST")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join("");
  const seq = String(totalCount + 1).padStart(3, "0");
  return `${schoolInitials || "FF"}-${nameInitials || "ST"}-${seq}`;
}

app.post("/api/students", requireAuth, async (req, res) => {
  const { name, cls, fee, paid, parentEmail, parentName, parentPhone, feeBreakdown } = req.body;
  if (!name) return res.status(400).json({ message: "Student name is required" });
  if (!parentPhone) return res.status(400).json({ message: "Parent phone is required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const count = await prisma.student.count({ where: { userId: req.userId } });
    const limit = PLAN_LIMITS[user?.plan || "free"].students;
    if (count >= limit) return res.status(403).json({ message: `Student limit reached (${limit}). Upgrade to add more.`, upgradeRequired: true });

    // Auto-generate unique admission number; retry if collision (rare)
    let adm = generateAdm(user?.schoolName, name, count);
    const existing = await prisma.student.findFirst({ where: { userId: req.userId, adm } });
    if (existing) adm = generateAdm(user?.schoolName, name, count + Math.floor(Math.random() * 50) + 1);

    const parsedFee  = parseFloat(fee)  || 0;
    const parsedPaid = parseFloat(paid) || 0;
    const activeTerm = await prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } });
    const daysOverdue = (parsedPaid < parsedFee && activeTerm)
      ? Math.max(0, Math.floor((Date.now() - new Date(activeTerm.startDate).getTime()) / (1000 * 60 * 60 * 24)))
      : 0;

    const student = await prisma.student.create({
      data: { name, adm: adm?.trim() || "", cls: cls || "", fee: parsedFee, paid: parsedPaid, parentEmail: parentEmail || null, parentName: parentName || null, parentPhone: parentPhone || null, daysOverdue, userId: req.userId },
    });

    if (parsedPaid > 0) {
      await prisma.payment.create({ data: { amount: parsedPaid, method: "manual", txnRef: null, feeBreakdown: feeBreakdown || [], studentId: student.id, userId: req.userId } });
    }
    res.status(201).json(student);
  } catch (e) {
    if (e.code === "P2002") return res.status(400).json({ message: "Admission number conflict — please try again" });
    console.error("create student:", e);
    res.status(500).json({ message: "Something went wrong" });
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
      data: { ...(name !== undefined && { name }), ...(cls !== undefined && { cls }), ...(parentEmail !== undefined && { parentEmail }), ...(parentName !== undefined && { parentName }), ...(parentPhone !== undefined && { parentPhone }), ...(fee !== undefined && { fee: newFee }), ...(paid !== undefined && { paid: newPaid }), ...(termId !== undefined && { termId }), daysOverdue },
    });
    res.json(updated);
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.delete("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    await prisma.payment.deleteMany({ where: { studentId: req.params.id } });
    await prisma.student.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Stats ─────────────────────────────────────────────────────────────────────
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const [students, activeTerm] = await Promise.all([
      prisma.student.findMany({ where: { userId: req.userId } }),
      prisma.term.findFirst({ where: { userId: req.userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    ]);

    const updated = recomputeOverdue(students, activeTerm?.startDate);

    const totalFee       = updated.reduce((s, st) => s + st.fee, 0);
    const totalCollected = updated.reduce((s, st) => s + st.paid, 0);
    const totalArrears   = Math.max(0, totalFee - totalCollected);
    const fullyPaid      = updated.filter(s => s.fee > 0 && s.paid >= s.fee).length;
    const partial        = updated.filter(s => s.paid > 0 && s.paid < s.fee).length;
    const unpaid         = updated.filter(s => s.paid === 0).length;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayPayments = await prisma.payment.findMany({ where: { userId: req.userId, createdAt: { gte: today } }, include: { student: true } });
    const collectedToday = todayPayments.reduce((s, p) => s + p.amount, 0);

    const recentRaw = await prisma.payment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 10, include: { student: true } });
    const recentPayments = recentRaw.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${p.student?.cls || ""} · ${p.student?.adm || ""}`,
      txn: p.txnRef || "—", method: p.method || "manual",
      amount: `KES ${Number(p.amount).toLocaleString()}`,
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    }));

    const topUnpaid = updated
      .filter(s => s.paid < s.fee)
      .sort((a, b) => (b.fee - b.paid) - (a.fee - a.paid))
      .slice(0, 5)
      .map((s, i) => ({
        rank: i + 1, name: s.name, cls: s.cls,
        bal: `KES ${(s.fee - s.paid).toLocaleString()}`,
        days: s.daysOverdue > 0 ? `${s.daysOverdue}d overdue` : "Pending",
      }));

    const collectedPct = totalFee > 0 ? Math.round((totalCollected / totalFee) * 100) : 0;
    const arrearsPct   = totalFee > 0 ? Math.round((totalArrears   / totalFee) * 100) : 0;
    const paidPct      = updated.length > 0 ? Math.round((fullyPaid / updated.length) * 100) : 0;
    const problemPct   = updated.length > 0 ? Math.round(((partial + unpaid) / updated.length) * 100) : 0;

    res.json({
      totalCollected, totalArrears, collectedToday, paymentsToday: todayPayments.length,
      totalStudents: updated.length, fullyPaid, partial, unpaid,
      recentPayments, topUnpaid,
      items: [
        { label: "Total Collected", value: `KES ${Number(totalCollected).toLocaleString()}`, sub: `KES ${Number(totalFee).toLocaleString()} expected`, progress: collectedPct, badge: `${collectedPct}% collected`, badgeBg: "var(--green-bg)", badgeColor: "var(--green)", iconBg: "var(--green-bg)", iconBorder: "var(--green-border)", iconColor: "var(--green)", iconPath: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", valueColor: null, progressClass: "" },
        { label: "Outstanding Arrears", value: `KES ${Number(totalArrears).toLocaleString()}`, sub: `${unpaid + partial} students with balances`, progress: arrearsPct, badge: `${unpaid + partial} students`, badgeBg: "var(--red-bg)", badgeColor: "var(--red)", iconBg: "var(--red-bg)", iconBorder: "var(--red-border)", iconColor: "var(--red)", iconPath: "M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z", valueColor: "var(--red)", progressClass: "bad" },
        { label: "Fully Paid", value: fullyPaid, sub: `Out of ${updated.length} students (${paidPct}%)`, progress: paidPct, badge: null, badgeBg: null, badgeColor: null, iconBg: "var(--green-bg)", iconBorder: "var(--green-border)", iconColor: "var(--green)", iconPath: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", valueColor: null, progressClass: "" },
        { label: "Unpaid / Partial", value: unpaid + partial, sub: `${partial} partial · ${unpaid} not started`, progress: problemPct, badge: `${unpaid + partial} students`, badgeBg: "var(--red-bg)", badgeColor: "var(--red)", iconBg: "var(--red-bg)", iconBorder: "var(--red-border)", iconColor: "var(--red)", iconPath: "M10 9H6M10 13H6m10 4H6M20 6H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2z", valueColor: "var(--red)", progressClass: "warn" },
      ],
    });
  } catch (e) { console.error("stats:", e); res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Payments ──────────────────────────────────────────────────────────────────
app.get("/api/payments/recent", requireAuth, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 30, include: { student: true } });
    res.json(payments.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${p.student?.cls || ""} · ${p.student?.adm || ""}`,
      txn: p.txnRef || "—", amount: `KES ${Number(p.amount).toLocaleString()}`, method: p.method,
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    })));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/payments", requireAuth, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, include: { student: true } });
    res.json(payments.map(p => ({
      id: p.id, name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${p.student?.cls || ""} · ${p.student?.adm || ""}`,
      txn: p.txnRef || "—", amount: `KES ${Number(p.amount).toLocaleString()}`,
      method: p.method || "manual", feeBreakdown: p.feeBreakdown || [],
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      createdAt: p.createdAt,
      studentId: p.studentId,
    })));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/payments", requireAuth, async (req, res) => {
  const { studentId, amount, txnRef, method, feeBreakdown } = req.body;
  if (!studentId || !amount) return res.status(400).json({ message: "studentId and amount required" });
  try {
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const payment = await prisma.payment.create({
      data: { amount: parseFloat(amount), txnRef: txnRef || null, method: method || "cash", feeBreakdown: feeBreakdown || [], studentId, userId: req.userId },
      include: { student: true },
    });

    const newPaid = student.paid + parseFloat(amount);
    const daysOverdue = newPaid >= student.fee ? 0 : student.daysOverdue;
    await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) }, daysOverdue } });

    // Auto-send receipt if user is on Max plan
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (PLAN_LIMITS[user?.plan]?.receipts) {
      const updatedStudent = { ...student, paid: newPaid, daysOverdue };
      autoSendReceipt({ payment, student: updatedStudent, user }).catch(console.error);
    }

    res.status(201).json({
      id: payment.id, name: payment.student?.name,
      initials: (payment.student?.name || "??").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${payment.student?.cls || ""} · ${payment.student?.adm || ""}`,
      txn: payment.txnRef || "—", method: payment.method,
      feeBreakdown: payment.feeBreakdown,
      amount: `KES ${Number(payment.amount).toLocaleString()}`,
      time: "Just now", createdAt: payment.createdAt,
      studentId: payment.studentId,
      // Return the updated student so frontend can update the store
      updatedStudent: { id: studentId, paid: newPaid, daysOverdue },
    });
  } catch (e) { console.error("create payment:", e); res.status(500).json({ message: "Something went wrong" }); }
});

app.delete("/api/payments/:id", requireAuth, async (req, res) => {
  try {
    const payment = await prisma.payment.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    await prisma.student.update({ where: { id: payment.studentId }, data: { paid: { decrement: payment.amount } } });
    await prisma.payment.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted", studentId: payment.studentId, amount: payment.amount });
  } catch (e) { console.error("delete payment:", e); res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/payments/unmatched", requireAuth, async (req, res) => {
  try {
    const list = await prisma.unmatchedPayment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(list.map(p => ({ id: p.id, phone: p.phone, txn: p.txnRef || "—", amount: `KES ${Number(p.amount).toLocaleString()}`, rawAmount: p.amount, time: new Date(p.createdAt).toLocaleString("en-KE") })));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
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
  } catch (e) { console.error("assign unmatched:", e); res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/payments/stk", requireAuth, requirePlan("mpesa"), async (req, res) => {
  const { studentId, amount, phone } = req.body;
  if (!studentId || !amount || !phone) return res.status(400).json({ message: "studentId, amount and phone required" });
  const CK = process.env.MPESA_CONSUMER_KEY, CS = process.env.MPESA_CONSUMER_SECRET;
  const SC = process.env.MPESA_SHORTCODE,    PK = process.env.MPESA_PASSKEY, CB = process.env.MPESA_CALLBACK_URL;
  if (!CK || !CS) return res.status(503).json({ message: "M-Pesa not configured on server" });
  try {
    const auth = Buffer.from(`${CK}:${CS}`).toString("base64");
    const { access_token } = await (await fetch("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", { headers: { Authorization: `Basic ${auth}` } })).json();
    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(`${SC}${PK}${ts}`).toString("base64");
    const d  = await (await fetch("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST", headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ BusinessShortCode: SC, Password: pw, Timestamp: ts, TransactionType: "CustomerPayBillOnline", Amount: Math.round(amount), PartyA: phone, PartyB: SC, PhoneNumber: phone, CallBackURL: CB, AccountReference: `FF-${studentId}`, TransactionDesc: "School fee payment" }),
    })).json();
    d.ResponseCode === "0" ? res.json({ success: true, checkoutRequestId: d.CheckoutRequestID }) : res.status(400).json({ message: d.errorMessage || "STK push failed" });
  } catch (e) { console.error("stk:", e); res.status(500).json({ message: "STK push failed" }); }
});

app.post("/api/mpesa/callback/:userId", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb?.ResultCode === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const get = n => items.find(i => i.Name === n)?.Value;
      const amount = get("Amount"), ref = get("MpesaReceiptNumber"), phone = get("PhoneNumber")?.toString();
      const studentId = (cb.AccountReference || "").replace("FF-", "");
      const student   = await prisma.student.findUnique({ where: { id: studentId } });
      if (student) {
        await prisma.payment.create({ data: { amount: parseFloat(amount), txnRef: ref, method: "mpesa", feeBreakdown: [], studentId, userId: student.userId } });
        const newPaid = student.paid + parseFloat(amount);
        await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) }, daysOverdue: newPaid >= student.fee ? 0 : student.daysOverdue } });
      } else {
        const user = await prisma.user.findFirst();
        if (user) await prisma.unmatchedPayment.create({ data: { phone, txnRef: ref, amount: parseFloat(amount), userId: user.id } });
      }
    }
  } catch (e) { console.error("mpesa callback:", e); }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ═══════════════════════════════════════════════════════════════════
// INVOICES & RECEIPTS
// ═══════════════════════════════════════════════════════════════════

// ─── Helper: format phone for Africa's Talking ────────────────────────────────
function formatPhoneAT(phone) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("254")) return "+" + clean;
  if (clean.startsWith("0"))   return "+254" + clean.slice(1);
  if (clean.startsWith("7") || clean.startsWith("1")) return "+254" + clean;
  return "+" + clean;
}

// ─── Message Builders ─────────────────────────────────────────────────────────────
function buildInvoiceMessage({ schoolName, studentName, className, admNo, totalFee, dueDate, termName, note, feeBreakdown }) {
  const BACKEND = process.env.BACKEND_URL || "https://asayfeeflow.onrender.com";
  const token = genToken();
  const link = `${BACKEND}/i/${token}`;
  const dueFmt = new Date(dueDate).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
  
  let message = `FeeFlow | ${schoolName}: Fee invoice for ${studentName} (${className}${admNo ? ", Adm: " + admNo : ""}). Due: ${dueFmt}. Amount: KES ${Number(totalFee).toLocaleString()}.`;
  if (termName) message += ` Term: ${termName}.`;
  if (note) message += ` Note: ${note}.`;
  message += ` View invoice: ${link}`;
  
  return message;
}

function buildReceiptMessage({ schoolName, studentName, className, amount, method, receiptId, txnRef }) {
  const BACKEND = process.env.BACKEND_URL || "https://asayfeeflow.onrender.com";
  const token = genToken();
  const link = `${BACKEND}/r/${token}`;
  const methodFmt = method === "mpesa" ? "M-Pesa" : method === "bank" ? "Bank Transfer" : "Cash";
  
  let message = `FeeFlow | ${schoolName}: Payment receipt for ${studentName} (${className}). Amount: KES ${Number(amount).toLocaleString()} via ${methodFmt}.`;
  if (txnRef) message += ` Ref: ${txnRef}.`;
  message += ` Download receipt: ${link}`;
  
  return message;
}

// ─── Helper: send SMS via Africa's Talking ──────────────────────────────────────
async function sendSMS(to, message, user) {
  // Use centralized Africa's Talking credentials instead of per-user
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME || "sandbox";
  const senderId = process.env.AT_SENDER_ID || "FEEFLOW";
  
  if (!apiKey) throw new Error("SMS not configured. Contact administrator to set up Africa's Talking credentials.");
  const phone = formatPhoneAT(to);
  if (!phone) throw new Error("Invalid phone number");
  const body = new URLSearchParams({ username, to: phone, message, from: senderId });
  const res = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const data = await res.json();
  if (data.SMSMessageData?.Recipients?.[0]?.status !== "Success") {
    throw new Error("SMS failed: " + JSON.stringify(data));
  }
  return data;
}

// ─── Helper: generate short unique token ─────────────────────────────────────
function genToken() { return crypto.randomBytes(8).toString("hex"); }

// ─── Helper: send email via Resend ─────────────────────────────────────────────
async function sendEmail(to, subject, htmlBody, user) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return; // silently skip if not configured or no email
  // Resend's test sender (onboarding@resend.dev) can only deliver to the
  // registered Resend account email. In non-production, override the recipient.
  const recipient = process.env.NODE_ENV === "production"
    ? to
    : (process.env.RESEND_TEST_EMAIL || to);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "FeeFlow <onboarding@resend.dev>", to: recipient, subject, html: htmlBody }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => String(res.status));
    throw new Error("Email send failed: " + errBody);
  }
  return res.json();
}

// ─── Public Invoice & Receipt pages — served as HTML directly from Express ────
// Parent clicks SMS link → Express serves a complete HTML page → Download button

function fmtKE(n) { return Number(n || 0).toLocaleString("en-KE"); }
function fmtDateKE(d) { return d ? new Date(d).toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" }) : "—"; }
function fmtDatetimeKE(d) { return d ? new Date(d).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }

app.get("/i/:token", async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { token: req.params.token },
      include: { student: true, user: { select: { schoolName: true } } },
    });
    if (!invoice) return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8"><div style="text-align:center;color:#c00"><div style="font-size:48px">❌</div><h2>Invoice not found</h2><p style="color:#666">This link may be invalid or expired.</p></div></body></html>`);

    const st      = invoice.student;
    const school  = invoice.user.schoolName || "School";
    const balance = Math.max(0, st.fee - st.paid);
    const fb      = Array.isArray(invoice.feeBreakdown) && invoice.feeBreakdown.length > 0
                      ? invoice.feeBreakdown
                      : [{ typeName: "Tuition Fee", amount: st.fee }];

    const feeRows = fb.map(f => `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:10px 12px">${f.typeName || f.name || "Fee"}</td>
        <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums">${fmtKE(f.amount)}</td>
      </tr>`).join("");

    const paidRow = st.paid > 0 ? `
      <tr style="color:#27ae60">
        <td style="padding:8px 12px;font-weight:600">Amount Paid</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600">KES ${fmtKE(st.paid)}</td>
      </tr>
      <tr style="background:${balance > 0 ? "#fff5f5" : "#f0fdf4"}">
        <td style="padding:9px 12px;font-weight:700;color:${balance > 0 ? "#c00" : "#16a34a"}">Balance Remaining</td>
        <td style="padding:9px 12px;text-align:right;font-weight:700;color:${balance > 0 ? "#c00" : "#16a34a"}">KES ${fmtKE(balance)}</td>
      </tr>` : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Fee Invoice — ${st.name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}
    .wrap{max-width:600px;margin:0 auto}
    .brand{text-align:center;margin-bottom:20px}
    .brand .name{font-size:13px;font-weight:700;color:#059669;letter-spacing:1px}
    .brand .sub{font-size:12px;color:#888;margin-top:2px}
    .card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);overflow:hidden}
    .hdr{background:#003366;color:#fff;padding:24px 28px;display:flex;justify-content:space-between;align-items:flex-start}
    .hdr h1{font-size:20px;font-weight:700;margin-bottom:4px}
    .hdr .sub{font-size:11px;opacity:.75;letter-spacing:1px;text-transform:uppercase}
    .hdr .badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);padding:4px 12px;border-radius:20px;font-size:11px;margin-top:8px}
    .body{padding:28px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
    .box{background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px}
    .box .lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
    .box .val{font-size:15px;font-weight:700;color:#003366}
    .box .inf{font-size:12px;color:#555;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px}
    thead tr{background:#003366;color:#fff}
    thead th{padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.5px;font-weight:600}
    .total-row td{background:#e8f0fe;font-weight:700;font-size:14px;color:#003366;border-top:2px solid #003366;padding:11px 12px}
    .btn{display:block;width:100%;padding:14px;border-radius:10px;background:#003366;border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;letter-spacing:.3px;margin-top:4px;text-align:center}
    .note{background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;color:#555;margin-bottom:20px}
    .footer{margin-top:18px;font-size:11px;color:#aaa;text-align:center;line-height:1.8}
    @media(max-width:480px){.grid{grid-template-columns:1fr}.hdr{flex-direction:column;gap:12px}}
    @media print{body{background:#fff;padding:20px}.btn{display:none}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><div class="name">FEEFLOW</div><div class="sub">Fee Management Platform</div></div>
    <div class="card">
      <div class="hdr">
        <div>
          <h1>${school}</h1>
          <div class="sub">Official Fee Invoice</div>
          <div class="badge">PAYMENT DUE</div>
        </div>
        <div style="text-align:right;font-size:12px">
          <div style="opacity:.75">Invoice No.</div>
          <div style="font-size:15px;font-weight:700">${invoice.invoiceNo}</div>
          <div style="opacity:.75;margin-top:6px">Issued</div>
          <div>${fmtDateKE(invoice.createdAt)}</div>
        </div>
      </div>
      <div class="body">
        <div class="grid">
          <div class="box">
            <div class="lbl">Billed To</div>
            <div class="val">${st.name}</div>
            <div class="inf">${st.cls}${st.adm ? " · Adm: " + st.adm : ""}</div>
            ${st.parentName  ? `<div class="inf">Parent: ${st.parentName}</div>` : ""}
            ${st.parentPhone ? `<div class="inf">📱 ${st.parentPhone}</div>` : ""}
          </div>
          <div class="box">
            <div class="lbl">Payment Due</div>
            <div class="val" style="color:#c00">${fmtDateKE(invoice.dueDate)}</div>
            ${invoice.termName ? `<div class="inf">Term: ${invoice.termName}</div>` : ""}
          </div>
        </div>
        <table>
          <thead><tr><th>Description</th><th style="text-align:right">Amount (KES)</th></tr></thead>
          <tbody>${feeRows}</tbody>
          <tfoot>
            <tr class="total-row"><td>Total Due</td><td style="text-align:right;font-variant-numeric:tabular-nums">KES ${fmtKE(st.fee)}</td></tr>
            ${paidRow}
          </tfoot>
        </table>
        ${invoice.note ? `<div class="note"><strong>Note:</strong> ${invoice.note}</div>` : ""}
        <button class="btn" onclick="window.print()">⬇ Download / Print Invoice PDF</button>
        <div class="footer">
          Please ensure payment is made before the due date.<br>
          For inquiries, contact ${school} administration.<br>
          <em>Powered by FeeFlow · Fee Management Platform</em>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("invoice page:", e); res.status(500).send("Server error"); }
});

app.get("/r/:token", async (req, res) => {
  try {
    const receipt = await prisma.receipt.findUnique({
      where: { token: req.params.token },
      include: { student: true, user: { select: { schoolName: true } } },
    });
    if (!receipt) return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8"><div style="text-align:center;color:#c00"><div style="font-size:48px">❌</div><h2>Receipt not found</h2><p style="color:#666">This link may be invalid.</p></div></body></html>`);

    const st      = receipt.student;
    const school  = receipt.user.schoolName || "School";
    const balance = Math.max(0, st.fee - st.paid);
    const METHOD  = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash", manual: "Cash" };
    const method  = METHOD[receipt.method] || receipt.method;

    const detailRows = [
      ["Student",        st.name],
      st.adm            ? ["Adm. No.",        st.adm]                  : null,
      ["Class",          st.cls],
      receipt.termName  ? ["Term",             receipt.termName]        : null,
      ["Payment Method", method],
      receipt.txnRef    ? ["Transaction Ref",  receipt.txnRef]          : null,
      ["Date & Time",    fmtDatetimeKE(receipt.paidAt)],
    ].filter(Boolean).map(([k, v]) => `
      <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f0f0;font-size:13px">
        <span style="color:#666">${k}</span>
        <span style="font-weight:600;text-align:right;max-width:60%;${k === "Transaction Ref" ? "font-family:monospace" : ""}">${v}</span>
      </div>`).join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payment Receipt — ${st.name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}
    .wrap{max-width:480px;margin:0 auto}
    .brand{text-align:center;margin-bottom:20px}
    .brand .name{font-size:13px;font-weight:700;color:#059669;letter-spacing:1px}
    .brand .sub{font-size:12px;color:#888;margin-top:2px}
    .card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);overflow:hidden}
    .hdr{background:#059669;color:#fff;padding:22px 24px;text-align:center}
    .hdr h1{font-size:16px;font-weight:700;letter-spacing:1px}
    .hdr .sub{font-size:11px;opacity:.8;margin-top:3px;letter-spacing:1px;text-transform:uppercase}
    .body{padding:24px}
    .rec-no{text-align:center;font-size:12px;color:#888;margin-bottom:18px}
    .amount-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px}
    .amount-box .lbl{font-size:11px;color:#16a34a;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
    .amount-box .val{font-size:30px;font-weight:800;color:#16a34a;font-variant-numeric:tabular-nums}
    .btn{display:block;width:100%;padding:14px;border-radius:10px;background:#059669;border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;letter-spacing:.3px;margin-top:18px;text-align:center}
    .footer{margin-top:16px;font-size:11px;color:#aaa;text-align:center;line-height:1.8}
    @media print{body{background:#fff;padding:20px}.btn{display:none}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><div class="name">FEEFLOW</div><div class="sub">Fee Management Platform</div></div>
    <div class="card">
      <div class="hdr">
        <h1>${school}</h1>
        <div class="sub">Official Payment Receipt</div>
      </div>
      <div class="body">
        <div class="rec-no">Receipt No: <strong style="color:#333;font-family:monospace">${receipt.receiptNo}</strong></div>
        <div class="amount-box">
          <div class="lbl">Amount Received</div>
          <div class="val">KES ${fmtKE(receipt.amount)}</div>
        </div>
        ${detailRows}
        <div style="margin-top:14px;padding:11px 14px;border-radius:9px;background:${balance > 0 ? "#fff5f5" : "#f0fdf4"};border:1px solid ${balance > 0 ? "#fecaca" : "#bbf7d0"};display:flex;justify-content:space-between;font-weight:700;font-size:13px">
          <span style="color:${balance > 0 ? "#c00" : "#16a34a"}">Outstanding Balance</span>
          <span style="color:${balance > 0 ? "#c00" : "#16a34a"}">${balance > 0 ? "KES " + fmtKE(balance) : "Cleared ✓"}</span>
        </div>
        <button class="btn" onclick="window.print()">⬇ Download / Print Receipt PDF</button>
        <div class="footer">
          Thank you for your payment · ${school}<br>
          <em>Powered by FeeFlow · Fee Management Platform</em>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (e) { console.error("receipt page:", e); res.status(500).send("Server error"); }
});


// GET /api/invoices
app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(invoices);
  } catch (e) { res.status(500).json({ message: "Failed to fetch invoices" }); }
});

// POST /api/invoices/:id/resend
app.post("/api/invoices/:id/resend", requireAuth, requirePlan("invoices"), async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    const student = await prisma.student.findUnique({ where: { id: invoice.studentId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const message = buildInvoiceMessage({
      schoolName:   user.schoolName || "School",
      studentName:  student.name,
      className:    student.cls,
      admNo:        student.adm,
      totalFee:     invoice.totalFee,
      dueDate:      invoice.dueDate,
      termName:     invoice.termName,
      note:         invoice.note,
      feeBreakdown: invoice.feeBreakdown || [],
    });

    let allOk = true;
    const channels = invoice.channels || [];
    if (student.parentPhone) {
      try { await sendSMS(student.parentPhone, message, user); } catch { allOk = false; }
    }
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk });
  } catch (e) { res.status(500).json({ message: "Resend failed" }); }
});

// ─── Receipt Routes ─────────────────────────────────────────────────────────────

// GET /api/receipts
app.get("/api/receipts", requireAuth, async (req, res) => {
  try {
    const receipts = await prisma.receipt.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(receipts);
  } catch (e) { res.status(500).json({ message: "Failed to fetch receipts" }); }
});

// POST /api/receipts/manual
app.post("/api/receipts/manual", requireAuth, async (req, res) => {
  const { paymentId, studentId, channels } = req.body;
  if (!paymentId) return res.status(400).json({ message: "Payment ID required" });

  try {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, userId: req.userId } });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    const student = await prisma.student.findUnique({ where: { id: studentId || payment.studentId } });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const receipt = await prisma.receipt.create({
      data: {
        userId:      req.userId,
        paymentId:   payment.id,
        studentId:   student.id,
        studentName: student.name,
        admNo:       student.adm,
        className:   student.cls,
        amount:      payment.amount,
        method:      payment.method,
        txnRef:      payment.txnRef || null,
        paidAt:      payment.createdAt,
        channels:    channels || ["sms"],
        type:        "manual",
        balance:     Math.max(0, student.fee - student.paid),
        status:      "pending",
      },
    });

    const message = buildReceiptMessage({
      schoolName:  user.schoolName || "School",
      studentName: student.name,
      className:   student.cls,
      amount:      payment.amount,
      method:      payment.method,
      receiptId:   receipt.id,
      txnRef:      payment.txnRef,
    });

    const selectedChannels = Array.isArray(channels) ? channels : [channels].filter(Boolean);
    let allOk = true;
    if (student.parentPhone) {
      try { await sendSMS(student.parentPhone, message, user); }
      catch (e) { console.error("Receipt SMS send failed:", e.message); allOk = false; }
    }
    if (selectedChannels.includes("email") && (student.parentEmail || student.email)) {
      try { await sendEmail(student.parentEmail || student.email, `Payment Receipt — ${student.name}`, `<pre style="font-family:sans-serif;white-space:pre-wrap">${message}</pre>`); }
      catch (e) { console.error("Receipt email send failed:", e.message); allOk = false; }
    }

    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk, receipt });
  } catch (e) {
    console.error("Manual receipt error:", e);
    res.status(500).json({ message: "Failed to send receipt" });
  }
});

// POST /api/receipts/:id/resend
app.post("/api/receipts/:id/resend", requireAuth, async (req, res) => {
  try {
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    const student = await prisma.student.findUnique({ where: { id: receipt.studentId } });
    const user    = await prisma.user.findUnique({ where: { id: req.userId } });

    const message = buildReceiptMessage({
      schoolName:  user.schoolName || "School",
      studentName: student.name,
      className:   student.cls,
      amount:      receipt.amount,
      method:      receipt.method,
      receiptId:   receipt.id,
      txnRef:      receipt.txnRef,
    });

    let allOk = true;
    if (student.parentPhone) {
      try { await sendSMS(student.parentPhone, message, user); } catch { allOk = false; }
    }
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
    res.json({ ok: allOk });
  } catch (e) { res.status(500).json({ message: "Resend failed" }); }
});

// ─── Auto-receipt helper (called after POST /api/payments for Max plan) ─────────
async function autoSendReceipt({ payment, student, user }) {
  try {
    const receipt = await prisma.receipt.create({
      data: {
        userId:      user.id,
        paymentId:   payment.id,
        studentId:   student.id,
        studentName: student.name,
        admNo:       student.adm,
        className:   student.cls,
        amount:      payment.amount,
        method:      payment.method,
        txnRef:      payment.txnRef || null,
        paidAt:      payment.createdAt,
        channels:    ["sms", "email"],
        type:        "auto",
        balance:     Math.max(0, student.fee - student.paid),
        status:      "pending",
      },
    });

    const message = buildReceiptMessage({
      schoolName:  user.schoolName || "School",
      studentName: student.name,
      className:   student.cls,
      amount:      payment.amount,
      method:      payment.method,
      receiptId:   receipt.id,
      txnRef:      payment.txnRef,
    });

    let allOk = true;
    if (student.parentPhone) {
      try { await sendSMS(student.parentPhone, message, user); }
      catch (e) { console.error("Auto-receipt SMS failed:", e.message); allOk = false; }
    }
    if (student.parentEmail || student.email) {
      try { await sendEmail(student.parentEmail || student.email, `Payment Receipt — ${student.name}`, `<pre style="font-family:sans-serif;white-space:pre-wrap">${message}</pre>`); }
      catch (e) { console.error("Auto-receipt email failed:", e.message); allOk = false; }
    }

    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
  } catch (e) {
    console.error("Auto-receipt failed:", e.message);
  }
}

// ─── Scheduled invoice processor (runs every 60 seconds) ───────────────────────
setInterval(async () => {
  try {
    const due = await prisma.invoice.findMany({
      where: {
        status: "scheduled",
        scheduledFor: { lte: new Date() },
      },
    });
    for (const invoice of due) {
      const student = await prisma.student.findUnique({ where: { id: invoice.studentId } });
      const user    = await prisma.user.findUnique({ where: { id: invoice.userId } });
      if (!student || !user) continue;

      const message = buildInvoiceMessage({
        schoolName:   user.schoolName || "School",
        studentName:  student.name,
        className:    student.cls,
        admNo:        student.adm,
        totalFee:     invoice.totalFee,
        dueDate:      invoice.dueDate,
        termName:     invoice.termName,
        note:         invoice.note,
        feeBreakdown: invoice.feeBreakdown || [],
      });

      let allOk = true;
      const channels = invoice.channels || [];
      if (student.parentPhone) {
        try { await sendSMS(student.parentPhone, message, user); } catch { allOk = false; }
      }
      if (channels.includes("email") && (student.parentEmail || student.email)) {
        try { await sendEmail(student.parentEmail || student.email, `Fee Invoice — ${student.name}`, `<pre>${message}</pre>`); }
        catch { allOk = false; }
      }

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: allOk ? "sent" : "failed", sentAt: new Date() },
      });
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
}, 60 * 1000);

// ─── Health & fallbacks ────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, version: "2.4", env: process.env.NODE_ENV }));
app.post("/api/invoices", requireAuth, requirePlan("invoices"), async (req, res) => {
  const { studentIds, dueDate, termName, note, feeBreakdown, sendDate, channels } = req.body;
  if (!studentIds?.length) return res.status(400).json({ message: "Select at least one student" });
  if (!dueDate)            return res.status(400).json({ message: "Due date is required" });
  try {
    const user     = await prisma.user.findUnique({ where: { id: req.userId } });
    const students = await prisma.student.findMany({ where: { id: { in: studentIds }, userId: req.userId } });
    const BACKEND  = process.env.BACKEND_URL  || "https://asayfeeflow.onrender.com";
    const results  = [];
    let   sentOk = 0, smsFail = 0;

    for (const student of students) {
      const token     = genToken();
      const invoiceNo = await nextInvoiceNo(req.userId);
      const invoice   = await prisma.invoice.create({
        data: {
          invoiceNo, token, studentId: student.id, userId: req.userId,
          dueDate: new Date(dueDate), termName: termName || null,
          feeBreakdown: feeBreakdown || [], note: note || null,
          channels: channels || ["sms"], status: sendDate ? "scheduled" : "sent",
          scheduledFor: sendDate ? new Date(sendDate) : null,
          sentAt: sendDate ? null : new Date(),
        },
      });
      results.push(invoice);

      if (!sendDate && student.parentPhone) {
        const link    = `${BACKEND}/i/${token}`;
        const balance = Math.max(0, student.fee - student.paid);
        const dueFmt  = new Date(dueDate).toLocaleDateString("en-KE", { day:"numeric", month:"short", year:"numeric" });
        const message = `FeeFlow | ${user.schoolName || "School"}: Fee invoice for ${student.name} (${student.cls}). Due: ${dueFmt}. Balance: KES ${balance.toLocaleString()}. View invoice: ${link}`;
        try {
          await sendSMS(student.parentPhone, message, user);
          sentOk++;
        } catch (e) { console.error("Invoice SMS:", student.name, e.message); smsFail++; }
      }

      // Email if channel includes "email" and parent has email
      const selectedChannels = Array.isArray(channels) ? channels : [channels].filter(Boolean);
      if (!sendDate && selectedChannels.includes("email") && (student.parentEmail || student.email) && process.env.RESEND_API_KEY) {
        const link = `${BACKEND}/i/${token}`;
        try {
          await sendEmail(student.parentEmail || student.email, `Fee Invoice — ${student.name} | ${termName || ""}`,
            `<p>Dear Parent/Guardian,</p><p>Please find your fee invoice for <strong>${student.name}</strong>.</p><p><a href="${link}" style="background:#003366;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">View &amp; Download Invoice →</a></p><p style="color:#888;font-size:12px;margin-top:20px">Sent by ${user.schoolName || "School"} via FeeFlow</p>`,
            user
          );
        } catch (e) { console.error("Invoice email:", e.message); }
      }
    }
    res.json({ invoices: results, sent: sentOk, failed: smsFail, scheduled: !!sendDate });
  } catch (e) { console.error("create invoices:", e); res.status(500).json({ message: "Something went wrong" }); }
});


// ─── Health & fallbacks ────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ message: "Internal server error" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`FeeFlow API → http://0.0.0.0:${PORT}  [${process.env.NODE_ENV || "development"}]`));

export default app;