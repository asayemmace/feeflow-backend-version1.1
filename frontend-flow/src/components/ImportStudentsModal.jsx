import { useState, useRef } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import useAppStore from "../store/useAppStore";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

/**
 * ImportStudentsModal — CSV bulk import for students.
 *
 * Expected CSV columns (case-insensitive, order doesn't matter):
 *   name*, cls, fee*, parentPhone*, parentName, parentEmail, paid
 *   (* required)
 *
 * Usage:
 *   {showImport && <ImportStudentsModal onClose={() => setShowImport(false)} />}
 */
export default function ImportStudentsModal({ onClose }) {
  const { token } = useAuth();
  const bootstrap = useAppStore(s => s.bootstrap);

  const [step,     setStep]     = useState(1); // 1=upload, 2=preview, 3=result
  const [rows,     setRows]     = useState([]);
  const [errors,   setErrors]   = useState([]);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [result,   setResult]   = useState(null);
  const [parseErr, setParseErr] = useState("");
  const fileRef = useRef();

  // ── CSV parser ─────────────────────────────────────────────────────────────
  const parseCSV = (text) => {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return { rows: [], error: "CSV must have a header row and at least one student." };

    const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
    const REQUIRED = ["name", "parentphone"];
    const missing  = REQUIRED.filter(r => !headers.includes(r));
    if (missing.length > 0)
      return { rows: [], error: `Missing required columns: ${missing.join(", ")}. Got: ${headers.join(", ")}` };

    const get = (row, key) => {
      const idx = headers.indexOf(key);
      return idx >= 0 ? (row[idx] || "").trim() : "";
    };

    const parsed = [];
    const rowErrors = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      // Handle quoted fields
      const cols = lines[i].match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || lines[i].split(",");
      const clean = cols.map(c => c.replace(/^"|"$/g, "").trim());

      const name        = get(clean, "name");
      const parentPhone = get(clean, "parentphone");
      const fee         = parseFloat(get(clean, "fee")) || 0;

      if (!name) { rowErrors.push({ row: i, reason: "Missing student name" }); continue; }
      if (!parentPhone) { rowErrors.push({ row: i, reason: `Row ${i}: Missing parent phone for ${name}` }); continue; }

      parsed.push({
        name,
        cls:         get(clean, "cls") || get(clean, "class") || "",
        fee,
        paid:        parseFloat(get(clean, "paid")) || 0,
        parentPhone,
        parentName:  get(clean, "parentname")  || "",
        parentEmail: get(clean, "parentemail") || "",
      });
    }
    return { rows: parsed, errors: rowErrors };
  };

  const handleFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    setParseErr("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const { rows: parsed, errors: rowErrs, error } = parseCSV(e.target.result);
      if (error) { setParseErr(error); return; }
      setRows(parsed);
      setErrors(rowErrs || []);
      setStep(2);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (rows.length === 0) return;
    setImporting(true);
    try {
      const res = await axios.post(`${API}/api/students/import`, { students: rows }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setResult(res.data);
      setStep(3);
      // Refresh store so Students page shows imported students immediately
      await bootstrap(token);
    } catch (e) {
      setParseErr(e.response?.data?.message || "Import failed. Please try again.");
    } finally { setImporting(false); }
  };

  const downloadTemplate = () => {
    const csv = "name,cls,fee,parentPhone,parentName,parentEmail,paid\nJohn Doe,Form 1,15000,0712345678,Jane Doe,jane@email.com,0\nMary Wanjiru,Form 2,18000,0723456789,Peter Wanjiru,,5000";
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "feeflow_students_template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const inp = { width: "100%", padding: "10px 12px", background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 8, color: "var(--text)", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", zIndex: 60, transform: "translate(-50%,-50%)", width: "100%", maxWidth: 540, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", maxHeight: "85vh", animation: "modalIn .18s ease" }}>

        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {step === 1 ? "Import Students from CSV" : step === 2 ? `Preview — ${rows.length} students` : "Import Complete"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>
              {step === 1 ? "Bulk-add students from a spreadsheet" : step === 2 ? "Review before importing" : ""}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text2)", fontSize: 16 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>

          {/* ── Step 1: Upload ── */}
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Drop zone */}
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                style={{ border: "2px dashed var(--border2)", borderRadius: 12, padding: "36px 20px", textAlign: "center", cursor: "pointer", transition: "border-color .15s" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
                onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border2)"}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>📂</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                  {fileName || "Click to upload or drag & drop"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)" }}>CSV files only · Max 500 students</div>
                <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
              </div>

              {parseErr && (
                <div style={{ background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 9, padding: "12px 14px", fontSize: 12.5, color: "var(--red)" }}>
                  ✕ {parseErr}
                </div>
              )}

              {/* Column guide */}
              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10 }}>Required CSV Columns</div>
                {[
                  ["name", "Student full name", true],
                  ["cls", "Class (e.g. Form 1)", false],
                  ["fee", "Term fee amount", false],
                  ["parentPhone", "Parent mobile number", true],
                  ["parentName", "Parent/guardian name", false],
                  ["parentEmail", "Parent email", false],
                  ["paid", "Amount already paid", false],
                ].map(([col, desc, req]) => (
                  <div key={col} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, background: req ? "var(--green-bg)" : "var(--surface3)", border: `1px solid ${req ? "var(--green-border)" : "var(--border)"}`, color: req ? "var(--green)" : "var(--text3)", padding: "2px 8px", borderRadius: 5, minWidth: 100 }}>{col}</span>
                    <span style={{ fontSize: 12, color: "var(--text3)" }}>{desc}</span>
                    {req && <span style={{ fontSize: 10, color: "var(--green)", fontWeight: 700 }}>REQUIRED</span>}
                  </div>
                ))}
              </div>

              <button onClick={downloadTemplate} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 12.5, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
                📥 Download template CSV
              </button>
            </div>
          )}

          {/* ── Step 2: Preview ── */}
          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {errors.length > 0 && (
                <div style={{ background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 9, padding: "12px 14px" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--amber)", marginBottom: 6 }}>⚠ {errors.length} row(s) will be skipped</div>
                  {errors.slice(0, 5).map((e, i) => <div key={i} style={{ fontSize: 12, color: "var(--amber)" }}>Row {e.row}: {e.reason}</div>)}
                  {errors.length > 5 && <div style={{ fontSize: 12, color: "var(--amber)" }}>…and {errors.length - 5} more</div>}
                </div>
              )}

              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", background: "var(--surface2)", borderBottom: "1px solid var(--border)", display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.5fr", gap: 8, fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.7 }}>
                  <span>Name</span><span>Class</span><span>Fee</span><span>Phone</span>
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                  {rows.map((r, i) => (
                    <div key={i} style={{ padding: "9px 14px", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none", display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.5fr", gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                      <span style={{ color: "var(--text3)" }}>{r.cls || "—"}</span>
                      <span style={{ color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>{r.fee ? r.fee.toLocaleString() : "—"}</span>
                      <span style={{ color: "var(--text3)", fontFamily: "monospace", fontSize: 11.5 }}>{r.parentPhone}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "var(--text3)" }}>Students to import</span>
                <span style={{ fontWeight: 700, color: "var(--green)" }}>{rows.length}</span>
              </div>

              {parseErr && (
                <div style={{ background: "var(--red-bg)", border: "1px solid var(--red-border)", borderRadius: 9, padding: "12px 14px", fontSize: 12.5, color: "var(--red)" }}>✕ {parseErr}</div>
              )}
            </div>
          )}

          {/* ── Step 3: Result ── */}
          {step === 3 && result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 48 }}>{result.skipped === 0 ? "✅" : "⚠️"}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Import complete</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, width: "100%" }}>
                <div style={{ background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 10, padding: "14px", textAlign: "center" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "var(--green)" }}>{result.imported}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Imported</div>
                </div>
                <div style={{ background: result.skipped > 0 ? "var(--amber-bg)" : "var(--surface2)", border: `1px solid ${result.skipped > 0 ? "var(--amber-border)" : "var(--border)"}`, borderRadius: 10, padding: "14px", textAlign: "center" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: result.skipped > 0 ? "var(--amber)" : "var(--text3)" }}>{result.skipped}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Skipped</div>
                </div>
              </div>
              {result.errors?.length > 0 && (
                <div style={{ width: "100%", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text3)", marginBottom: 6 }}>Skipped rows:</div>
                  {result.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: "var(--amber)" }}>Row {e.row}: {e.reason}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10, flexShrink: 0 }}>
          {step < 3
            ? <button onClick={() => step === 1 ? onClose() : setStep(1)} style={{ padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text2)", cursor: "pointer", fontFamily: "inherit" }}>
                {step === 1 ? "Cancel" : "← Back"}
              </button>
            : <div />
          }
          {step === 1 && rows.length > 0 && (
            <button onClick={() => setStep(2)} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "var(--accent)", border: "none", color: "#0b1a14", cursor: "pointer", fontFamily: "inherit" }}>
              Preview {rows.length} students →
            </button>
          )}
          {step === 2 && (
            <button onClick={handleImport} disabled={importing || rows.length === 0} style={{ padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: importing ? "var(--surface2)" : "var(--accent)", border: "none", color: importing ? "var(--text3)" : "#0b1a14", cursor: importing ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {importing ? "Importing…" : `Import ${rows.length} students ✓`}
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