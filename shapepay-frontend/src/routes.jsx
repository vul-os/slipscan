import React from 'react';
import { Routes, Route } from 'react-router-dom';

import Customers from './pages/Customers';
import APIKeys from './pages/APIKeys';
import Webhooks from './pages/Webhooks';
import Payments from './pages/Payments'
import TransactionsPage from './pages/Transactions';
import Refunds from './pages/Refunds'
import Dashboard from './pages/Dashboard'

import BlankLayout from './components/BlankLayout';
import MainLayout from './components/MainLayout';
import SignIn from './pages/auth/SignIn';
import SignUp from './pages/auth/SignUp';
import ProtectedRoute from './components/ProtectedRoute';

const AppRoutes = () => {
  return (
    <Routes>
      <Route element={<BlankLayout />}>
        <Route path="/login" element={<SignIn />} />
        <Route path="/signup" element={<SignUp />} />
      </Route>
      <Route element={<MainLayout />}>
        <Route path="/" element={<ProtectedRoute><Customers /></ProtectedRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/apikeys" element={<ProtectedRoute><APIKeys /></ProtectedRoute>} />
        <Route path="/webhooks" element={<ProtectedRoute><Webhooks /></ProtectedRoute>} />
        <Route path="/customers" element={<ProtectedRoute><Customers /></ProtectedRoute>} />
        <Route path="/payments" element={<ProtectedRoute><Payments /></ProtectedRoute>} />
        <Route path="/transactions" element={<ProtectedRoute><TransactionsPage /></ProtectedRoute>} />
        <Route path="/refunds" element={<ProtectedRoute><Refunds /></ProtectedRoute>} />

      </Route>
    </Routes>
  );
};

export default AppRoutes;