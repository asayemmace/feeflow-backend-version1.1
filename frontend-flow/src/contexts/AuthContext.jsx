import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import analytics from '../analytics/analytics';

const AuthContext = createContext(null);
const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Session protection config ─────────────────────────────────────────────────
const INACTIVITY_MS   = 8 * 60 * 60 * 1000; // 8 hours idle → auto-logout
const LAST_ACTIVE_KEY = 'ff_last_active';

// Decode JWT expiry without a library
function getTokenExpiry(t) {
  try { const p = JSON.parse(atob(t.split('.')[1])); return p.exp ? p.exp * 1000 : null; }
  catch { return null; }
}

// Wipe all session data from localStorage
function clearLocalSession() {
  localStorage.removeItem('ff_token');
  localStorage.removeItem('ff_user');
  localStorage.removeItem(LAST_ACTIVE_KEY);
}

// ── On page load: validate token BEFORE React renders the app ─────────────────
// This is what prevents "go straight to Dashboard on every visit".
// Runs synchronously inside the useState initialiser so it fires before
// any route guard or component tree is evaluated.
function getInitialToken() {
  const t = localStorage.getItem('ff_token');
  if (!t) return null;

  // 1. JWT is structurally expired
  const expiry = getTokenExpiry(t);
  if (expiry && Date.now() >= expiry) {
    clearLocalSession();
    return null;
  }

  // 2. User has been inactive for longer than INACTIVITY_MS since last visit
  const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || '0', 10);
  if (lastActive > 0 && Date.now() - lastActive > INACTIVITY_MS) {
    clearLocalSession();
    return null;
  }

  return t;
}

function getInitialUser() {
  // Only parse user if the token survived the checks above
  if (!localStorage.getItem('ff_token')) return null;
  try { return JSON.parse(localStorage.getItem('ff_user')) || null; }
  catch { return null; }
}

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(getInitialToken);
  const [user,  setUser]  = useState(getInitialUser);
  const [theme, setTheme] = useState(() => localStorage.getItem('ff_theme') || 'dark');

  // ── Central logout — used internally and exposed to callers ──────────────
  const logout = useCallback(() => {
    analytics.track('logout');
    analytics.reset();
    clearLocalSession();
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  }, []);

  const refreshUser = useCallback(async ({ silent = false, tokenOverride = null } = {}) => {
    const activeToken = tokenOverride || token || localStorage.getItem('ff_token');
    if (!activeToken) return null;
    try {
      const res = await axios.get(`${API}/api/auth/me`, {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (res.data) {
        setUser(res.data);
        localStorage.setItem('ff_user', JSON.stringify(res.data));
        window.dispatchEvent(new Event('ff:user-updated'));
      }
      return res.data;
    } catch (e) {
      if (e.response?.status === 401) logout();
      if (!silent) throw e;
      return null;
    }
  }, [token, logout]);

  // ── Axios header sync ─────────────────────────────────────────────────────
  useEffect(() => {
    if (token) axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    else delete axios.defaults.headers.common['Authorization'];
  }, [token]);

  useEffect(() => {
    if (token && user) analytics.identify(user);
  }, [token, user]);

  // LocalStorage gives an instant first paint, but the server is the source of
  // truth for plan changes, plan expiry, staff permissions, and feature flags.
  useEffect(() => {
    if (!token) return;
    refreshUser({ silent: true });
  }, [token, refreshUser]);

  useEffect(() => {
    const syncUserFromStorage = () => {
      try {
        const stored = JSON.parse(localStorage.getItem('ff_user')) || null;
        setUser(stored);
      } catch {}
    };
    window.addEventListener('ff:user-updated', syncUserFromStorage);
    return () => window.removeEventListener('ff:user-updated', syncUserFromStorage);
  }, []);

  useEffect(() => {
    if (!token) return;
    const syncFreshPlan = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      refreshUser({ silent: true });
    };
    window.addEventListener('focus', syncFreshPlan);
    document.addEventListener('visibilitychange', syncFreshPlan);
    return () => {
      window.removeEventListener('focus', syncFreshPlan);
      document.removeEventListener('visibilitychange', syncFreshPlan);
    };
  }, [token, refreshUser]);

  // ── Axios 401 interceptor — any rejected auth call → auto-logout ──────────
  // Catches tokens that expire while a tab is left open (e.g. open overnight).
  useEffect(() => {
    const id = axios.interceptors.response.use(
      res => res,
      async err => {
        if (err.response?.status === 401) logout();
        analytics.track('api_request_failed', {
          status: err.response?.status || null,
          method: err.config?.method || null,
          path: err.config?.url ? new URL(err.config.url, API).pathname : null,
        });
        if (err.response?.status === 403 && err.response?.data?.upgradeRequired) {
          const fresh = await refreshUser({ silent: true });
          if (fresh) err.response.data.refreshedUser = fresh;
          const feature = err.response.data.feature;
          const freshFeature = feature && fresh?.features?.[feature];
          const planAllows = freshFeature === true || freshFeature === null || (typeof freshFeature === 'number' && freshFeature > 0);
          if (planAllows && !err.config?.__planRetry) {
            err.config.__planRetry = true;
            return axios(err.config);
          }
        }
        return Promise.reject(err);
      }
    );
    return () => axios.interceptors.response.eject(id);
  }, [logout, refreshUser]);

  // ── Theme ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ff_theme', theme);
  }, [theme]);

  // ── Inactivity timeout ────────────────────────────────────────────────────
  // Every user interaction stamps ff_last_active. On the next page open,
  // getInitialToken() compares it against INACTIVITY_MS and clears the session
  // if too much time has passed. The live timer handles tabs left open.
  const inactivityTimer = useRef(null);

  const resetInactivityTimer = useCallback(() => {
    localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString());
    clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(logout, INACTIVITY_MS);
  }, [logout]);

  useEffect(() => {
    if (!token) return;
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach(e => window.addEventListener(e, resetInactivityTimer, { passive: true }));
    resetInactivityTimer(); // stamp activity immediately on login / page load
    return () => {
      events.forEach(e => window.removeEventListener(e, resetInactivityTimer));
      clearTimeout(inactivityTimer.current);
    };
  }, [token, resetInactivityTimer]);

  // ── Token refresh — silently renew when < 7 days remain ──────────────────
  // Mirrors useTokenRefresh so AuthContext fully owns session lifecycle.
  // useTokenRefresh in AppLayout can safely remain — it will just no-op
  // since this block fires first and keeps the token fresh.
  const refreshTimerRef = useRef(null);

  useEffect(() => {
    if (!token) return;
    const expiry  = getTokenExpiry(token);
    if (!expiry) return;
    const msLeft   = expiry - Date.now();
    const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
    if (msLeft <= 0) return;

    const doRefresh = async () => {
      try {
        const res = await axios.post(`${API}/api/auth/refresh`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.data?.token) {
          localStorage.setItem('ff_token', res.data.token);
          setToken(res.data.token);
          if (res.data.user) {
            setUser(res.data.user);
            localStorage.setItem('ff_user', JSON.stringify(res.data.user));
            window.dispatchEvent(new Event('ff:user-updated'));
          }
        }
      } catch (e) { console.warn('Token refresh failed:', e.message); }
    };

    if (daysLeft < 7) { doRefresh(); return; }

    const delay = Math.max(0, expiry - 7 * 24 * 60 * 60 * 1000 - Date.now());
    refreshTimerRef.current = setTimeout(doRefresh, delay);
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [token]);

  // ── Session helpers ───────────────────────────────────────────────────────
  const saveSession = (tok, usr) => {
    localStorage.setItem('ff_token', tok);
    localStorage.setItem('ff_user', JSON.stringify(usr));
    localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString());
    setToken(tok);
    setUser(usr);
    axios.defaults.headers.common['Authorization'] = `Bearer ${tok}`;
    window.dispatchEvent(new Event('ff:user-updated'));
  };

  const register = async () => {
    throw new Error("Direct registration is disabled. Please verify your email first.");
  };

  const startRegistration = async (email) => {
    const res = await axios.post(`${API}/api/auth/start-registration`, { email });
    return res.data;
  };

  const verifyRegistrationToken = async (token) => {
    const res = await axios.get(`${API}/api/auth/verify-registration-token`, { params: { token } });
    return res.data;
  };

  const completeRegistration = async ({ token, name, schoolName, password }) => {
    const res = await axios.post(`${API}/api/auth/complete-registration`, { token, name, schoolName, password });
    if (res.data?.token) {
      saveSession(res.data.token, res.data.user);
      analytics.identify(res.data.user);
      analytics.track('email_verified');
      analytics.track('signup_completed', {
        schoolName: res.data.user?.schoolName || schoolName,
        plan: res.data.user?.plan || 'free',
      });
      analytics.track('school_setup_completed', {
        schoolName: res.data.user?.schoolName || schoolName,
      });
    }
    return res.data;
  };

  const login = async (email, password) => {
    const res = await axios.post(`${API}/api/auth/login`, { email, password });
    saveSession(res.data.token, res.data.user);
    analytics.identify(res.data.user);
    analytics.track('login', {
      role: res.data.user?.userType || res.data.user?.role || 'owner',
      plan: res.data.user?.plan || 'free',
      schoolName: res.data.user?.schoolName || null,
    });
    return res.data;
  };

  const updateUser = (updates) => {
    const merged = { ...user, ...updates };
    setUser(merged);
    localStorage.setItem('ff_user', JSON.stringify(merged));
    window.dispatchEvent(new Event('ff:user-updated'));
  };

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  const PLAN_LIMITS = {
    free: { mpesa: false, invoices: false, receipts: false, students: 300 },
    pro:  { mpesa: true,  invoices: true,  receipts: false, students: 800 },
    max:  { mpesa: true,  invoices: true,  receipts: true,  students: Infinity },
  };

  const plan = user?.plan || 'free';
  const canUse = (feature) => {
    if (user?.features && Object.prototype.hasOwnProperty.call(user.features, feature)) {
      const value = user.features[feature];
      if (feature === 'students') return value === null ? Infinity : value;
      return value;
    }
    return PLAN_LIMITS[plan]?.[feature] ?? false;
  };
  const hasPermission = (permission) => {
    if (!user) return false;
    if ((user.userType || 'owner') === 'owner') return true;
    return Array.isArray(user.permissions) && user.permissions.includes(permission);
  };
  const hasAnyPermission = (permissions = []) => permissions.some(hasPermission);

  return (
    <AuthContext.Provider value={{
      token, user, plan,
      login, register, startRegistration, verifyRegistrationToken, completeRegistration, logout, updateUser, refreshUser,
      canUse, hasPermission, hasAnyPermission, theme, toggleTheme,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
