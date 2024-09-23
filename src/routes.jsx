import React from 'react';
import { Routes, Route } from 'react-router-dom';

// Layouts
import BlankLayout from './components/layout/blank-layout';
import MainLayout from './components/layout/main-layout';

// Auth Pages
import SignIn from './pages/auth/signin';
import ForgotPassword from './pages/auth/forgot-password';

// Protected Pages
import Dashboard from './pages/dashboard/dashboard';
import Documents from './pages/documents/documents';
import Items from './pages/items'; 

// Components
import ProtectedRoute from './components/auth/protected-route';

import NotFound from './pages/not-found';
import LandingPage from './pages/landing';

const AppRoutes = () => {
  return (
    <Routes>
      {/* Public routes */}
      <Route element={<BlankLayout />}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<SignIn />} />
        <Route path="/password-reset" element={<ForgotPassword />} />
      </Route>

      {/* Protected routes */}
      <Route element={<MainLayout />}>
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
        <Route path="/items" element={<ProtectedRoute><Items /></ProtectedRoute>} />
        <Route path="/items/:groupId" element={<ProtectedRoute><Items /></ProtectedRoute>} />
        <Route path="*" element={<ProtectedRoute><NotFound /></ProtectedRoute>} />
      </Route>
    </Routes>
  );
};

export default AppRoutes;