/**
 * useAppStore — global Zustand store for FeeFlow
 *
 * Fetched ONCE when AppLayout mounts. All pages read from here.
 * Mutations (add/edit/delete) update the store locally — no re-fetch needed.
 * Only re-fetches on term change or manual refresh.
 *
 * PERFORMANCE: Bootstrap now uses a streaming approach —
 * terms load first (fast, tiny payload) and unlock the UI immediately.
 * Students + payments load in the background so the page is never blank.
 */
import { create } from "zustand";
import axios from "axios";
import analytics from "../analytics/analytics";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

// Unwrap paginated { data: [], pagination: {} } OR plain array
const unwrap = (res) => {
  if (res.status !== "fulfilled") return [];
  const d = res.value.data;
  return Array.isArray(d) ? d : (d?.data || []);
};

const useAppStore = create((set, get) => ({
  // ── State ──────────────────────────────────────────────────────────────────
  students:       [],
  payments:       [],
  unmatched:      [],
  terms:          [],
  activeTerm:     null,
  stats:          null,
  recentPayments: [],
  topUnpaid:      [],

  studentsLoaded: false,
  paymentsLoaded: false,
  termsLoaded:    false,
  statsLoaded:    false,

  termSnapshots: {},

  // ── Bootstrap — streaming: terms first, then everything else ──────────────
  // This fixes the long loading screen — the app renders as soon as terms
  // are available (usually <300ms) instead of waiting for all 5 calls.
  bootstrap: async (token) => {
    const h = { Authorization: `Bearer ${token}` };

    // PHASE 1: Load terms first — tiny payload, unlocks the UI immediately
    try {
      const termsRes = await axios.get(`${API}/api/terms`, { headers: h });
      const terms    = Array.isArray(termsRes.data) ? termsRes.data : [];
      set({
        terms,
        activeTerm:  terms.find(t => t.status === "active") || null,
        termsLoaded: true,
      });
    } catch {
      set({ termsLoaded: true }); // unlock UI even on failure
    }

    // PHASE 2: Load everything else in parallel — pages show skeletons meanwhile
    const [studentsRes, paymentsRes, unmatchedRes, statsRes] = await Promise.allSettled([
      axios.get(`${API}/api/students`,           { headers: h }),
      axios.get(`${API}/api/payments`,           { headers: h }),
      axios.get(`${API}/api/payments/unmatched`, { headers: h }),
      axios.get(`${API}/api/stats`,              { headers: h }),
    ]);

    set({
      students:       unwrap(studentsRes),
      studentsLoaded: true,

      payments:       unwrap(paymentsRes),
      unmatched:      unmatchedRes.status === "fulfilled" ? (unmatchedRes.value.data || []) : [],
      paymentsLoaded: true,

      stats:          statsRes.status === "fulfilled" ? statsRes.value.data : null,
      recentPayments: statsRes.status === "fulfilled" ? (statsRes.value.data?.recentPayments || []) : [],
      topUnpaid:      statsRes.status === "fulfilled" ? (statsRes.value.data?.topUnpaid || []) : [],
      statsLoaded:    true,
    });
  },

  // ── Refresh stats only (cheap — called after payment mutations) ───────────
  refreshStats: async (token) => {
    try {
      const r = await axios.get(`${API}/api/stats`, { headers: { Authorization: `Bearer ${token}` } });
      set({
        stats:          r.data || null,
        recentPayments: r.data?.recentPayments || [],
        topUnpaid:      r.data?.topUnpaid || [],
        statsLoaded:    true,
      });
    } catch {}
  },

  // ── Refresh students from server (re-derives ledger fields) ─────────────────
  // Called after a payment, reversal, or invoice is created so the store's
  // outstanding/totalPaid fields stay in sync with the ledger.
  refreshStudents: async (token) => {
    try {
      const r = await axios.get(`${API}/api/students`, { headers: { Authorization: `Bearer ${token}` } });
      const students = Array.isArray(r.data) ? r.data : (r.data?.data || []);
      set({ students, studentsLoaded: true });
    } catch {}
  },

  refreshPayments: async (token) => {
    try {
      const previousPayments = get().payments || [];
      const previousUnmatched = get().unmatched || [];
      const hadLoadedPayments = get().paymentsLoaded;
      const [paymentsRes, unmatchedRes] = await Promise.allSettled([
        axios.get(`${API}/api/payments`, { headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/api/payments/unmatched`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const payments = unwrap(paymentsRes);
      const unmatched = unmatchedRes.status === "fulfilled" ? (unmatchedRes.value.data || []) : previousUnmatched;
      if (hadLoadedPayments) {
        const oldPaymentIds = new Set(previousPayments.map(p => p.id));
        payments.filter(p => p.id && !oldPaymentIds.has(p.id)).forEach(p => {
          analytics.track("payment_received", {
            amount: p.rawAmount || p.amount,
            paymentMethod: p.method,
            studentId: p.studentId,
          });
        });
        const oldUnmatchedIds = new Set(previousUnmatched.map(p => p.id));
        unmatched.filter(p => p.id && !oldUnmatchedIds.has(p.id)).forEach(p => {
          analytics.track("unmatched_payment_created", {
            amount: p.rawAmount || p.amount,
            paymentMethod: "mpesa",
            source: p.source || "c2b",
          });
        });
      }
      set({
        payments,
        unmatched,
        paymentsLoaded: true,
      });
    } catch {}
  },

  // ── Reset on logout ───────────────────────────────────────────────────────
  reset: () => set({
    students: [], payments: [], unmatched: [], terms: [], activeTerm: null,
    stats: null, recentPayments: [], topUnpaid: [],
    studentsLoaded: false, paymentsLoaded: false, termsLoaded: false, statsLoaded: false,
    termSnapshots: {},
  }),

  // ── Students mutations ────────────────────────────────────────────────────
  addStudent:    (student) => set(s => ({ students: [student, ...s.students] })),
  updateStudent: (updated) => set(s => ({ students: s.students.map(st => st.id === updated.id ? updated : st) })),
  removeStudent: (id)      => set(s => ({ students: s.students.filter(st => st.id !== id) })),

  // ── Payments mutations ────────────────────────────────────────────────────
  addPayment:     (payment) => set(s => ({ payments: [payment, ...s.payments] })),
  // updatePayment: marks a reversed payment in the local store so the REVERSED badge
  // renders immediately without a full re-fetch. Also used for conflict-resolution refresh.
  updatePayment:  (updated) => set(s => ({ payments: s.payments.map(p => p.id === updated.id ? { ...p, ...updated } : p) })),
  deletePayment:  (id)      => set(s => ({ payments: s.payments.filter(p => p.id !== id) })),
  removeUnmatched:(id)      => set(s => ({ unmatched: s.unmatched.filter(u => u.id !== id) })),

  // ── Term snapshot ─────────────────────────────────────────────────────────
  saveTermSnapshot: (termId, snapshot) => set(s => ({
    termSnapshots: { ...s.termSnapshots, [termId]: snapshot },
  })),

  // ── Terms mutations ───────────────────────────────────────────────────────
  setNewTerm: (newTerm) => set(s => ({
    terms:      [...s.terms.map(t => ({ ...t, status: "closed" })), newTerm],
    activeTerm: newTerm,
    // Reset all mutable financial fields for the new term — ledger fields will be
    // re-derived on the next stats load. Both paid and outstanding reset to 0.
    students:   s.students.map(st => ({ ...st, daysOverdue: 0 })),
    stats: null, recentPayments: [], topUnpaid: [], statsLoaded: false,
  })),
  updateTerm: (updatedTerm) => set(s => ({
    terms: s.terms.map(t => t.id === updatedTerm.id ? { ...t, ...updatedTerm } : t),
    activeTerm: s.activeTerm?.id === updatedTerm.id ? { ...s.activeTerm, ...updatedTerm } : s.activeTerm,
  })),
}));

export default useAppStore;
