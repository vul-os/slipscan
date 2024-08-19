import React, { createContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../services/supabaseClient';
import { jwtDecode } from 'jwt-decode';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [merchants, setMerchants] = useState([]);
  const [activeMerchantId, setActiveMerchantId] = useState(null);

  const fetchMerchants = useCallback(async (userId) => {
    try {
      const { data, error } = await supabase
        .from('merchant_users')
        .select(`
          merchant_id,
          merchants (*)
        `)
        .eq('user_id', userId);
  
      if (error) throw error;
  
      const dataArray = Array.isArray(data) ? data : [data];
  
      const merchantsList = dataArray.map(item => item.merchants);
      setMerchants(merchantsList);
  
      if (merchantsList.length > 0 && !activeMerchantId) {
        setActiveMerchantId(merchantsList[0].id);
      }
    } catch (error) {
      console.error('Error fetching merchants:', error);
    }
  }, [activeMerchantId]);

  const initializeUser = useCallback(async () => {
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      console.log('Initial session check:', session, error);
      if (session?.user) {
        setUser(session.user);
        await fetchMerchants(session.user.id);
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Error fetching session:', error);
    } finally {
      setLoading(false);
    }
  }, [fetchMerchants]);

  useEffect(() => {
    initializeUser();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('Auth state changed:', event, session);
      if (session) {
        const jwt = jwtDecode(session.access_token);
        console.log('Decoded JWT:', jwt);
        setUser(session.user);
        await fetchMerchants(session.user.id);
      } else {
        setUser(null);
        setMerchants([]);
        setActiveMerchantId(null);
      }
    });

    return () => {
      if (authListener && authListener.unsubscribe) {
        authListener.unsubscribe();
      }
    };
  }, [initializeUser, fetchMerchants]);

  const signUp = async (email, password) => {
    const { data, error } = await supabase.auth.signUp({ 
      email, 
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) throw error;
    return data;
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    setUser(data.user);
    return data.user;
  };

  const signInWithGoogle = async () => {
    console.log('Sign in with Google initiated');
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}`,
      }
    });
    console.log('Sign in with Google result:', data, error);
    if (error) throw error;
    return data;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setUser(null);
    setMerchants([]);
    setActiveMerchantId(null);
  };

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  return (
    <AuthContext.Provider value={{ 
      loading, 
      user, 
      signUp,
      signIn, 
      signInWithGoogle, 
      signOut, 
      toggleDarkMode,
      merchants,
      activeMerchantId,
      setActiveMerchantId
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;