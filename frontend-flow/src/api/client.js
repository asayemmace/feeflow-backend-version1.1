import axios from "axios";
import analytics from "../analytics/analytics";

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

api.interceptors.response.use(
  res => res,
  async err => {
    analytics.track('api_request_failed', {
      status: err.response?.status || null,
      method: err.config?.method || null,
      path: err.config?.url || null,
    });

    if (err.response?.status === 403 && err.response?.data?.upgradeRequired && !err.config?.__planRetry) {
      const token = localStorage.getItem('ff_token');
      if (token) {
        try {
          const me = await api.get('/api/auth/me');
          localStorage.setItem('ff_user', JSON.stringify(me.data));
          window.dispatchEvent(new Event('ff:user-updated'));
          const feature = err.response.data.feature;
          const value = feature && me.data?.features?.[feature];
          const planAllows = value === true || value === null || (typeof value === 'number' && value > 0);
          if (planAllows) {
            err.config.__planRetry = true;
            return api(err.config);
          }
        } catch {
          // Keep the original 403 response when the plan refresh cannot be completed.
        }
      }
    }
    return Promise.reject(err);
  }
);

export const register = async (data) => {
  const res = await api.post("/api/auth/register", data);
  return res.data;
};

export const login = async (data) => {
  const res = await api.post("/api/auth/login", data);
  return res.data;
};

export const verifyStaffInvite = async (token) => {
  const res = await api.get(`/api/staff/invite/verify?token=${encodeURIComponent(token)}`);
  return res.data;
};

export const acceptStaffInvite = async (data) => {
  const res = await api.post("/api/staff/accept-invite", data);
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

export const getAdminOverview = async () => {
  const res = await api.get("/api/admin/stats/overview");
  return res.data;
};

export const getAdminSubscriptions = async () => {
  const res = await api.get("/api/admin/subscriptions");
  return res.data;
};

export default api;
