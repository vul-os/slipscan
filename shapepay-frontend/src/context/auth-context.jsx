import React, { createContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../services/supabaseClient';
import { jwtDecode } from 'jwt-decode';

export const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
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

      const merchantsList = Array.isArray(data) ? data.map(item => item.merchants) : [];
      setMerchants(merchantsList);

      if (merchantsList.length > 0 && !activeMerchantId) {
        setActiveMerchantId(merchantsList[0].id);
      }
    } catch (error) {
      console.error('Error fetching merchants:', error);
      // TODO: Implement user-facing error handling
    }
  }, [activeMerchantId]);

  const initializeUser = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;

      if (session?.user) {
        setUser(session.user);
        await fetchMerchants(session.user.id);
      } else {
        setUser(null);
        setMerchants([]);
        setActiveMerchantId(null);
      }
    } catch (error) {
      console.error('Error initializing user:', error);
      // TODO: Implement user-facing error handling
    } finally {
      setLoading(false);
    }
  }, [fetchMerchants]);

  useEffect(() => {
    initializeUser();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        const jwt = jwtDecode(session.access_token);
        setUser(session.user);
        await fetchMerchants(session.user.id);
      } else {
        setUser(null);
        setMerchants([]);
        setActiveMerchantId(null);
      }
    });

    return () => {
      authListener?.unsubscribe();
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
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      }
    });
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

  const contextValue = useMemo(() => ({
    loading,
    user,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    merchants,
    activeMerchantId,
    setActiveMerchantId
  }), [loading, user, merchants, activeMerchantId]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;