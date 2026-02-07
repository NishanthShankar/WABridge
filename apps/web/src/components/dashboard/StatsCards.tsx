import { useConnectionHealth } from '@/hooks/use-connection';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wifi, WifiOff, Users, MessageSquare, Gauge } from 'lucide-react';
import { cn } from '@/lib/utils';

export function StatsCards() {
  const { data: health } = useConnectionHealth();

  const { data: contactsResult } = useQuery({
    queryKey: queryKeys.contacts.list({ limit: 1 }),
    queryFn: () => api.contacts.list({ limit: 1 }),
    staleTime: 60_000,
  });

  const { data: rateLimitData } = useQuery({
    queryKey: queryKeys.rateLimit.status,
    queryFn: api.rateLimit.status,
    staleTime: 30_000,
  });

  const status = health?.status ?? 'disconnected';
  const phoneNumber = health?.account?.phoneNumber;
  const contactCount = contactsResult?.total ?? 0;
  const sentToday = rateLimitData?.sentToday ?? 0;
  const dailyCap = rateLimitData?.dailyCap ?? 30;
  const remaining = rateLimitData?.remaining ?? dailyCap;
  const usagePercent = dailyCap > 0 ? (sentToday / dailyCap) * 100 : 0;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      {/* WhatsApp Status */}
      <Card className="gap-3 py-4">
        <CardContent className="flex items-start gap-3 px-4">
          <div
            className={cn(
              'rounded-lg p-2',
              status === 'connected'
                ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                : status === 'connecting' || status === 'pairing'
                  ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
            )}
          >
            {status === 'connected' ? (
              <Wifi className="size-5" />
            ) : (
              <WifiOff className="size-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">WhatsApp</p>
            <Badge
              variant={
                status === 'connected'
                  ? 'default'
                  : status === 'connecting' || status === 'pairing'
                    ? 'secondary'
                    : 'destructive'
              }
              className="mt-1 text-xs"
            >
              {status === 'connected'
                ? 'Connected'
                : status === 'connecting'
                  ? 'Connecting'
                  : status === 'pairing'
                    ? 'Pairing'
                    : 'Disconnected'}
            </Badge>
            {phoneNumber && (
              <p className="mt-1 truncate text-xs text-muted-foreground">{phoneNumber}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Contacts Count */}
      <Card className="gap-3 py-4">
        <CardContent className="flex items-start gap-3 px-4">
          <div className="rounded-lg bg-blue-100 p-2 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
            <Users className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Contacts</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{contactCount}</p>
          </div>
        </CardContent>
      </Card>

      {/* Messages Today */}
      <Card className="gap-3 py-4">
        <CardContent className="flex items-start gap-3 px-4">
          <div className="rounded-lg bg-violet-100 p-2 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
            <MessageSquare className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Sent Today</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{sentToday}</p>
          </div>
        </CardContent>
      </Card>

      {/* Rate Limit */}
      <Card className="gap-3 py-4">
        <CardContent className="flex items-start gap-3 px-4">
          <div
            className={cn(
              'rounded-lg p-2',
              usagePercent >= 100
                ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                : usagePercent >= 80
                  ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
            )}
          >
            <Gauge className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Rate Limit</p>
            <p className="mt-1 text-lg font-semibold tracking-tight">
              {remaining}/{dailyCap}
            </p>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  usagePercent >= 100
                    ? 'bg-red-500'
                    : usagePercent >= 80
                      ? 'bg-amber-500'
                      : 'bg-emerald-500',
                )}
                style={{ width: `${Math.min(usagePercent, 100)}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
