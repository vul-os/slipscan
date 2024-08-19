import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../services/supabaseClient';
import { jwtDecode } from 'jwt-decode';
import { AuthContext } from './use-auth';

export function AuthProvider({ children }) {
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
    console.log('initializeUser started');
    setLoading(true);
    try {
      console.log('Fetching session');
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) {
        console.error('Error fetching session:', error);
        throw error;
      }
      console.log('Session fetched:', session);
  
      if (session?.user) {
        console.log('User found in session, setting user');
        setUser(session.user);
        console.log('Fetching merchants');
        await fetchMerchants(session.user.id);
        console.log('Merchants fetched');
      } else {
        console.log('No user in session, resetting states');
        setUser(null);
        setMerchants([]);
        setActiveMerchantId(null);
      }
    } catch (error) {
      console.error('Error in initializeUser:', error);
    } finally {
      console.log('Setting loading to false');
      setLoading(false);
    }
    console.log('initializeUser completed');
  }, [fetchMerchants]);

  useEffect(() => {
    initializeUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
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
      subscription.unsubscribe();
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

  try {
    return (
      <AuthContext.Provider value={contextValue}>
        {children}
      </AuthContext.Provider>
    );
  } catch (error) {
    console.error('Error rendering AuthProvider:', error); // Catch any rendering errors
    return null; // or some fallback UI
  }
}

// Add a default export
export default AuthProvider;