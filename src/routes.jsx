import React from 'react';
import { Routes, Route } from 'react-router-dom';

// Layouts
import BlankLayout from './components/layout/blank-layout';
import MainLayout from './components/layout/main-layout';

// Auth Pages
import SignIn from './pages/auth/signin';
import ForgotPassword from './pages/auth/forgot-password';

// Protected Pages
import Dashboard from './pages/dashboard';

// Components
import ProtectedRoute from './components/auth/protected-route';

import NotFound from './pages/not-found';

const AppRoutes = () => {
  return (
    <Routes>
      {/* Public routes */}
      <Route element={<BlankLayout />}>
        <Route path="/login" element={<SignIn />} />
        <Route path="/password-reset" element={<ForgotPassword />} />

      </Route>

      {/* Protected routes */}
      <Route element={<MainLayout />}>
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="*" element={<ProtectedRoute><NotFound /></ProtectedRoute>} />
      </Route>

    </Routes>
  );
};

export default AppRoutes;