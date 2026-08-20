import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import { getAdminOverview, getAdminSubscriptions } from "../api/client";

const fmtKES = (n) =>
  "KES " + Math.round(n || 0).toLocaleString("en-KE");

const StatCard = ({ label, value, sub, accent }) => (
  <div style={{
    background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14,
    padding: "18px 20px", minWidth: 0,
  }}>
    <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {label}
    </div>
    <div style={{ fontSize: 26, fontWeight: 800, color: accent || "var(--text)", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
      {value}
    </div>
    {sub && <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>{sub}</div>}
  </div>
);

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 28 }}>
    <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text2)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {title}
    </h3>
    {children}
  </div>
);

export default function AdminDashboard() {
  const { openSidebar } = useOutletContext();
  const [overview, setOverview] = useState(null);
  const [subs, setSubs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ov, sb] = await Promise.all([getAdminOverview(), getAdminSubscriptions()]);
        if (!cancelled) { setOverview(ov); setSubs(sb); }
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.message || "Could not load admin stats.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Topbar title="Admin" sub="Platform overview" onMenuClick={openSidebar} />

      <div style={{ padding: "20px 24px 60px", maxWidth: 1100 }}>
        {loading && (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: "40px 0", textAlign: "center" }}>
            Loading platform stats…
          </div>
        )}

        {!loading && error && (
          <div style={{
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 10, padding: "14px 16px", color: "#ef4444", fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {!loading && !error && overview && subs && (
          <>
            <Section title="Business overview">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                <StatCard label="Schools" value={overview.totalSchools} sub={`+${overview.newSchoolsThisMonth} this month`} />
                <StatCard label="Students" value={overview.totalStudents.toLocaleString("en-KE")} />
                <StatCard label="New this week" value={overview.newSchoolsThisWeek} sub="Schools signed up" />
              </div>
            </Section>

            <Section title="Subscription revenue (FeeFlow's own)">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 14 }}>
                <StatCard
                  label="MRR"
                  value={fmtKES(subs.mrr)}
                  sub={`${subs.activePayingSchools} active paying schools`}
                  accent="#22d3a4"
                />
                <StatCard label="Revenue this month" value={fmtKES(subs.revenue.thisMonth)} sub={`${subs.revenue.thisMonthCount} payments`} />
                <StatCard label="Revenue all-time" value={fmtKES(subs.revenue.allTime)} sub={`${subs.revenue.allTimeCount} payments`} />
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                {subs.revenue.byPlan.map((p) => (
                  <div key={p.plan} style={{
                    background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10,
                    padding: "10px 14px", fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 700, textTransform: "capitalize" }}>{p.plan}</span>
                    <span style={{ color: "var(--text3)", marginLeft: 8 }}>
                      {fmtKES(p.total)} · {p.count} payments · MRR {fmtKES(subs.mrrByPlan[p.plan] || 0)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Renewals">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                <StatCard
                  label="Expiring in 7 days"
                  value={subs.renewals.expiringIn7Days}
                  accent={subs.renewals.expiringIn7Days > 0 ? "#f59e0b" : undefined}
                />
                <StatCard label="Expiring in 30 days" value={subs.renewals.expiringIn30Days} />
                <StatCard
                  label="Expired, not renewed"
                  value={subs.renewals.expired}
                  accent={subs.renewals.expired > 0 ? "#ef4444" : undefined}
                />
              </div>
            </Section>

            <Section title="Payment funnel">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                <StatCard label="Pending STK pushes" value={subs.funnel.pending} />
                <StatCard label="Failed / abandoned" value={subs.funnel.failedOrAbandoned} />
              </div>
            </Section>
          </>
        )}
      </div>
    </>
  );
}
