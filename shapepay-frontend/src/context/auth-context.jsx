import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../services/supabaseClient';
import { jwtDecode } from 'jwt-decode';
import { AuthContext } from './use-auth';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [merchants, setMerchants] = useState([]);
  const [activeMerchantId, setActiveMerchantId] = useState(null);

  window.addEventListener('unhandledrejection', function(event) {
    console.error('Unhandled rejection (promise: ', event.promise, ', reason: ', event.reason, ').');
  });

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

  const handleAuthStateChange = useCallback((event, session) => {
    console.log('Auth state changed:', event);
    
    // Use setTimeout to avoid potential deadlocks
    setTimeout(async () => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        if (session?.user) {
          setUser(session.user);
          await fetchMerchants(session.user.id);
        }
      } else if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
        setUser(null);
        setMerchants([]);
        setActiveMerchantId(null);
      } else if (event === 'USER_UPDATED') {
        setUser(session?.user ?? null);
      }
    }, 0);
  }, [fetchMerchants]);

  useEffect(() => {
    const initializeAuth = async () => {
      setLoading(true);
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (session) {
          setUser(session.user);
          await fetchMerchants(session.user.id);
        }
      } catch (error) {
        console.error('Error initializing auth:', error);
      } finally {
        setLoading(false);
      }
    };

    initializeAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(handleAuthStateChange);

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchMerchants, handleAuthStateChange]);

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
}

export default AuthProvider;