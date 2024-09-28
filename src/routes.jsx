import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Layouts
import BlankLayout from './components/layout/blank-layout';
import MainLayout from './components/layout/main-layout';

// Auth Pages
import SignIn from './pages/auth/signin';
import SignUp from './pages/auth/signup';
import ForgotPassword from './pages/auth/forgot-password';

// Protected Pages
import Dashboard from './pages/dashboard/dashboard';
import Documents from './pages/documents/documents';
import Items from './pages/items'; 

// Components
import ProtectedRoute from './components/auth/protected-route';

import NotFound from './pages/not-found';
import LandingPage from './pages/landing';
import Categories from './pages/categories';

const AppRoutes = () => {
  return (
    <Routes>
      {/* Public routes */}
      <Route element={<BlankLayout />}>
        <Route exact path="/" element={<LandingPage />} />
        <Route path="/login" element={<SignIn />} />
        <Route path="/signup" element={<SignUp />} />
        <Route path="/password-reset" element={<ForgotPassword />} />
      </Route>

      {/* Protected routes */}
      <Route element={<MainLayout />}>
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/slips" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
        <Route path="/categories" element={<ProtectedRoute><Categories /></ProtectedRoute>} />
        <Route path="/items" element={<ProtectedRoute><Items /></ProtectedRoute>} />
        <Route path="/items/:groupId" element={<ProtectedRoute><Items /></ProtectedRoute>} />
        <Route path="*" element={<ProtectedRoute><NotFound /></ProtectedRoute>} />
      </Route>
    </Routes>
  );
};

export default AppRoutes;