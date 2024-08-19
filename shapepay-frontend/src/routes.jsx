import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Layouts
import BlankLayout from './components/layout/blank-layout';
import MainLayout from './components/layout/main-layout';

// Auth Pages
import SignIn from './pages/auth/signin';
import SignUp from './pages/auth/signup';
import AcceptInvite from './pages/auth/accept-invite';

// Protected Pages
import Dashboard from './pages/dashboard/dashboard';
import Customers from './pages/customers';
import APIKeys from './pages/apikeys';
import Webhooks from './pages/webhooks';
import Payments from './pages/payments/payments';
import Refunds from './pages/refunds';
import PaymentPage from './pages/payments/customer-payments';
import SettingsPage from './pages/settings';

// Components
import ProtectedRoute from './components/auth/protected-route';
import PayoutsPage from './pages/payouts';

const AppRoutes = () => {
  return (
    <Routes>
      {/* Public routes */}
      <Route element={<BlankLayout />}>
        <Route path="/login" element={<SignIn />} />
        <Route path="/signup" element={<SignUp />} />
        <Route path="/pay/:merchantId" element={<PaymentPage />} />
        <Route path="/accept-invite/:token" element={<ProtectedRoute><AcceptInvite /></ProtectedRoute>} />
      </Route>

      {/* Protected routes */}
      <Route element={<MainLayout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/customers" element={<ProtectedRoute><Customers /></ProtectedRoute>} />
        <Route path="/apikeys" element={<ProtectedRoute><APIKeys /></ProtectedRoute>} />
        <Route path="/webhooks" element={<ProtectedRoute><Webhooks /></ProtectedRoute>} />
        <Route path="/payments" element={<ProtectedRoute><Payments /></ProtectedRoute>} />
        <Route path="/refunds" element={<ProtectedRoute><Refunds /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        <Route path="/payouts" element={<ProtectedRoute><PayoutsPage /></ProtectedRoute>} />

      </Route>

      {/* Catch-all route */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
};

export default AppRoutes;