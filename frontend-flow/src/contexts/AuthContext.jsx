import { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);
const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => localStorage.getItem('ff_token') || null);
  const [user,  setUser]  = useState(() => {
    try { return JSON.parse(localStorage.getItem('ff_user')) || null; }
    catch { return null; }
  });
  const [theme, setTheme] = useState(() => localStorage.getItem('ff_theme') || 'dark');

  useEffect(() => {
    if (token) axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    else delete axios.defaults.headers.common['Authorization'];
  }, [token]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ff_theme', theme);
  }, [theme]);

  // ── Token refresh — silently renew when < 7 days remain ──────────────────
  const refreshTimerRef = useRef(null);

  useEffect(() => {
    if (!token) return;
    const getExpiry = (t) => {
      try { const p = JSON.parse(atob(t.split(".")[1])); return p.exp ? p.exp * 1000 : null; }
      catch { return null; }
    };
    const expiry = getExpiry(token);
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
          }
        }
      } catch (e) { console.warn('Token refresh failed:', e.message); }
    };

    if (daysLeft < 7) {
      doRefresh();
      return;
    }
    // Schedule refresh 7 days before expiry
    const delay = Math.max(0, expiry - 7 * 24 * 60 * 60 * 1000 - Date.now());
    refreshTimerRef.current = setTimeout(doRefresh, delay);
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [token]);

  const saveSession = (tok, usr) => {
    localStorage.setItem('ff_token', tok);
    localStorage.setItem('ff_user', JSON.stringify(usr));
    setToken(tok);
    setUser(usr);
    axios.defaults.headers.common['Authorization'] = `Bearer ${tok}`;
  };

  const register = async (name, email, password, schoolName) => {
    const res = await axios.post(`${API}/api/auth/register`, { name, email, password, schoolName });
    saveSession(res.data.token, res.data.user);
    return res.data;
  };

  const login = async (email, password) => {
    const res = await axios.post(`${API}/api/auth/login`, { email, password });
    saveSession(res.data.token, res.data.user);
    return res.data;
  };

  // logout clears session — navigation to '/' is handled by the caller
  const logout = () => {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  const updateUser = (updates) => {
    const merged = { ...user, ...updates };
    setUser(merged);
    localStorage.setItem('ff_user', JSON.stringify(merged));
  };

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  const plan = user?.plan || 'free';

  const PLAN_LIMITS = {
    free: { mpesa: false, invoices: false, receipts: false, students: 300 },
    pro:  { mpesa: true,  invoices: true,  receipts: false, students: 800 },
    max:  { mpesa: true,  invoices: true,  receipts: true,  students: Infinity },
  };

  const canUse = (feature) => PLAN_LIMITS[plan]?.[feature] ?? false;

  return (
    <AuthContext.Provider value={{
      token, user, plan,
      login, register, logout, updateUser,
      canUse, theme, toggleTheme,
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