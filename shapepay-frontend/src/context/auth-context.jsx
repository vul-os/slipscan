import React, { createContext, useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { jwtDecode } from 'jwt-decode'

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [darkMode, setDarkMode] = useState(true)

  useEffect(() => {
    const initializeUser = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setUser(session?.user ?? null);
      } catch (error) {
        console.error('Error fetching session:', error);
      } finally {
        setLoading(false);
      }
    };

    initializeUser();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        const jwt = jwtDecode(session.access_token)
        console.log(jwt)
      }
      setUser(session?.user ?? null);
    });

    return () => {
      if (authListener && authListener.unsubscribe) {
        authListener.unsubscribe();
      }
    };
  }, []);

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    setUser(data.user);
    return data.user;
  };

  const signInWithGoogle = async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
    });
    if (error) throw error;
    return data;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setUser(null);
  };

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
  }

  return (
    <AuthContext.Provider value={{ loading, user, signIn, signInWithGoogle, signOut, toggleDarkMode }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;