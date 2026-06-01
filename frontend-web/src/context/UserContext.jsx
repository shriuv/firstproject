import React, { createContext, useContext } from 'react';
import { useAuth } from '../shared/hooks/useAuth';

/**
 * UserContext — thin wrapper around useAuth that makes the Supabase
 * user object available anywhere in the component tree without prop-drilling
 * or repeating `await supabase.auth.getUser()` calls.
 */
const UserContext = createContext(null);

export function UserProvider({ children }) {
  const { user, loading } = useAuth();
  return (
    <UserContext.Provider value={{ user, loading }}>
      {children}
    </UserContext.Provider>
  );
}

/**
 * useUser() — returns the current Supabase user (or null while loading).
 * Must be called inside a component that is a descendant of <UserProvider>.
 */
export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) {
    throw new Error('useUser() must be used inside a <UserProvider>');
  }
  return ctx.user;
}
