import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, AuthProvider } from './contexts/AuthContext';

import AppLayout    from './layouts/AppLayout';
import Landing      from './pages/Landing';
import Login        from './pages/Login';
import Register     from './pages/Register';
import TermsPage    from './pages/TermsPage';
import Dashboard        from './pages/Dashboard';
import Students         from './pages/Students';
import Payments         from './pages/Payments';
import InvoicesReceipts from './pages/InvoicesReceipts';

// Redirects to /login if not logged in
function PrivateRoute({ children }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

// Redirects to /dashboard if already logged in
function GuestRoute({ children }) {
  const { token } = useAuth();
  if (token) return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<GuestRoute><Landing /></GuestRoute>} />
      <Route path="/login"    element={<GuestRoute><Login /></GuestRoute>} />
      <Route path="/register" element={<GuestRoute><Register /></GuestRoute>} />

      {/* Terms — publicly accessible, no auth required */}
      <Route path="/terms" element={<TermsPage />} />

      {/* Protected — all wrapped in AppLayout which renders the sidebar + <Outlet/> */}
      <Route
        element={
          <PrivateRoute>
            <AppLayout />
          </PrivateRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/students"  element={<Students />} />
        <Route path="/payments"  element={<Payments />} />
        <Route path="/invoices"  element={<InvoicesReceipts />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}