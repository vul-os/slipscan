import React from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from './context/auth-context';
import AppRoutes from './routes';
import { Toaster } from "@/components/ui/toaster"


const App = () => {

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <AuthProvider>
        <Router>
          <AppRoutes />
        </Router>
        <Toaster />
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;