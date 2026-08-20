/**
 * Pagination — reusable prev/next page control.
 *
 * Usage:
 *   <Pagination page={page} totalPages={totalPages} onChange={setPage} total={total} perPage={PAGE_SIZE} />
 */
export default function Pagination({ page, totalPages, onChange, total, perPage }) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * perPage + 1;
  const to   = Math.min(page * perPage, total);

  const btn = (label, disabled, onClick, active = false) => (
    <button
      key={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px", borderRadius: 7, fontSize: 13, fontWeight: active ? 700 : 500,
        background: active ? "var(--accent)" : "var(--surface2)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        color: active ? "#0b1a14" : disabled ? "var(--text3)" : "var(--text2)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit", minWidth: 34, transition: "all .12s",
        opacity: disabled ? 0.5 : 1,
      }}>
      {label}
    </button>
  );

  // Show max 5 page numbers around current
  const pages = [];
  let start = Math.max(1, page - 2);
  let end   = Math.min(totalPages, start + 4);
  if (end - start < 4) start = Math.max(1, end - 4);
  for (let i = start; i <= end; i++) pages.push(i);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
      <div style={{ fontSize: 12.5, color: "var(--text3)" }}>
        Showing <strong style={{ color: "var(--text2)" }}>{from}–{to}</strong> of <strong style={{ color: "var(--text2)" }}>{total}</strong>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {btn("←", page === 1, () => onChange(page - 1))}
        {start > 1 && <>{btn("1", false, () => onChange(1))}{start > 2 && <span style={{ color: "var(--text3)", fontSize: 13 }}>…</span>}</>}
        {pages.map(p => btn(p, false, () => onChange(p), p === page))}
        {end < totalPages && <>{end < totalPages - 1 && <span style={{ color: "var(--text3)", fontSize: 13 }}>…</span>}{btn(totalPages, false, () => onChange(totalPages))}</>}
        {btn("→", page === totalPages, () => onChange(page + 1))}
      </div>
    </div>
  );
}