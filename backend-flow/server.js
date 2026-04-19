import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const app    = express();
const prisma = new PrismaClient();

// ─── CORS ──────────────────────────────────────────────────────────────────────
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

// ─── Plan limits ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free: { students: 300, mpesa: false, invoices: false, receipts: false },
  pro:  { students: 800, mpesa: true,  invoices: true,  receipts: false },
  max:  { students: Infinity, mpesa: true, invoices: true, receipts: true },
};

// ─── Auth middleware ───────────────────────────────────────────────────────────
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
        upgradeRequired: true,
        feature,
      });
    }
    req.user = user;
    next();
  } catch {
    res.status(500).json({ message: "Something went wrong" });
  }
};

// ─── Helper ────────────────────────────────────────────────────────────────────
function pick(u) {
  return {
    id: u.id, name: u.name, email: u.email,
    phone: u.phone, schoolName: u.schoolName,
    plan: u.plan, planExpiry: u.planExpiry,
  };
}

// ─── Register ─────────────────────────────────────────────────────────────────
// Automatically assigns "free" plan to all new users.
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, schoolName } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "Name, email and password are required" });
  try {
    if (await prisma.user.findUnique({ where: { email } }))
      return res.status(400).json({ message: "Email already registered" });
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: await bcrypt.hash(password, 10),
        schoolName,
        plan: "free", // always start on free — no override possible from client
      },
    });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: pick(user) });
  } catch (e) {
    console.error("register:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
// FIX: was a duplicate of /register — now correctly handles login.
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password are required" });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: "Invalid email or password" });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: pick(user) });
  } catch (e) {
    console.error("login:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Profile ──────────────────────────────────────────────────────────────────
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
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(name && { name }),
        ...(phone !== undefined && { phone }),
        ...(schoolName !== undefined && { schoolName }),
      },
    });
    res.json(pick(user));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/email", requireAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and current password required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: "Current password is incorrect" });
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
    if (!(await bcrypt.compare(currentPassword, user.password)))
      return res.status(401).json({ message: "Current password is incorrect" });
    await prisma.user.update({ where: { id: req.userId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    res.json({ message: "Password updated" });
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Terms ────────────────────────────────────────────────────────────────────
app.post("/api/terms", requireAuth, async (req, res) => {
  const { name, startDate, endDate } = req.body;
  if (!name || !startDate || !endDate)
    return res.status(400).json({ message: "name, startDate and endDate required" });
  try {
    // close any existing active term
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
  } catch (e) {
    console.error("create term:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

app.get("/api/terms", requireAuth, async (req, res) => {
  try {
    const terms = await prisma.term.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(terms);
  } catch {
    res.status(500).json({ message: "Something went wrong" });
  }
});
// ─── Students ─────────────────────────────────────────────────────────────────
app.get("/api/students", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(students);
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/students/unpaid", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({ where: { userId: req.userId } });
    res.json(
      students
        .filter((s) => s.paid < s.fee)
        .sort((a, b) => (b.fee - b.paid) - (a.fee - a.paid))
        .slice(0, 5)
        .map((s, i) => ({
          rank: i + 1,
          name: s.name,
          cls: s.cls,
          bal: `KES ${(s.fee - s.paid).toLocaleString()}`,
          days: s.daysOverdue > 0 ? `${s.daysOverdue} days overdue` : "Pending",
        }))
    );
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/students", requireAuth, async (req, res) => {
  const { name, adm, cls, fee, paid } = req.body;
  if (!name || !adm) return res.status(400).json({ message: "Name and admission number required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const count = await prisma.student.count({ where: { userId: req.userId } });
    const limit = PLAN_LIMITS[user?.plan || "free"].students;
    if (count >= limit)
      return res.status(403).json({ message: `Student limit reached for your plan (${limit}). Upgrade to add more.`, upgradeRequired: true });

    const parsedFee  = parseFloat(fee)  || 0;
    const parsedPaid = parseFloat(paid) || 0;

    const student = await prisma.student.create({
      data: {
        name,
        adm,
        cls: cls || "",
        fee: parsedFee,
        paid: parsedPaid,
        userId: req.userId,
      },
    });

    // if they paid something upfront, create a payment record too
    if (parsedPaid > 0) {
      await prisma.payment.create({
        data: {
          amount: parsedPaid,
          method: "manual",
          txnRef: null,
          feeBreakdown: [],
          studentId: student.id,
          userId: req.userId,
        },
      });
    }

    res.status(201).json(student);
  } catch (e) {
    if (e.code === "P2002") return res.status(400).json({ message: "Admission number already exists" });
    console.error("create student:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

app.patch("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    const { name, cls, phone, fee, paid, termId } = req.body;
    const updated = await prisma.student.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(cls !== undefined && { cls }),
        ...(phone !== undefined && { phone }),
        ...(fee !== undefined && { fee: parseFloat(fee) }),
        ...(paid !== undefined && { paid: parseFloat(paid) }),
        ...(termId !== undefined && { termId }),
      },
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

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const students      = await prisma.student.findMany({ where: { userId: req.userId } });
    const totalFee      = students.reduce((s, st) => s + st.fee, 0);
    const totalCollected = students.reduce((s, st) => s + st.paid, 0);
    const totalArrears  = totalFee - totalCollected;
    const fullyPaid     = students.filter((s) => s.paid >= s.fee).length;
    const partial       = students.filter((s) => s.paid > 0 && s.paid < s.fee).length;
    const unpaid        = students.filter((s) => s.paid === 0).length;
    const today         = new Date(); today.setHours(0, 0, 0, 0);
    const todayPayments = await prisma.payment.findMany({ where: { userId: req.userId, createdAt: { gte: today } } });
    const collectedToday = todayPayments.reduce((s, p) => s + p.amount, 0);

    res.json({
      totalCollected, totalArrears, collectedToday,
      paymentsToday: todayPayments.length,
      totalStudents: students.length, fullyPaid, partial, unpaid,
      items: [
        {
          label: "Total Collected",
          value: `KES ${totalCollected.toLocaleString()}`,
          sub: `KES ${totalFee.toLocaleString()} expected`,
          progress: totalFee > 0 ? Math.round((totalCollected / totalFee) * 100) : 0,
          badge: `${totalFee > 0 ? Math.round((totalCollected / totalFee) * 100) : 0}% collected`,
          badgeBg: "rgba(34,211,164,0.1)", badgeColor: "var(--green)",
          iconBg: "rgba(34,211,164,0.08)", iconBorder: "rgba(34,211,164,0.15)",
        },
        {
          label: "Outstanding Arrears",
          value: `KES ${totalArrears.toLocaleString()}`,
          sub: `${unpaid + partial} students with balances`,
          progress: totalFee > 0 ? Math.round((totalArrears / totalFee) * 100) : 0,
          progressClass: "warn",
          iconBg: "rgba(248,113,113,0.08)", iconBorder: "rgba(248,113,113,0.15)",
        },
        {
          label: "Enrolled Students",
          value: students.length,
          sub: `${fullyPaid} fully paid · ${partial} partial`,
          progress: students.length > 0 ? Math.round((fullyPaid / students.length) * 100) : 0,
          iconBg: "rgba(59,130,246,0.08)", iconBorder: "rgba(59,130,246,0.15)",
        },
      ],
    });
  } catch (e) {
    console.error("stats:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// ─── Payments ─────────────────────────────────────────────────────────────────
app.get("/api/payments/recent", requireAuth, async (req, res) => {
  try {
    const { termId } = req.query;
    const payments = await prisma.payment.findMany({
      where: { userId: req.userId, ...(termId && { termId }) },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { student: true },
    });
    res.json(payments.map((p) => ({
      id: p.id,
      name: p.student?.name || "Unknown",
      initials: (p.student?.name || "??").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${p.student?.cls || ""} · ${p.student?.adm || ""}`,
      txn: p.txnRef || "—",
      amount: `KES ${p.amount.toLocaleString()}`,
      method: p.method,
      time: new Date(p.createdAt).toLocaleString("en-KE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
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
      data: {
        amount: parseFloat(amount),
        txnRef: txnRef || null,
        method: method || "cash",
        feeBreakdown: feeBreakdown || [],
        studentId, userId: req.userId,
      },
      include: { student: true },
    });
    await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) } } });
    res.status(201).json({
      ...payment,
      name: payment.student?.name,
      initials: (payment.student?.name || "??").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${payment.student?.cls || ""} · ${payment.student?.adm || ""}`,
      txn: payment.txnRef || "—",
      method: payment.method,
      feeBreakdown: payment.feeBreakdown,
      amount: `KES ${payment.amount.toLocaleString()}`,
      time: "Just now",
    });
  } catch (e) {
    console.error("create payment:", e);
    res.status(500).json({ message: "Something went wrong" });
  }
});

app.get("/api/payments/unmatched", requireAuth, async (req, res) => {
  try {
    const list = await prisma.unmatchedPayment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(list.map((p) => ({
      id: p.id, phone: p.phone, txn: p.txnRef || "—",
      amount: `KES ${p.amount.toLocaleString()}`,
      time: new Date(p.createdAt).toLocaleString("en-KE"),
    })));
  } catch { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── STK Push (Pro/Max only) ──────────────────────────────────────────────────
app.post("/api/payments/stk", requireAuth, requirePlan("mpesa"), async (req, res) => {
  const { studentId, amount, phone } = req.body;
  if (!studentId || !amount || !phone)
    return res.status(400).json({ message: "studentId, amount and phone required" });

  const CK = process.env.MPESA_CONSUMER_KEY;
  const CS = process.env.MPESA_CONSUMER_SECRET;
  const SC = process.env.MPESA_SHORTCODE;
  const PK = process.env.MPESA_PASSKEY;
  const CB = process.env.MPESA_CALLBACK_URL;

  if (!CK || !CS) return res.status(503).json({ message: "M-Pesa not configured on server" });

  try {
    const auth = Buffer.from(`${CK}:${CS}`).toString("base64");
    const tokenRes = await fetch("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
      headers: { Authorization: `Basic ${auth}` },
    });
    const { access_token } = await tokenRes.json();

    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(`${SC}${PK}${ts}`).toString("base64");

    const stkRes = await fetch("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: SC, Password: pw, Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(amount), PartyA: phone, PartyB: SC, PhoneNumber: phone,
        CallBackURL: CB, AccountReference: `FF-${studentId}`,
        TransactionDesc: "School fee payment",
      }),
    });
    const d = await stkRes.json();
    d.ResponseCode === "0"
      ? res.json({ success: true, checkoutRequestId: d.CheckoutRequestID })
      : res.status(400).json({ message: d.errorMessage || "STK push failed" });
  } catch (e) {
    console.error("stk:", e);
    res.status(500).json({ message: "STK push failed" });
  }
});

// ─── M-Pesa C2B Callback ──────────────────────────────────────────────────────
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb?.ResultCode === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const get = (n) => items.find((i) => i.Name === n)?.Value;
      const amount    = get("Amount");
      const ref       = get("MpesaReceiptNumber");
      const phone     = get("PhoneNumber")?.toString();
      const studentId = (cb.AccountReference || "").replace("FF-", "");

      const student = await prisma.student.findUnique({ where: { id: studentId } });
      if (student) {
        await prisma.payment.create({
          data: { amount: parseFloat(amount), txnRef: ref, method: "mpesa", studentId, userId: student.userId },
        });
        await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) } } });
      }
    }
  } catch (e) {
    console.error("mpesa callback:", e);
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, version: "2.0", env: process.env.NODE_ENV }));

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ message: "Route not found" }));

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`FeeFlow API → http://0.0.0.0:${PORT}  [${process.env.NODE_ENV || "development"}]`);
});

export default app;
