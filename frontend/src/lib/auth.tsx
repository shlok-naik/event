import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setAuthToken, type AuthResponse, type Me } from '../api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  isGuest: boolean;
  isUser: boolean;
  signIn(r: AuthResponse): void;
  signOut(): Promise<void>;
  token: string | null;
}
const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

const KEY = 'gather.token';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (t: string | null) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(() => read());
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!read());

  useEffect(() => {
    setAuthToken(token);
    if (!token) { setLoading(false); return; }
    let cancelled = false;
    api.auth.me().then((m) => { if (!cancelled) setMe(m); }).catch(() => { if (!cancelled) { write(null); setToken(null); setMe(null); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const signIn = useCallback((r: AuthResponse) => {
    setAuthToken(r.token); write(r.token); qc.clear(); setMe(r.me); setToken(r.token); setLoading(false);
  }, [qc]);
  const signOut = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* already invalid */ }
    setAuthToken(null); write(null); qc.clear(); setMe(null); setToken(null);
  }, [qc]);

  const value = useMemo<AuthState>(() => ({ me, token, loading, isGuest: me?.kind === 'guest', isUser: me?.kind === 'user', signIn, signOut }), [me, token, loading, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
