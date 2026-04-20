/**
 * useAppStore — global Zustand store for FeeFlow
 *
 * Fetched ONCE when AppLayout mounts. All pages read from here.
 * Mutations (add/edit/delete) update the store locally — no re-fetch needed.
 * Only re-fetches on term change or manual refresh.
 */
import { create } from "zustand";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

const useAppStore = create((set, get) => ({
  // ── State ──────────────────────────────────────────────────────────────────
  students:      [],
  payments:      [],
  unmatched:     [],
  terms:         [],
  activeTerm:    null,
  stats:         null,
  recentPayments: [],
  topUnpaid:     [],

  studentsLoaded: false,
  paymentsLoaded: false,
  termsLoaded:    false,
  statsLoaded:    false,

  // ── Bootstrap — called once from AppLayout ────────────────────────────────
  bootstrap: async (token) => {
    const h = { Authorization: `Bearer ${token}` };

    // Fire all four in parallel — pages show instantly from cache after first load
    const [termsRes, studentsRes, paymentsRes, unmatchedRes, statsRes] = await Promise.allSettled([
      axios.get(`${API}/api/terms`,              { headers: h }),
      axios.get(`${API}/api/students`,           { headers: h }),
      axios.get(`${API}/api/payments`,           { headers: h }),
      axios.get(`${API}/api/payments/unmatched`, { headers: h }),
      axios.get(`${API}/api/stats`,              { headers: h }),
    ]);

    const terms = termsRes.status === "fulfilled" ? termsRes.value.data : [];
    set({
      terms,
      activeTerm:    terms.find(t => t.status === "active") || null,
      termsLoaded:   true,

      students:       studentsRes.status === "fulfilled" ? studentsRes.value.data : [],
      studentsLoaded: true,

      payments:       paymentsRes.status === "fulfilled" ? paymentsRes.value.data : [],
      unmatched:      unmatchedRes.status === "fulfilled" ? unmatchedRes.value.data : [],
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

  // ── Reset on logout ───────────────────────────────────────────────────────
  reset: () => set({
    students: [], payments: [], unmatched: [], terms: [], activeTerm: null,
    stats: null, recentPayments: [], topUnpaid: [],
    studentsLoaded: false, paymentsLoaded: false, termsLoaded: false, statsLoaded: false,
  }),

  // ── Students mutations ────────────────────────────────────────────────────
  addStudent: (student) => set(s => ({ students: [student, ...s.students] })),

  updateStudent: (updated) => set(s => ({
    students: s.students.map(st => st.id === updated.id ? updated : st),
  })),

  // ── Payments mutations ────────────────────────────────────────────────────
  addPayment: (payment) => set(s => ({ payments: [payment, ...s.payments] })),

  deletePayment: (id) => set(s => ({ payments: s.payments.filter(p => p.id !== id) })),

  removeUnmatched: (id) => set(s => ({ unmatched: s.unmatched.filter(u => u.id !== id) })),

  // ── Terms mutations ───────────────────────────────────────────────────────
  setNewTerm: (newTerm) => set(s => ({
    terms:      [...s.terms.map(t => ({ ...t, status: "closed" })), newTerm],
    activeTerm: newTerm,
    // Reset student paid balances locally to mirror what server did
    students:   s.students.map(st => ({ ...st, paid: 0, daysOverdue: 0 })),
    // Clear stats — will be refreshed
    stats: null, recentPayments: [], topUnpaid: [], statsLoaded: false,
    // Clear payments — new term, fresh slate
    payments: [],
  })),
}));

export default useAppStore;