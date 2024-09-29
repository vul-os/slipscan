import React, { useEffect } from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from './context/auth-context';
import AppRoutes from './routes';
import { Toaster } from "@/components/ui/toaster"
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "***REMOVED***",
  authDomain: "slipscan-b6484.firebaseapp.com",
  projectId: "slipscan-b6484",
  storageBucket: "slipscan-b6484.appspot.com",
  messagingSenderId: "***REMOVED***",
  appId: "1:***REMOVED***:web:e56ec21527ec4a89a89f49",
  measurementId: "G-N3VXB1GWPY"
};

const App = () => {
  useEffect(() => {
    const app = initializeApp(firebaseConfig);
    const analytics = getAnalytics(app);
    // You can add any additional analytics setup here
  }, []);

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