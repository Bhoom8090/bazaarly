import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { api, setCsrfToken, Session } from './api';

export interface SessionState {
  session: Session | null;
  loading: boolean;
  reload: () => Promise<void>;
  cartCount: number;
  refreshCartCount: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({
  session: null, loading: true, reload: async () => {}, cartCount: 0, refreshCartCount: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [cartCount, setCartCount] = useState(0);

  const reload = useCallback(async () => {
    try {
      const s = await api.get<Session>('/v1/auth/session');
      setCsrfToken(s.csrfToken);
      setSession(s);
      if (!s.authenticated) setCartCount(0);
    } catch {
      setSession({ authenticated: false });
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCartCount = useCallback(async () => {
    try {
      const c = await api.get<{ count: number }>('/v1/cart');
      setCartCount(c.count || 0);
    } catch {
      setCartCount(0);
    }
  }, []);

  useEffect(() => {
    reload().then(() => refreshCartCount());
  }, [reload, refreshCartCount]);

  return (
    <SessionContext.Provider value={{ session, loading, reload, cartCount, refreshCartCount }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
