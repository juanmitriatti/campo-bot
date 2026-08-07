import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { AuthProvider } from './context/AuthContext';
import { CurrencyProvider } from './context/CurrencyContext';
import ProtectedRoute from './components/ProtectedRoute';

// Auth pages stay eager — they're tiny and almost always the first route a
// signed-out user hits, so we'd rather avoid the lazy-chunk waterfall here.
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';

// Dashboard pulls in recharts + leaflet + all dashboard tabs — keep it lazy
// so the login bundle stays slim. Chat is also heavy enough to split.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Chat = lazy(() => import('./pages/Chat'));
// Formulario estructurado (Telegram Mini App / link) — público, token-authenticated.
const FormPage = lazy(() => import('./pages/FormPage'));

function PageFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CurrencyProvider>
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/form/:token" element={<FormPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute allowedRoles={['end_user']}>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/chat"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <Chat />
              </ProtectedRoute>
            }
          />
        </Routes>
        </Suspense>
        </CurrencyProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
