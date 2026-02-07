import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Check, CheckCheck, X, Activity, RotateCw } from 'lucide-react';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ScheduledMessage, MessageStatus } from '@/types/api';

const statusConfig: Record<
  string,
  { icon: typeof Check; color: string; label: string }
> = {
  sent: {
    icon: Check,
    color: 'text-green-600 dark:text-green-400',
    label: 'Sent',
  },
  delivered: {
    icon: CheckCheck,
    color: 'text-blue-600 dark:text-blue-400',
    label: 'Delivered',
  },
  failed: {
    icon: X,
    color: 'text-red-600 dark:text-red-400',
    label: 'Failed',
  },
};

const completedStatuses: MessageStatus[] = ['sent', 'delivered', 'failed'];

export function RecentActivity() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.messages.list({ limit: 10 }),
    queryFn: () => api.messages.list({ limit: 10 }),
    staleTime: 30_000,
  });

  const messages = (data?.data ?? []).filter((m) =>
    completedStatuses.includes(m.status),
  );

  async function handleRetry(msg: ScheduledMessage) {
    await api.messages.retry(msg.id);
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" />
          Recent Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Activity className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">No recent activity</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {messages.map((msg) => {
              const config = statusConfig[msg.status];
              if (!config) return null;
              const StatusIcon = config.icon;
              const timestamp =
                msg.sentAt || msg.deliveredAt || msg.failedAt || msg.updatedAt;

              return (
                <li key={msg.id} className="flex items-start gap-3">
                  <div className={cn('mt-0.5 shrink-0', config.color)}>
                    <StatusIcon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-tight">
                      {msg.contactName || msg.contactPhone}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {msg.content.length > 50
                        ? msg.content.slice(0, 50) + '...'
                        : msg.content}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {msg.status === 'failed' && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-red-600 hover:text-red-700 dark:text-red-400"
                        onClick={() => void handleRetry(msg)}
                        title="Retry"
                      >
                        <RotateCw className="size-3" />
                      </Button>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(timestamp), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
