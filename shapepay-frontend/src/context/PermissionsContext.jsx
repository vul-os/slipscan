import React, { createContext, useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';

const PermissionsContext = createContext();

export const PermissionsProvider = ({ children }) => {
  const [permissions, setPermissions] = useState([]);

  useEffect(() => {
    const fetchPermissions = async () => {
      const { data, error } = await supabase.from('permissions').select('*');
      if (error) throw error;
      setPermissions(data.map((perm) => perm.name));
    };

    fetchPermissions();
  }, []);

  return (
    <PermissionsContext.Provider value={{ permissions, setPermissions }}>
      {children}
    </PermissionsContext.Provider>
  );
};

export default PermissionsContext;
