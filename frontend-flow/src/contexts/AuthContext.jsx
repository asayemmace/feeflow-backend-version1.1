import { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser]       = useState(null);
  const [token, setToken]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme]     = useState('dark');

  // Restore session on mount
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem('ff_token');
      const savedUser  = localStorage.getItem('ff_user');
      const savedTheme = localStorage.getItem('ff_theme') || 'dark';

      if (savedToken && savedUser) {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
        axios.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`;
      }

      setTheme(savedTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    } catch (error) {
      console.error('Error restoring session:', error);
      // Clear corrupted data
      localStorage.removeItem('ff_token');
      localStorage.removeItem('ff_user');
    } finally {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const res = await axios.post(`${API_BASE}/api/auth/login`, { email, password });
    const { token: t, user: u } = res.data;
    localStorage.setItem('ff_token', t);
    localStorage.setItem('ff_user', JSON.stringify(u));
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
    setToken(t);
    setUser(u);
    return u;
  };

  const register = async (name, email, password, schoolName) => {
    const res = await axios.post(`${API_BASE}/api/auth/register`, { name, email, password, schoolName });
    const { token: t, user: u } = res.data;
    localStorage.setItem('ff_token', t);
    localStorage.setItem('ff_user', JSON.stringify(u));
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
    setToken(t);
    setUser(u);
    return u;
  };

  const logout = () => {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    delete axios.defaults.headers.common['Authorization'];
    setToken(null);
    setUser(null);
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('ff_theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, theme, login, register, logout, toggleTheme }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
