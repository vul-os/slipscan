import React from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from './context/auth-context';
import { PermissionsProvider } from './context/permission-context';
import AppRoutes from './routes';

const App = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <AuthProvider>
        <PermissionsProvider>
          <Router>
            <AppRoutes />
          </Router>
        </PermissionsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;