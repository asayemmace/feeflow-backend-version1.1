import axios from "axios";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3000";

const api = axios.create({
  baseURL: API_BASE,
});

// Attach JWT token to every request automatically
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ff_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const register = async (data) => {
  const res = await api.post("/api/auth/register", data);
  return res.data;
};

export const login = async (data) => {
  const res = await api.post("/api/auth/login", data);
  return res.data;
};

export const getStats = async () => {
  const res = await api.get("/api/stats");
  return res.data;
};

export const getRecentPayments = async () => {
  const res = await api.get("/api/payments/recent");
  return res.data;
};

export const getTopUnpaid = async () => {
  const res = await api.get("/api/students/unpaid");
  return res.data;
};

export default api;
