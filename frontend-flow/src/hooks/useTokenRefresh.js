import { useEffect, useRef } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000";

/**
 * useTokenRefresh — silently refreshes the JWT before it expires.
 *
 * - Decodes the token expiry without a library (just base64 + JSON)
 * - Refreshes automatically when < 7 days remain
 * - Shows a toast warning at 3 days remaining
 * - Does nothing if token is fresh
 *
 * Usage — call once in AppLayout or AuthContext:
 *   useTokenRefresh(token, setToken);
 */
export default function useTokenRefresh(token, setToken, showToast) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (!token) return;

    // Decode JWT payload without a library
    const getExpiry = (t) => {
      try {
        const payload = JSON.parse(atob(t.split(".")[1]));
        return payload.exp ? payload.exp * 1000 : null;
      } catch { return null; }
    };

    const expiry = getExpiry(token);
    if (!expiry) return;

    const now       = Date.now();
    const msLeft    = expiry - now;
    const daysLeft  = Math.floor(msLeft / (1000 * 60 * 60 * 24));

    // Already expired — don't attempt refresh
    if (msLeft <= 0) return;

    // Warn at 3 days remaining
    if (daysLeft <= 3 && showToast) {
      showToast(`Your session expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. You will be logged out soon.`, "warn");
    }

    // Refresh when < 7 days remain
    if (daysLeft < 7) {
      const doRefresh = async () => {
        try {
          const res = await axios.post(`${API}/api/auth/refresh`, {}, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.data?.token) {
            setToken(res.data.token);
            localStorage.setItem("ff_token", res.data.token);
          }
        } catch (e) {
          console.warn("Token refresh failed:", e.message);
        }
      };
      doRefresh();
      return;
    }

    // Schedule a refresh check 7 days before expiry
    const refreshAt = expiry - 7 * 24 * 60 * 60 * 1000;
    const delay     = Math.max(0, refreshAt - now);

    timerRef.current = setTimeout(async () => {
      try {
        const res = await axios.post(`${API}/api/auth/refresh`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.data?.token) {
          setToken(res.data.token);
          localStorage.setItem("ff_token", res.data.token);
        }
      } catch (e) {
        console.warn("Scheduled token refresh failed:", e.message);
      }
    }, delay);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [token]);
}