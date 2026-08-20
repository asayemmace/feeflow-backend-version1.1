import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, AuthProvider } from './contexts/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import AnalyticsPageTracker from './analytics/AnalyticsPageTracker';

import AppLayout    from './layouts/AppLayout';
import Landing      from './pages/Landing';
import Login        from './pages/Login';
import Register     from './pages/Register';
import StaffAcceptInvite from './pages/StaffAcceptInvite';
import AccessDenied    from './pages/AccessDenied';
import TermsPage       from './pages/TermsPage';
import PrivacyPage     from './pages/PrivacyPage';
import Dashboard       from './pages/Dashboard';
import Students         from './pages/Students';
import Payments         from './pages/Payments';
import InvoicesReceipts from './pages/InvoicesReceipts';
import StaffManagement  from './pages/StaffManagement';
import AdminDashboard   from './pages/AdminDashboard';

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

function PermissionRoute({ permission, anyPermissions, children }) {
  const { hasPermission, hasAnyPermission } = useAuth();
  if (permission && !hasPermission(permission)) return <AccessDenied />;
  if (anyPermissions && !hasAnyPermission(anyPermissions)) return <AccessDenied />;
  return children;
}

function AppRoutes() {
  const { user, plan } = useAuth();
  const canAccessStaffManagement = (user?.userType || 'owner') !== 'staff'
    && plan === 'max'
    && (!user?.planExpiry || new Date(user.planExpiry) >= new Date());

  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<GuestRoute><Landing /></GuestRoute>} />
      <Route path="/login"    element={<GuestRoute><Login /></GuestRoute>} />
      <Route path="/register" element={<GuestRoute><Register /></GuestRoute>} />
      <Route path="/staff/accept" element={<StaffAcceptInvite />} />

      {/* Legal — publicly accessible, no auth required */}
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      {/* Protected — all wrapped in AppLayout which renders the sidebar + <Outlet/> */}
      <Route
        element={
          <PrivateRoute>
            <AppLayout />
          </PrivateRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route
          path="/students"
          element={
            <PermissionRoute anyPermissions={["students.view"]}>
              <Students />
            </PermissionRoute>
          }
        />
        <Route
          path="/payments"
          element={
            <PermissionRoute anyPermissions={["payments.view", "reports.view"]}>
              <Payments />
            </PermissionRoute>
          }
        />
        <Route
          path="/invoices"
          element={
            <PermissionRoute anyPermissions={["invoices.view", "receipts.view"]}>
              <InvoicesReceipts />
            </PermissionRoute>
          }
        />
        <Route
          path="/staff-management"
          element={canAccessStaffManagement ? <StaffManagement /> : <AccessDenied />}
        />
        <Route
          path="/admin"
          element={(user?.userType || 'owner') !== 'staff' && user?.isPlatformAdmin ? <AdminDashboard /> : <AccessDenied />}
        />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AnalyticsPageTracker />
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
