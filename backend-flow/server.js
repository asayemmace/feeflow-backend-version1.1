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
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());

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
    return res.status(401).json({ message: "Invalid token" });
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
  } catch {
    res.status(500).json({ message: "Something went wrong" });
  }
};

// ─── Register ─────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, schoolName } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "Name, email and password are required" });
  try {
    if (await prisma.user.findUnique({ where: { email } }))
      return res.status(400).json({ message: "Email already registered" });
    const user = await prisma.user.create({
      data: { name, email, password: await bcrypt.hash(password, 10), schoolName, plan: "free" },
    });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: pick(user) });
  } catch (e) { console.error(e); res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Login ────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password required" });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: pick(user) });
  } catch (e) { console.error(e); res.status(500).json({ message: "Something went wrong" }); }
});

function pick(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, schoolName: u.schoolName, plan: u.plan, planExpiry: u.planExpiry };
}

// ─── Profile ──────────────────────────────────────────────────────────────────
app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "Not found" });
    res.json(pick(user));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/profile", requireAuth, async (req, res) => {
  const { name, phone, schoolName } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { ...(name && { name }), ...(phone !== undefined && { phone }), ...(schoolName !== undefined && { schoolName }) },
    });
    res.json(pick(user));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/email", requireAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and current password required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!await bcrypt.compare(password, user.password))
      return res.status(401).json({ message: "Current password is incorrect" });
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists && exists.id !== req.userId) return res.status(400).json({ message: "Email already in use" });
    const updated = await prisma.user.update({ where: { id: req.userId }, data: { email } });
    res.json(pick(updated));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/auth/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both passwords required" });
  if (newPassword.length < 6) return res.status(400).json({ message: "Min 6 characters" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!await bcrypt.compare(currentPassword, user.password))
      return res.status(401).json({ message: "Current password is incorrect" });
    await prisma.user.update({ where: { id: req.userId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    res.json({ message: "Password updated" });
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Terms ────────────────────────────────────────────────────────────────────
app.get("/api/terms", requireAuth, async (req, res) => {
  try {
    res.json(await prisma.term.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/terms", requireAuth, async (req, res) => {
  const { name, startDate, endDate } = req.body;
  if (!name || !startDate || !endDate) return res.status(400).json({ message: "All fields required" });
  try {
    await prisma.term.updateMany({ where: { userId: req.userId, status: "active" }, data: { status: "closed" } });
    const term = await prisma.term.create({
      data: { name, startDate: new Date(startDate), endDate: new Date(endDate), status: "active", userId: req.userId },
    });
    res.status(201).json(term);
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/terms/:id/export", requireAuth, async (req, res) => {
  const { format } = req.query;
  try {
    const term = await prisma.term.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!term) return res.status(404).json({ message: "Term not found" });
    const students = await prisma.student.findMany({ where: { userId: req.userId } });
    const payments = await prisma.payment.findMany({ where: { userId: req.userId, termId: req.params.id }, include: { student: true } });

    if (format === "excel") {
      const XLSX = (await import("xlsx")).default;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(students.map((s) => ({
        "Student Name": s.name, "Adm No": s.adm, Class: s.cls, Phone: s.phone || "—",
        "Term Fee (KES)": s.fee, "Paid (KES)": s.paid, "Balance (KES)": s.fee - s.paid,
        Status: s.paid >= s.fee ? "Paid" : s.paid > 0 ? "Partial" : "Overdue",
      }))), "Students");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payments.map((p) => ({
        Date: new Date(p.createdAt).toLocaleDateString("en-KE"), Student: p.student?.name || "—",
        "Amount (KES)": p.amount, Method: p.method, "TXN Ref": p.txnRef || "—",
      }))), "Payments");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Disposition", `attachment; filename="${term.name}.xlsx"`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return res.send(buf);
    }
    res.status(501).json({ message: "PDF export: integrate Gotenberg on your VPS." });
  } catch (e) { console.error(e); res.status(500).json({ message: "Export failed" }); }
});

// ─── Students ─────────────────────────────────────────────────────────────────
app.get("/api/students", requireAuth, async (req, res) => {
  try {
    res.json(await prisma.student.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/students", requireAuth, async (req, res) => {
  const { name, cls, fee, paid, phone, adm } = req.body;
  if (!name || !cls || fee == null) return res.status(400).json({ message: "Name, class and fee required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const limit = PLAN_LIMITS[user?.plan || "free"]?.students ?? 300;
    const count = await prisma.student.count({ where: { userId: req.userId } });
    if (count >= limit)
      return res.status(403).json({ message: `${user?.plan?.toUpperCase() || "FREE"} plan limit is ${limit} students. Upgrade to add more.`, upgradeRequired: true });

    const admNo = adm?.trim() || `ADM-${Date.now()}`;
    if (await prisma.student.findUnique({ where: { adm: admNo } }))
      return res.status(400).json({ message: "Admission number already exists" });

    const student = await prisma.student.create({
      data: { name: name.trim(), cls, fee: parseFloat(fee), paid: parseFloat(paid) || 0, adm: admNo, phone: phone?.trim() || null, userId: req.userId },
    });
    res.status(201).json(student);
  } catch (e) { console.error(e); res.status(500).json({ message: "Something went wrong" }); }
});

app.patch("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const student = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Not found" });
    const { name, cls, fee, paid, phone } = req.body;
    res.json(await prisma.student.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(cls && { cls }), ...(fee != null && { fee: parseFloat(fee) }), ...(paid != null && { paid: parseFloat(paid) }), ...(phone !== undefined && { phone }) },
    }));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.delete("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const s = await prisma.student.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!s) return res.status(404).json({ message: "Not found" });
    await prisma.payment.deleteMany({ where: { studentId: req.params.id } });
    await prisma.student.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/students/unpaid", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({ where: { userId: req.userId } });
    res.json(
      students.filter((s) => s.paid < s.fee)
        .sort((a, b) => (b.fee - b.paid) - (a.fee - a.paid))
        .slice(0, 5)
        .map((s, i) => ({ rank: i + 1, name: s.name, cls: s.cls, bal: `KES ${(s.fee - s.paid).toLocaleString()}`, days: s.daysOverdue > 0 ? `${s.daysOverdue} days overdue` : "Pending" }))
    );
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({ where: { userId: req.userId } });
    const totalFee = students.reduce((s, st) => s + st.fee, 0);
    const totalCollected = students.reduce((s, st) => s + st.paid, 0);
    const totalArrears = totalFee - totalCollected;
    const fullyPaid = students.filter((s) => s.paid >= s.fee).length;
    const partial = students.filter((s) => s.paid > 0 && s.paid < s.fee).length;
    const unpaid = students.filter((s) => s.paid === 0).length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayPayments = await prisma.payment.findMany({ where: { userId: req.userId, createdAt: { gte: today } } });
    const collectedToday = todayPayments.reduce((s, p) => s + p.amount, 0);
    res.json({
      totalCollected, totalArrears, collectedToday, paymentsToday: todayPayments.length,
      totalStudents: students.length, fullyPaid, partial, unpaid,
      items: [
        { label: "Total Collected", value: `KES ${totalCollected.toLocaleString()}`, sub: `KES ${totalFee.toLocaleString()} expected`, progress: totalFee > 0 ? Math.round((totalCollected / totalFee) * 100) : 0, badge: `${totalFee > 0 ? Math.round((totalCollected / totalFee) * 100) : 0}% collected`, badgeBg: "rgba(34,211,164,0.1)", badgeColor: "var(--green)", iconBg: "rgba(34,211,164,0.08)", iconBorder: "rgba(34,211,164,0.15)" },
        { label: "Outstanding Arrears", value: `KES ${totalArrears.toLocaleString()}`, sub: `${unpaid + partial} students with balances`, progress: totalFee > 0 ? Math.round((totalArrears / totalFee) * 100) : 0, progressClass: "warn", iconBg: "rgba(248,113,113,0.08)", iconBorder: "rgba(248,113,113,0.15)" },
        { label: "Enrolled Students", value: students.length, sub: `${fullyPaid} fully paid · ${partial} partial`, progress: students.length > 0 ? Math.round((fullyPaid / students.length) * 100) : 0, iconBg: "rgba(59,130,246,0.08)", iconBorder: "rgba(59,130,246,0.15)" },
      ],
    });
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── Payments ─────────────────────────────────────────────────────────────────
app.get("/api/payments/recent", requireAuth, async (req, res) => {
  try {
    const { termId } = req.query;
    const payments = await prisma.payment.findMany({
      where: { userId: req.userId, ...(termId && { termId }) },
      orderBy: { createdAt: "desc" }, take: 30, include: { student: true },
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
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

app.post("/api/payments", requireAuth, async (req, res) => {
  const { studentId, amount, txnRef, method, termId } = req.body;
  if (!studentId || !amount) return res.status(400).json({ message: "studentId and amount required" });
  try {
    const student = await prisma.student.findFirst({ where: { id: studentId, userId: req.userId } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    const payment = await prisma.payment.create({
      data: { amount: parseFloat(amount), txnRef: txnRef || null, method: method || "mpesa", studentId, userId: req.userId, termId: termId || null },
      include: { student: true },
    });
    await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) } } });
    res.status(201).json({
      ...payment, name: payment.student?.name,
      initials: (payment.student?.name || "??").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
      meta: `${payment.student?.cls || ""} · ${payment.student?.adm || ""}`,
      txn: payment.txnRef || "—", amount: `KES ${payment.amount.toLocaleString()}`, time: "Just now",
    });
  } catch (e) { console.error(e); res.status(500).json({ message: "Something went wrong" }); }
});

app.get("/api/payments/unmatched", requireAuth, async (req, res) => {
  try {
    const list = await prisma.unmatchedPayment.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json(list.map((p) => ({ id: p.id, phone: p.phone, txn: p.txnRef || "—", amount: `KES ${p.amount.toLocaleString()}`, time: new Date(p.createdAt).toLocaleString("en-KE") })));
  } catch (e) { res.status(500).json({ message: "Something went wrong" }); }
});

// ─── STK Push (Pro/Max only) ──────────────────────────────────────────────────
app.post("/api/payments/stk", requireAuth, requirePlan("mpesa"), async (req, res) => {
  const { studentId, amount, phone } = req.body;
  if (!studentId || !amount || !phone) return res.status(400).json({ message: "studentId, amount and phone required" });

  const CK = process.env.MPESA_CONSUMER_KEY, CS = process.env.MPESA_CONSUMER_SECRET;
  const SC = process.env.MPESA_SHORTCODE, PK = process.env.MPESA_PASSKEY, CB = process.env.MPESA_CALLBACK_URL;

  if (!CK || !CS) return res.status(503).json({ message: "M-Pesa not configured on server" });

  try {
    const auth = Buffer.from(`${CK}:${CS}`).toString("base64");
    const { access_token } = await (await fetch("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", { headers: { Authorization: `Basic ${auth}` } })).json();
    const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const pw = Buffer.from(`${SC}${PK}${ts}`).toString("base64");
    const d  = await (await fetch("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ BusinessShortCode: SC, Password: pw, Timestamp: ts, TransactionType: "CustomerPayBillOnline", Amount: Math.round(amount), PartyA: phone, PartyB: SC, PhoneNumber: phone, CallBackURL: CB, AccountReference: `FF-${studentId}`, TransactionDesc: "School fee payment" }),
    })).json();
    d.ResponseCode === "0" ? res.json({ success: true, checkoutRequestId: d.CheckoutRequestID }) : res.status(400).json({ message: d.errorMessage || "STK push failed" });
  } catch (e) { console.error(e); res.status(500).json({ message: "STK push failed" }); }
});

// ─── M-Pesa C2B Callback ──────────────────────────────────────────────────────
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb?.ResultCode === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const get = (n) => items.find((i) => i.Name === n)?.Value;
      const amount = get("Amount"), ref = get("MpesaReceiptNumber"), phone = get("PhoneNumber")?.toString();
      const studentId = (cb.AccountReference || "").replace("FF-", "");
      const student = await prisma.student.findUnique({ where: { id: studentId } });
      if (student) {
        await prisma.payment.create({ data: { amount: parseFloat(amount), txnRef: ref, method: "mpesa", studentId, userId: student.userId } });
        await prisma.student.update({ where: { id: studentId }, data: { paid: { increment: parseFloat(amount) } } });
      }
    }
  } catch (e) { console.error("Callback error:", e); }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, version: "2.0" }));

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`FeeFlow API → http://localhost:${PORT}`));
}

export default app;
