import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import analytics from "./analytics";

const TITLE_BY_PATH = {
  "/": "FeeFlow",
  "/login": "Login",
  "/register": "Register",
  "/dashboard": "Dashboard",
  "/students": "Students",
  "/payments": "Payments",
  "/invoices": "Invoices & Receipts",
  "/staff-management": "Staff Management",
  "/staff/accept": "Accept Staff Invite",
  "/terms": "Terms",
  "/privacy": "Privacy",
};

export default function AnalyticsPageTracker() {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;
    const title = TITLE_BY_PATH[path] || document.title || "FeeFlow";
    analytics.page(path, title);
  }, [location.pathname, location.search]);

  return null;
}
