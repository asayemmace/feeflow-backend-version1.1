import { useState, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

// ─── Add Payment Modal ─────────────────────────────────────────────────────────
function AddPaymentModal({ onClose, onAdded }) {
  const { token } = useAuth();
  const [students, setStudents]     = useState([]);
  const [loadingStudents, setLoadingStudents] = useState(true);

  const [form, setForm] = useState({
    studentId: "",
    amount: "",
    phone: "",
    txnRef: "",
    method: "mpesa",
  });

  const [selectedStudent, setSelectedStudent] = useState(null);
  const [classFilter, setClassFilter]         = useState("all");
  const [saving, setSaving]                   = useState(false);
  const [stkLoading, setStkLoading]           = useState(false);
  const [error, setError]                     = useState("");
  const [stkSent, setStkSent]                 = useState(false);

  // Load students for picker
  useEffect(() => {
    axios.get(`${API}/api/students`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => setStudents(r.data))
      .catch(() => setError("Could not load students."))
      .finally(() => setLoadingStudents(false));
  }, [token]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleStudentSelect = (student) => {
    setSelectedStudent(student);
    setForm((f) => ({
      ...f,
      studentId: student.id,
      amount: Math.max(0, student.fee - student.paid).toString(),
    }));
  };

  // Unique classes from student list
  const classes = [...new Set(students.map((s) => s.cls))].sort();
  const filteredStudents = classFilter === "all"
    ? students
    : students.filter((s) => s.cls === classFilter);

  const balance = selectedStudent
    ? Math.max(0, selectedStudent.fee - selectedStudent.paid)
    : 0;

  const amountNum = parseFloat(form.amount) || 0;

  const phoneValid = /^(07|01)\d{8}$/.test(form.phone.replace(/\s/g, ""));

  const handleSave = async () => {
    if (!form.studentId) { setError("Please select a student."); return; }
    if (amountNum <= 0)  { setError("Enter a valid amount."); return; }
    setSaving(true); setError("");
    try {
      const res = await axios.post(
        `${API}/api/payments`,
        {
          studentId: form.studentId,
          amount: amountNum,
          txnRef: form.txnRef.trim() || null,
          method: form.method,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      onAdded(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to record payment.");
    } finally {
      setSaving(false);
    }
  };

  const handleSTK = async () => {
    if (!phoneValid || !form.studentId || amountNum <= 0) return;
    setStkLoading(true); setError(""); setStkSent(false);
    try {
      await axios.post(
        `${API}/api/payments/stk`,
        { studentId: form.studentId, amount: amountNum, phone: form.phone.replace(/\s/g, "") },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setStkSent(true);
    } catch (err) {
      setError(err.response?.data?.message || "STK push failed. Check number and try again.");
    } finally {
      setStkLoading(false);
    }
  };

  const inp = {
    width: "100%", padding: "9px 12px",
    background: "#212f48", border: "1px solid #1e2d47",
    borderRadius: 8, color: "#e8edf5", fontSize: 13.5,
    fontFamily: "'DM Sans',sans-serif", outline: "none",
  };
  const lbl = {
    fontSize: 11.5, fontWeight: 600, color: "#8a9dbf",
    textTransform: "uppercase", letterSpacing: 0.8,
    marginBottom: 6, display: "block",
  };

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 40,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)",
      }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", zIndex: 50,
        transform: "translate(-50%,-50%)",
        width: "100%", maxWidth: 560,
        background: "#111827", border: "1px solid #1e2d47",
        borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        maxHeight: "90vh", display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px", borderBottom: "1px solid #1e2d47",
          display: "flex", justifyContent: "space-between", alignItems: "flex-start",
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e8edf5", fontFamily: "'DM Serif Display',serif" }}>
              Record Payment
            </div>
            <div style={{ fontSize: 12, color: "#4a5f80", marginTop: 3 }}>
              Select a student, enter amount, then save or trigger STK push
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 7,
            background: "transparent", border: "1px solid #1e2d47",
            color: "#8a9dbf", cursor: "pointer", fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>×</button>
        </div>

        <div style={{ overflowY: "auto", padding: "20px 24px", flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Student picker */}
          <div>
            <label style={lbl}>Select Student *</label>

            {/* Class filter */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => setClassFilter("all")}
                style={{
                  padding: "4px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 500,
                  background: classFilter === "all" ? "#22d3a4" : "#1a2236",
                  border: "1px solid " + (classFilter === "all" ? "#22d3a4" : "#1e2d47"),
                  color: classFilter === "all" ? "#0b1a14" : "#8a9dbf",
                  cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                }}
              >All</button>
              {classes.map((c) => (
                <button key={c} onClick={() => setClassFilter(c)} style={{
                  padding: "4px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 500,
                  background: classFilter === c ? "#22d3a4" : "#1a2236",
                  border: "1px solid " + (classFilter === c ? "#22d3a4" : "#1e2d47"),
                  color: classFilter === c ? "#0b1a14" : "#8a9dbf",
                  cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                }}>{c}</button>
              ))}
            </div>

            {/* Student list */}
            <div style={{
              border: "1px solid #1e2d47", borderRadius: 10, overflow: "hidden",
              maxHeight: 200, overflowY: "auto",
            }}>
              {loadingStudents ? (
                <div style={{ padding: "20px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>Loading students…</div>
              ) : filteredStudents.length === 0 ? (
                <div style={{ padding: "20px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>No students found</div>
              ) : filteredStudents.map((s) => {
                const bal = Math.max(0, s.fee - s.paid);
                const isSelected = form.studentId === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => handleStudentSelect(s)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 14px",
                      background: isSelected ? "rgba(34,211,164,0.08)" : "transparent",
                      borderBottom: "1px solid #1e2d47",
                      cursor: "pointer", transition: "background .1s",
                      borderLeft: isSelected ? "3px solid #22d3a4" : "3px solid transparent",
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#1a2236"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "#e8edf5" }}>{s.name}</div>
                      <div style={{ fontSize: 11.5, color: "#4a5f80", marginTop: 2 }}>{s.cls} · {s.adm || "—"}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{
                        fontSize: 12.5, fontWeight: 600,
                        color: bal === 0 ? "#22d3a4" : "#f59e0b",
                      }}>
                        {bal === 0 ? "Fully paid" : `KES ${bal.toLocaleString()} due`}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected student summary */}
          {selectedStudent && (
            <div style={{
              background: "#1a2236", border: "1px solid #1e2d47",
              borderRadius: 10, padding: "12px 14px",
            }}>
              <div style={{ fontSize: 12, color: "#4a5f80", marginBottom: 8 }}>Fee summary — {selectedStudent.name}</div>
              <div style={{ display: "flex", gap: 20 }}>
                {[
                  ["Term fee",   `KES ${selectedStudent.fee.toLocaleString()}`],
                  ["Paid",       `KES ${selectedStudent.paid.toLocaleString()}`],
                  ["Balance",    `KES ${balance.toLocaleString()}`],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 11, color: "#4a5f80", textTransform: "uppercase", letterSpacing: 0.8 }}>{k}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: k === "Balance" && balance > 0 ? "#f59e0b" : "#e8edf5", marginTop: 2 }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Amount + method */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Amount (KES) *</label>
              <input
                type="number"
                style={inp}
                placeholder="Enter amount"
                value={form.amount}
                onChange={set("amount")}
              />
              {selectedStudent && balance > 0 && (
                <div style={{ fontSize: 11, color: "#4a5f80", marginTop: 4 }}>
                  Full balance: KES {balance.toLocaleString()}
                  &nbsp;
                  <span
                    onClick={() => setForm((f) => ({ ...f, amount: balance.toString() }))}
                    style={{ color: "#22d3a4", cursor: "pointer", textDecoration: "underline" }}
                  >Use this</span>
                </div>
              )}
            </div>
            <div>
              <label style={lbl}>Payment method</label>
              <select style={{ ...inp, cursor: "pointer" }} value={form.method} onChange={set("method")}>
                <option value="mpesa">M-Pesa</option>
                <option value="bank">Bank transfer</option>
                <option value="cash">Cash</option>
              </select>
            </div>
          </div>

          {/* TXN ref */}
          <div>
            <label style={lbl}>Transaction reference (optional)</label>
            <input style={inp} placeholder="e.g. QA73NXP2" value={form.txnRef} onChange={set("txnRef")} />
          </div>

          {/* STK push */}
          <div style={{
            background: "rgba(34,211,164,0.04)",
            border: "1px solid rgba(34,211,164,0.1)",
            borderRadius: 10, padding: "14px",
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#8a9dbf", marginBottom: 10 }}>
              M-Pesa STK Push (optional)
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                style={{ ...inp, flex: 1 }}
                placeholder="07XX XXX XXX"
                value={form.phone}
                onChange={set("phone")}
                maxLength={12}
              />
              <button
                onClick={handleSTK}
                disabled={!phoneValid || !form.studentId || amountNum <= 0 || stkLoading}
                style={{
                  padding: "9px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: (!phoneValid || !form.studentId || amountNum <= 0)
                    ? "#212f48"
                    : stkSent ? "rgba(34,211,164,0.15)" : "#22d3a4",
                  border: stkSent ? "1px solid rgba(34,211,164,0.3)" : "none",
                  color: (!phoneValid || !form.studentId || amountNum <= 0)
                    ? "#4a5f80"
                    : stkSent ? "#22d3a4" : "#0b1a14",
                  cursor: (!phoneValid || !form.studentId || amountNum <= 0 || stkLoading)
                    ? "not-allowed" : "pointer",
                  whiteSpace: "nowrap", fontFamily: "'DM Sans',sans-serif",
                  transition: "all .2s",
                }}
              >
                {stkLoading ? "Sending…" : stkSent ? "✓ Sent!" : "Send STK →"}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "#4a5f80", marginTop: 8 }}>
              {!form.phone
                ? "Enter a valid Kenyan number (07XX or 01XX) to enable STK push."
                : !phoneValid
                ? "Number looks incomplete — must be 10 digits starting with 07 or 01."
                : "Number looks good. STK push will prompt the parent to enter their M-Pesa PIN."}
            </div>
            {stkSent && (
              <div style={{
                marginTop: 8, fontSize: 12, color: "#22d3a4",
                background: "rgba(34,211,164,0.06)", border: "1px solid rgba(34,211,164,0.1)",
                borderRadius: 8, padding: "8px 10px",
              }}>
                ✓ STK prompt sent. Once the parent pays, record the payment manually above or it will auto-match via M-Pesa webhook.
              </div>
            )}
          </div>

          {error && (
            <div style={{
              fontSize: 12, color: "#f87171",
              background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
              borderRadius: 8, padding: "10px 12px",
            }}>✕ {error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 24px", borderTop: "1px solid #1e2d47",
          display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0,
        }}>
          <button onClick={onClose} style={{
            padding: "8px 16px", borderRadius: 8, fontSize: 13,
            background: "transparent", border: "1px solid #1e2d47",
            color: "#8a9dbf", cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: saving ? "#212f48" : "#22d3a4",
            border: "none", color: saving ? "#4a5f80" : "#0b1a14",
            cursor: saving ? "not-allowed" : "pointer",
            fontFamily: "'DM Sans',sans-serif",
          }}>{saving ? "Saving…" : "Save payment"}</button>
        </div>
      </div>
      <style>{`select option{background:#1a2236;color:#e8edf5}`}</style>
    </>
  );
}

// ─── Payments Page ─────────────────────────────────────────────────────────────
const Payments = () => {
  const { token } = useAuth();
  const [payments, setPayments]     = useState([]);
  const [unmatched, setUnmatched]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showModal, setShowModal]   = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [pRes, uRes] = await Promise.all([
          axios.get(`${API}/api/payments/recent`, { headers: { Authorization: `Bearer ${token}` } }),
          axios.get(`${API}/api/payments/unmatched`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        setPayments(pRes.data);
        setUnmatched(uRes.data);
      } catch (err) {
        console.error("Payments load error:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  const handleAdded = (payment) => {
    // Re-shape backend response to match list format and prepend
    setPayments((prev) => [
      {
        name: payment.student?.name || "—",
        initials: (payment.student?.name || "??").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
        detail: `${payment.student?.cls || ""} · ${payment.student?.adm || ""}`,
        txn: payment.txnRef || "Manual",
        amount: `KES ${payment.amount.toLocaleString()}`,
        time: "Just now",
      },
      ...prev,
    ]);
  };

  const PayIcon = () => (
    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/>
    </svg>
  );

  const QuestionIcon = () => (
    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  );

  return (
    <>
      {/* Topbar */}
      <div className="topbar" style={{ marginBottom: 24 }}>
        <div>
          <div className="topbar-title">Payments</div>
          <div className="topbar-sub">M-Pesa transactions and manual records</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Record Payment
        </button>
      </div>

      {/* Matched payments */}
      <div className="card" style={{ marginBottom: 0 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Payments</div>
            <div className="card-sub">All recorded payments</div>
          </div>
        </div>
        <div className="card-body-flush">
          {loading ? (
            <div style={{ padding: "32px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>Loading payments…</div>
          ) : payments.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#4a5f80", fontSize: 13 }}>
              No payments recorded yet. Click <strong style={{ color: "#22d3a4" }}>Record Payment</strong> to add one.
            </div>
          ) : payments.map((p, i) => (
            <div className="pay-item" key={i}>
              <div className="pay-icon"><PayIcon /></div>
              <div className="pay-info">
                <div className="pay-name">{p.name}</div>
                <div className="pay-detail">
                  {p.meta || p.detail} &nbsp;
                  <span className="pay-txn">{p.txn}</span>
                </div>
              </div>
              <div className="pay-right">
                <div className="pay-amount">{p.amount}</div>
                <div className="pay-time">{p.time || "—"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Unmatched section — only if there are any */}
      {!loading && unmatched.length > 0 && (
        <>
          <div className="section-divider">
            <div className="section-divider-line" />
            <div className="section-divider-text">⚠ Unmatched Payments — Action Required</div>
            <div className="section-divider-line" />
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <div>
                <div className="card-title" style={{ color: "var(--amber)" }}>Unmatched M-Pesa Payments</div>
                <div className="card-sub">Could not be linked to a student — please review</div>
              </div>
              <span className="badge badge-unmatched">{unmatched.length} pending</span>
            </div>
            <div className="card-body-flush">
              {unmatched.map((p, i) => (
                <div className="pay-item" key={i}>
                  <div className="pay-icon unmatched"><QuestionIcon /></div>
                  <div className="pay-info">
                    <div className="pay-name" style={{ color: "var(--amber)" }}>Unknown Sender</div>
                    <div className="pay-detail">
                      Phone: {p.phone}&nbsp;
                      <span className="pay-txn" style={{ color: "var(--amber)", borderColor: "var(--amber-border)" }}>
                        {p.txn}
                      </span>
                    </div>
                  </div>
                  <div className="pay-right">
                    <div className="pay-amount" style={{ color: "var(--amber)" }}>{p.amount}</div>
                    <div className="pay-time">{p.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Modal */}
      {showModal && (
        <AddPaymentModal
          onClose={() => setShowModal(false)}
          onAdded={handleAdded}
        />
      )}
    </>
  );
};

export default Payments;
