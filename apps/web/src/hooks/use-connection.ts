import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { ConnectionHealth } from '@/types/api';

export function useConnectionHealth() {
  return useQuery<ConnectionHealth>({
    queryKey: queryKeys.connection.health,
    queryFn: api.health,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
