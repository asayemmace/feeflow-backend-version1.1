import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

dotenv.config();
const app = express();
const prisma = new PrismaClient();

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://feeflowfrontendversion11wjpj.vercel.app"
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options('*', cors());
app.use(express.json());
app.use(express.json());

// ─── Auth middleware ───────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ─── Register ─────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, schoolName } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: "Name, email and password are required" });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, schoolName }
    });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, schoolName: user.schoolName }
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, schoolName: user.schoolName }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── KPI stats (protected) ────────────────────────────────────────────────────
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({ where: { userId: req.userId } });

    const totalFee       = students.reduce((s, st) => s + st.fee, 0);
    const totalCollected = students.reduce((s, st) => s + st.paid, 0);
    const totalArrears   = totalFee - totalCollected;
    const fullyPaid      = students.filter(s => s.paid >= s.fee).length;
    const partial        = students.filter(s => s.paid > 0 && s.paid < s.fee).length;
    const unpaid         = students.filter(s => s.paid === 0).length;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayPayments = await prisma.payment.findMany({
      where: { userId: req.userId, createdAt: { gte: today } }
    });
    const collectedToday = todayPayments.reduce((s, p) => s + p.amount, 0);

    res.json({
      totalCollected,
      totalArrears,
      collectedToday,
      paymentsToday: todayPayments.length,
      totalStudents: students.length,
      fullyPaid,
      partial,
      unpaid,
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Recent payments (protected) ──────────────────────────────────────────────
app.get("/api/payments/recent", requireAuth, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { student: true }
    });

    const result = payments.map(p => ({
      name:     p.student?.name || "Unknown",
      initials: p.student?.name?.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() || "??",
      meta:     `${p.student?.cls || ""} · ${p.student?.adm || ""}`,
      txn:      p.txnRef || "—",
      amount:   `KES ${p.amount.toLocaleString()}`,
      createdAt: p.createdAt,
    }));

    res.json(result);
  } catch (error) {
    console.error("Recent payments error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Top unpaid students (protected) ─────────────────────────────────────────
app.get("/api/students/unpaid", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: {
        userId: req.userId,
        paid: { lt: prisma.student.fields.fee }   // raw compare not valid — fix below
      },
      orderBy: { paid: "asc" },
      take: 5,
    });

    // Filter in JS since Prisma can't compare two columns directly
    const unpaid = await prisma.student.findMany({
      where: { userId: req.userId },
      orderBy: { paid: "asc" },
    });

    const result = unpaid
      .filter(s => s.paid < s.fee)
      .slice(0, 5)
      .map((s, i) => ({
        rank:  i + 1,
        name:  s.name,
        cls:   s.cls,
        bal:   `KES ${(s.fee - s.paid).toLocaleString()}`,
        days:  s.daysOverdue > 0 ? `${s.daysOverdue} days overdue` : "Pending",
      }));

    res.json(result);
  } catch (error) {
    console.error("Unpaid students error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── GET all students (protected) ─────────────────────────────────────────────
app.get("/api/students", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(students);
  } catch (error) {
    console.error("Get students error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── POST create student (protected) ──────────────────────────────────────────
app.post("/api/students", requireAuth, async (req, res) => {
  const { name, cls, fee, paid, phone, adm } = req.body;

  if (!name || !cls || fee == null) {
    return res.status(400).json({ message: "Name, class and fee are required" });
  }

  try {
    // adm must be unique — generate one if not provided
    const admNo = adm?.trim() || `ADM-${Date.now()}`;

    const existing = await prisma.student.findUnique({ where: { adm: admNo } });
    if (existing) {
      return res.status(400).json({ message: "Admission number already exists" });
    }

    const student = await prisma.student.create({
      data: {
        name:   name.trim(),
        cls,
        fee:    parseFloat(fee),
        paid:   parseFloat(paid) || 0,
        adm:    admNo,
        userId: req.userId,
      },
    });
    res.status(201).json(student);
  } catch (error) {
    console.error("Create student error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASTE THESE ROUTES INTO server.js BEFORE the health check route
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET all terms for user ────────────────────────────────────────────────────
app.get("/api/terms", requireAuth, async (req, res) => {
  try {
    const terms = await prisma.term.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(terms);
  } catch (error) {
    console.error("Get terms error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── POST create a new term (closes any active term first) ────────────────────
app.post("/api/terms", requireAuth, async (req, res) => {
  const { name, startDate, endDate } = req.body;
  if (!name || !startDate || !endDate) {
    return res.status(400).json({ message: "name, startDate and endDate are required" });
  }
  try {
    // Close any currently active term
    await prisma.term.updateMany({
      where: { userId: req.userId, status: "active" },
      data: { status: "closed" },
    });

    const term = await prisma.term.create({
      data: {
        name,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        status: "active",
        userId: req.userId,
      },
    });
    res.status(201).json(term);
  } catch (error) {
    console.error("Create term error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── GET term export (PDF or Excel) ───────────────────────────────────────────
// NOTE: This is a stub — wire up your PDF/Excel generation library here.
// For Excel you can use 'xlsx' npm package; for PDF use 'pdfkit' or Gotenberg.
app.get("/api/terms/:id/export", requireAuth, async (req, res) => {
  const { format } = req.query; // "pdf" | "excel"
  try {
    const term = await prisma.term.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!term) return res.status(404).json({ message: "Term not found" });

    const students = await prisma.student.findMany({ where: { userId: req.userId } });
    const payments = await prisma.payment.findMany({
      where: { userId: req.userId },
      include: { student: true },
    });

    if (format === "excel") {
      // Install: npm install xlsx
      const XLSX = await import("xlsx");
      const rows = students.map((s) => ({
        Name: s.name,
        "Adm No": s.adm,
        Class: s.cls,
        "Term Fee": s.fee,
        Paid: s.paid,
        Balance: s.fee - s.paid,
        Status: s.paid >= s.fee ? "Paid" : s.paid > 0 ? "Partial" : "Overdue",
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Students");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Disposition", `attachment; filename="${term.name}.xlsx"`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return res.send(buf);
    }

    // PDF stub — replace with Gotenberg or pdfkit
    res.status(501).json({ message: "PDF export not yet implemented. Wire up Gotenberg here." });
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ message: "Export failed" });
  }
});

// ─── POST record a payment ─────────────────────────────────────────────────────
app.post("/api/payments", requireAuth, async (req, res) => {
  const { studentId, amount, txnRef, method } = req.body;
  if (!studentId || !amount) {
    return res.status(400).json({ message: "studentId and amount are required" });
  }
  try {
    const student = await prisma.student.findFirst({
      where: { id: studentId, userId: req.userId },
    });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const payment = await prisma.payment.create({
      data: {
        amount: parseFloat(amount),
        txnRef: txnRef || null,
        studentId,
        userId: req.userId,
      },
      include: { student: true },
    });

    // Update student's paid amount
    await prisma.student.update({
      where: { id: studentId },
      data: { paid: { increment: parseFloat(amount) } },
    });

    res.status(201).json(payment);
  } catch (error) {
    console.error("Record payment error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── GET unmatched payments ────────────────────────────────────────────────────
// These are M-Pesa callbacks that could not be matched to a student.
// Store them in an UnmatchedPayment table or return empty array for now.
app.get("/api/payments/unmatched", requireAuth, async (req, res) => {
  try {
    // If you add an UnmatchedPayment model later, query it here.
    // For now returns empty array so the UI renders cleanly.
    res.json([]);
  } catch (error) {
    console.error("Unmatched payments error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── POST STK Push ─────────────────────────────────────────────────────────────
// Triggers M-Pesa STK push via Daraja API.
// Replace the stub below with your real Daraja Consumer Key / Secret.
app.post("/api/payments/stk", requireAuth, async (req, res) => {
  const { studentId, amount, phone } = req.body;
  if (!studentId || !amount || !phone) {
    return res.status(400).json({ message: "studentId, amount and phone are required" });
  }

  const CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY;
  const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
  const SHORTCODE       = process.env.MPESA_SHORTCODE;
  const PASSKEY         = process.env.MPESA_PASSKEY;
  const CALLBACK_URL    = process.env.MPESA_CALLBACK_URL;

  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    return res.status(503).json({ message: "M-Pesa not configured. Add MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET to .env" });
  }

  try {
    // 1. Get access token
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    const tokenRes = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const { access_token } = await tokenRes.json();

    // 2. Build STK push request
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const password  = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");

    const stkRes = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: Math.round(amount),
          PartyA: phone,
          PartyB: SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: CALLBACK_URL,
          AccountReference: `Student-${studentId}`,
          TransactionDesc: "School fee payment",
        }),
      }
    );
    const stkData = await stkRes.json();

    if (stkData.ResponseCode === "0") {
      res.json({ success: true, checkoutRequestId: stkData.CheckoutRequestID });
    } else {
      res.status(400).json({ message: stkData.errorMessage || "STK push failed" });
    }
  } catch (error) {
    console.error("STK push error:", error);
    res.status(500).json({ message: "STK push failed. Check your Daraja credentials." });
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
// ✅ After
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
  })
}

export default app