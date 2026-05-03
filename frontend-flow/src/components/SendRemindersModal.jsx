import { useState, useEffect } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

/**
 * SendRemindersModal — sends bulk SMS reminders to parents of students
 * with outstanding fee balances.
 *
 * Usage:
 *   {showReminders && <SendRemindersModal onClose={() => setShowReminders(false)} />}
 */
export default function SendRemindersModal({ onClose }) {
  const { token } = useAuth();

  const [step,         setStep]         = useState(1); // 1=config, 2=preview, 3=result
  const [daysMin,      setDaysMin]      = useState(0);
  const [customMsg,    setCustomMsg]    = useState("");
  const [preview,      setPreview]      = useState(null);
  const [loadingPrev,  setLoadingPrev]  = useState(false);
  const [sending,      setSending]      = useState(false);
  const [result,       setResult]       = useState(null);
  const [error,        setError]        = useState("");

  // Load preview whenever daysMin changes
  useEffect(() => {
    if (step !== 1) return;
    setLoadingPrev(true);
    axios.get(`${API}/api/reminders/preview?daysOverdueMin=${daysMin}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => setPreview(r.data))
      .catch(() => setPreview(null))
      .finally(() => setLoadingPrev(false));
  }, [daysMin, token, step]);

  const handleSend = async () => {
    setSending(true);
    setError("");
    try {
      const res = await axios.post(`${API}/api/reminders/send`, {
        daysOverdueMin: daysMin,
        message: customMsg.trim() || undefined,
      }, { headers: { Authorization: `Bearer ${token}` } });
      setResult(res.data);
      setStep(3);
    } catch (e) {
      setError(e.response?.data?.message || "Failed to send reminders. Please try again.");
    } finally { setSending(false); }
  };

  const badge = (label, value, color = "var(--text3)") => (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>{label}</div>
    </div>
  );

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 500, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", maxHeight: "85vh", animation: "modalIn .18s ease" }}>

        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {step === 1 ? "Send Fee Reminders" : step === 2 ? "Confirm Send" : "Reminders Sent"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>
              {step === 1 ? "SMS all parents with outstanding balances" : ""}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 16 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>

          {/* ── Step 1: Configure ── */}
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

              {/* Preview counters */}
              {loadingPrev ? (
                <div style={{ textAlign: "center", padding: 20, color: "var(--text3)", fontSize: 13 }}>Loading preview…</div>
              ) : preview && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  {badge("Total unpaid", preview.total, "var(--red)")}
                  {badge("Have phone", preview.withPhone, "var(--amber)")}
                  {badge("Will receive SMS", preview.withPhone, "var(--green)")}
                </div>
              )}

              {/* Days overdue filter */}
              <div>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text2)", display: "block", marginBottom: 8 }}>
                  Only send to students overdue by at least
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[
                    [0, "Any balance"],
                    [3, "3+ days"],
                    [7, "7+ days"],
                    [14, "14+ days"],
                    [30, "30+ days"],
                  ].map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => setDaysMin(val)}
                      style={{
                        padding: "7px 14px", borderRadius: 8, fontSize: 12.5, cursor: "pointer",
                        fontFamily: "inherit", fontWeight: daysMin === val ? 700 : 400,
                        background: daysMin === val ? "var(--accent)" : "var(--surface2)",
                        border: `1px solid ${daysMin === val ? "var(--accent)" : "var(--border)"}`,
                        color: daysMin === val ? "#0b1a14" : "var(--text2)",
                        transition: "all .15s",
                      }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom message */}
              <div>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text2)", display: "block", marginBottom: 6 }}>
                  Custom message suffix <span style={{ fontWeight: 400, color: "var(--text3)" }}>(optional)</span>
                </label>
                <textarea
                  value={customMsg}
                  onChange={e => setCustomMsg(e.target.value)}
                  maxLength={120}
                  rows={3}
                  placeholder="e.g. Please visit the office by Friday to avoid late penalties."
                  style={{ width: "100%", padding: "10px 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" }}
                />
                <div style={{ fontSize: 11, color: "var(--text3)", textAlign: "right", marginTop: 3 }}>{customMsg.length}/120</div>
              </div>

              {/* Message preview */}
              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8 }}>Message preview</div>
                <div style={{ fontSize: 12.5, color: "var(--text2)", lineHeight: 1.7 }}>
                  FeeFlow | <em>Your School</em>: Dear parent, <em>Student Name</em> (Term 1) has an outstanding fee balance of KES <em>X,XXX</em>.{" "}
                  {customMsg.trim() || "Please settle at your earliest convenience."}{" "}
                  For queries contact <em>Your School</em> administration.
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Confirm ── */}
          {step === 2 && preview && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 10, padding: "16px", textAlign: "center" }}>
                <div style={{ fontSize: 32, fontWeight: 800, color: "var(--amber)" }}>{preview.withPhone}</div>
                <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 4 }}>
                  SMS messages will be sent immediately
                </div>
              </div>

              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "var(--text2)", lineHeight: 1.8 }}>
                <div><strong style={{ color: "var(--text)" }}>Filter:</strong> {daysMin === 0 ? "Any outstanding balance" : `Overdue ${daysMin}+ days`}</div>
                <div><strong style={{ color: "var(--text)" }}>Recipients:</strong> {preview.withPhone} parents with phone numbers</div>
                <div><strong style={{ color: "var(--text)" }}>Skipped:</strong> {preview.total - preview.withPhone} students without phone numbers</div>
                {customMsg && <div><strong style={{ color: "var(--text)" }}>Custom msg:</strong> {customMsg}</div>}
              </div>

              {error && (
                <div style={{ background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 9, padding: "12px 14px", fontSize: 12.5, color: "var(--red)" }}>✕ {error}</div>
              )}
            </div>
          )}

          {/* ── Step 3: Result ── */}
          {step === 3 && result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 48 }}>{result.failed === 0 ? "✅" : "⚠️"}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                {result.failed === 0 ? "All reminders sent!" : "Reminders sent with some failures"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, width: "100%" }}>
                <div style={{ background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 10, padding: 14, textAlign: "center" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "var(--green)" }}>{result.sent}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Sent successfully</div>
                </div>
                <div style={{ background: result.failed > 0 ? "var(--red-bg)" : "var(--surface2)", border: `1px solid ${result.failed > 0 ? "var(--red-border)" : "var(--border)"}`, borderRadius: 10, padding: 14, textAlign: "center" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: result.failed > 0 ? "var(--red)" : "var(--text3)" }}>{result.failed}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Failed</div>
                </div>
              </div>
              {result.failed > 0 && (
                <div style={{ fontSize: 12.5, color: "var(--text3)", textAlign: "center" }}>
                  Failed messages are usually due to invalid or blacklisted phone numbers.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10, flexShrink: 0 }}>
          {step < 3 ? (
            <button onClick={() => step === 1 ? onClose() : setStep(1)} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
              {step === 1 ? "Cancel" : "← Back"}
            </button>
          ) : <div />}

          {step === 1 && (
            <button
              onClick={() => setStep(2)}
              disabled={!preview || preview.withPhone === 0}
              style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: !preview || preview.withPhone === 0 ? "var(--surface2)" : "var(--accent)", border: "none", color: !preview || preview.withPhone === 0 ? "var(--text3)" : "#0b1a14", cursor: !preview || preview.withPhone === 0 ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {preview ? `Review — ${preview.withPhone} recipients →` : "Loading…"}
            </button>
          )}

          {step === 2 && (
            <button onClick={handleSend} disabled={sending} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: sending ? "var(--surface2)" : "var(--red, #ef4444)", border: "none", color: sending ? "var(--text3)" : "#fff", cursor: sending ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {sending ? "Sending…" : `Send ${preview?.withPhone} reminders`}
            </button>
          )}

          {step === 3 && (
            <button onClick={onClose} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "var(--accent)", border: "none", color: "#0b1a14", cursor: "pointer", fontFamily: "inherit" }}>
              Done
            </button>
          )}
        </div>
      </div>
      <style>{`@keyframes modalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}`}</style>
    </>
  );
}