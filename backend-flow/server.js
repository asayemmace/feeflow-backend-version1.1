import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const app    = express();
const prisma = new PrismaClient();

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
      student: { id: student.id, name: student.name, adm: student.adm, cls: student.cls, phone: student.phone, parentName: student.parentName || null, parentPhone: student.parentPhone || null, fee: student.fee, paid: student.paid, daysOverdue: student.daysOverdue },
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
  const { name, cls, fee, paid, phone, parentName, parentPhone, feeBreakdown } = req.body;
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
      data: { name, adm, cls: cls || "", fee: parsedFee, paid: parsedPaid, phone: phone || null, parentName: parentName || null, parentPhone: parentPhone || null, daysOverdue, userId: req.userId },
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
    const { name, cls, phone, parentName, parentPhone, fee, paid, termId } = req.body;

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
      data: { ...(name !== undefined && { name }), ...(cls !== undefined && { cls }), ...(phone !== undefined && { phone }), ...(parentName !== undefined && { parentName }), ...(parentPhone !== undefined && { parentPhone }), ...(fee !== undefined && { fee: newFee }), ...(paid !== undefined && { paid: newPaid }), ...(termId !== undefined && { termId }), daysOverdue },
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

app.post("/api/mpesa/callback", async (req, res) => {
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

// ─── Helper: format WhatsApp number ────────────────────────────────────────────
function toWaNumber(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0"))   return "254" + digits.slice(1);
  if (digits.startsWith("7") || digits.startsWith("1")) return "254" + digits;
  return digits;
}

// ─── Helper: send WhatsApp via Twilio ──────────────────────────────────────────
// Set env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WA_FROM
async function sendWhatsApp(to, message) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const auth  = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WA_FROM; // e.g. "whatsapp:+14155238886"
  if (!sid || !auth || !from) throw new Error("WhatsApp provider not configured");
  const waTo  = `whatsapp:+${toWaNumber(to)}`;
  const res   = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: waTo, Body: message }),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status}`);
  return res.json();
}

// ─── Helper: send email via SendGrid ───────────────────────────────────────────
// Set env vars: SENDGRID_API_KEY, EMAIL_FROM
async function sendEmail(to, subject, html) {
  const key  = process.env.SENDGRID_API_KEY;
  const from = process.env.EMAIL_FROM || "noreply@feeflow.app";
  if (!key) throw new Error("Email provider not configured");
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: "FeeFlow" },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status}`);
}

// ─── Helper: receipt download link ─────────────────────────────────────────────
function receiptLink(receiptId) {
  return `${process.env.FRONTEND_URL || "http://localhost:5173"}/receipt/${receiptId}`;
}

// ─── Helper: invoice message text ──────────────────────────────────────────────
function buildInvoiceMessage({ schoolName, studentName, className, admNo, totalFee, dueDate, termName, note, feeBreakdown }) {
  const breakdownText = (feeBreakdown || []).map(fb => `  • ${fb.typeName}: KES ${Number(fb.amount).toLocaleString()}`).join("\n");
  return [
    `📋 *FEE INVOICE — ${schoolName}*`,
    ``,
    `Dear Parent/Guardian,`,
    ``,
    `Please find below the fee invoice for your child:`,
    ``,
    `👤 *Student:* ${studentName}`,
    `🎓 *Class:* ${className}`,
    `🔖 *Adm No:* ${admNo}`,
    termName ? `📅 *Term:* ${termName}` : null,
    ``,
    `*FEE BREAKDOWN:*`,
    breakdownText || `  • Tuition Fee: KES ${Number(totalFee).toLocaleString()}`,
    ``,
    `💰 *Total Due: KES ${Number(totalFee).toLocaleString()}*`,
    `📆 *Due Date: ${new Date(dueDate).toLocaleDateString("en-KE", { day: "2-digit", month: "long", year: "numeric" })}*`,
    note ? `\nℹ️ ${note}` : null,
    ``,
    `Kindly ensure payment is made before the due date.`,
    `Thank you — ${schoolName}`,
  ].filter(l => l !== null).join("\n");
}

// ─── Helper: receipt message text ──────────────────────────────────────────────
function buildReceiptMessage({ schoolName, studentName, className, amount, method, receiptId, txnRef }) {
  const methodLabel = { mpesa: "M-Pesa", bank: "Bank Transfer", cash: "Cash", manual: "Manual" };
  return [
    `✅ *PAYMENT RECEIPT — ${schoolName}*`,
    ``,
    `Dear Parent/Guardian,`,
    ``,
    `We have received a payment for:`,
    ``,
    `👤 *Student:* ${studentName}`,
    `🎓 *Class:* ${className}`,
    `💳 *Method:* ${methodLabel[method] || method}`,
    txnRef ? `🔖 *Ref:* ${txnRef}` : null,
    `💰 *Amount: KES ${Number(amount).toLocaleString()}*`,
    ``,
    `📥 Download your receipt:`,
    receiptLink(receiptId),
    ``,
    `Thank you — ${schoolName}`,
  ].filter(l => l !== null).join("\n");
}

// ─── Invoice Routes ─────────────────────────────────────────────────────────────

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

// POST /api/invoices
app.post("/api/invoices", requireAuth, requirePlan("invoices"), async (req, res) => {
  const { studentIds, dueDate, scheduledFor, channels, note, termName } = req.body;
  if (!studentIds?.length) return res.status(400).json({ message: "No students selected" });
  if (!dueDate)            return res.status(400).json({ message: "Due date is required" });
  if (!channels?.length)   return res.status(400).json({ message: "Select at least one channel" });

  try {
    const user     = await prisma.user.findUnique({ where: { id: req.userId } });
    const students = await prisma.student.findMany({ where: { id: { in: studentIds }, userId: req.userId } });
    const now      = new Date();
    const sendNow  = !scheduledFor || new Date(scheduledFor) <= now;

    const created = [];
    for (const student of students) {
      const recentPayments = await prisma.payment.findMany({ where: { studentId: student.id }, orderBy: { createdAt: "desc" }, take: 1 });
      const feeBreakdown   = recentPayments[0]?.feeBreakdown || [];

      const invoice = await prisma.invoice.create({
        data: {
          userId:       req.userId,
          studentId:    student.id,
          studentName:  student.name,
          admNo:        student.adm,
          className:    student.cls,
          totalFee:     student.fee,
          paid:         student.paid,
          balance:      Math.max(0, student.fee - student.paid),
          dueDate:      new Date(dueDate),
          scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
          channels,
          termName:     termName || null,
          note:         note || null,
          feeBreakdown,
          status:       sendNow ? "pending" : "scheduled",
          parentPhone:  student.parentPhone || null,
          parentName:   student.parentName  || null,
        },
      });
      created.push(invoice);

      if (sendNow) {
        const message = buildInvoiceMessage({
          schoolName:   user.schoolName || "School",
          studentName:  student.name,
          className:    student.cls,
          admNo:        student.adm,
          totalFee:     student.fee,
          dueDate,
          termName,
          note,
          feeBreakdown,
        });

        let allOk = true;
        if (channels.includes("whatsapp") && student.parentPhone) {
          try { await sendWhatsApp(student.parentPhone, message); }
          catch { allOk = false; }
        }
        if (channels.includes("email") && (student.parentEmail || student.email)) {
          const emailTo = student.parentEmail || student.email;
          try {
            await sendEmail(emailTo, `Fee Invoice — ${student.name} (${user.schoolName || "School"})`, `<pre style="font-family:sans-serif;white-space:pre-wrap">${message}</pre>`);
          } catch { allOk = false; }
        }

        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: allOk ? "sent" : "failed", sentAt: new Date() } });
      }
    }

    res.json({ created: created.length, scheduled: !sendNow });
  } catch (e) {
    console.error("Invoice creation error:", e);
    res.status(500).json({ message: "Failed to create invoices" });
  }
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
    if (channels.includes("whatsapp") && student.parentPhone) {
      try { await sendWhatsApp(student.parentPhone, message); } catch { allOk = false; }
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
        channels:    channels || ["whatsapp"],
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

    let allOk = true;
    const ch  = channels || ["whatsapp"];
    if (ch.includes("whatsapp") && student.parentPhone) {
      try { await sendWhatsApp(student.parentPhone, message); }
      catch (e) { console.error("WhatsApp send failed:", e.message); allOk = false; }
    }
    if (ch.includes("email") && (student.parentEmail || student.email)) {
      try { await sendEmail(student.parentEmail || student.email, `Payment Receipt — ${student.name}`, `<pre style="font-family:sans-serif;white-space:pre-wrap">${message}</pre>`); }
      catch (e) { console.error("Email send failed:", e.message); allOk = false; }
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
    if ((receipt.channels || []).includes("whatsapp") && student.parentPhone) {
      try { await sendWhatsApp(student.parentPhone, message); } catch { allOk = false; }
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
        channels:    ["whatsapp"],
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

    if (student.parentPhone) {
      await sendWhatsApp(student.parentPhone, message);
      await prisma.receipt.update({ where: { id: receipt.id }, data: { status: "sent", sentAt: new Date() } });
    }
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
      if (channels.includes("whatsapp") && student.parentPhone) {
        try { await sendWhatsApp(student.parentPhone, message); } catch { allOk = false; }
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
app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ message: "Internal server error" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`FeeFlow API → http://0.0.0.0:${PORT}  [${process.env.NODE_ENV || "development"}]`));

export default app;