import React from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from './context/auth-context';
import AppRoutes from './routes';

const App = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <AuthProvider>
        <Router>
          <Helmet>
            <title>SlipSnap</title>
            <link rel="icon" type="image/png" href="/camera.svg" />
          </Helmet>
          <AppRoutes />
        </Router>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;