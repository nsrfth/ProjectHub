import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listMyTeams, type Team } from './api';
import { useAuth } from '@/features/auth/AuthContext';

interface TeamsState {
  teams: Team[];
  loading: boolean;
  currentTeam: Team | null;
  currentTeamId: string | null;
  setCurrentTeamId: (id: string | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<TeamsState | null>(null);
const STORAGE_KEY = 'taskhub.currentTeamId';

export function TeamsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();

  // Only query once we have a signed-in user; otherwise an unauth request would
  // race with the AuthProvider's bootstrap.
  const { data: teams = [], isLoading } = useQuery({
    queryKey: ['teams', 'mine'],
    queryFn: listMyTeams,
    enabled: !!user,
  });

  const [currentTeamId, _setCurrentTeamId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(STORAGE_KEY);
  });

  function setCurrentTeamId(id: string | null): void {
    _setCurrentTeamId(id);
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  }

  // If no team is selected, or the saved selection isn't in the user's list
  // anymore (e.g. they were removed), fall back to the first available team.
  useEffect(() => {
    if (!teams.length) return;
    if (!currentTeamId || !teams.some((t) => t.id === currentTeamId)) {
      setCurrentTeamId(teams[0].id);
    }
  }, [teams, currentTeamId]);

  // Clear selection on sign-out so the next user doesn't inherit it.
  useEffect(() => {
    if (!user) setCurrentTeamId(null);
  }, [user]);

  const currentTeam = useMemo(
    () => teams.find((t) => t.id === currentTeamId) ?? null,
    [teams, currentTeamId],
  );

  const value = useMemo<TeamsState>(
    () => ({
      teams,
      loading: isLoading,
      currentTeam,
      currentTeamId,
      setCurrentTeamId,
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: ['teams'] });
      },
    }),
    [teams, isLoading, currentTeam, currentTeamId, qc],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTeams(): TeamsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTeams must be used inside <TeamsProvider>');
  return v;
}
