import { createContext} from 'react';

// Create the AuthContext with a default value
export const AuthContext = createContext({
    loading: true,
    user: null,
    signUp: async () => {},
    signIn: async () => {},
    signInWithGoogle: async () => {},
    signOut: async () => {},
    merchants: [],
    activeMerchantId: null,
    setActiveMerchantId: () => {},
  });
  
export default AuthContext