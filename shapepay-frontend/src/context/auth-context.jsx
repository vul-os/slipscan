import React, { createContext, useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { jwtDecode } from 'jwt-decode'

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [merchants, setMerchants] = useState([]);
  const [activeMerchantId, setActiveMerchantId] = useState(null);

  useEffect(() => {
    const initializeUser = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        console.log(session)
        setUser(session?.user ?? null);
        if (session?.user) {
          fetchMerchants(session.user.id);
        }
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
        setUser(session.user);
        fetchMerchants(session.user.id);
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
  }, []);

  const fetchMerchants = async (userId) => {
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
  };

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
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'https://app.shapepay.co.za/#',
      },
    });
    console.log(data, error)
    if (error) {
      throw error
    }
    setUser(data.user);
    return data.user;
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