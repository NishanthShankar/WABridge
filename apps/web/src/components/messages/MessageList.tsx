import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  format,
  formatDistanceToNow,
  isPast,
} from 'date-fns';
import {
  CalendarPlus,
  XCircle,
  RotateCcw,
  MessageSquare,
  Clock,
  Filter,
  X,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResponsiveList, type Column } from '@/components/shared/ResponsiveList';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { ScheduledMessage, MessageStatus } from '@/types/api';

const STATUS_CONFIG: Record<
  MessageStatus,
  { label: string; className: string }
> = {
  pending: { label: 'Pending', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' },
  sent: { label: 'Sent', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' },
  delivered: { label: 'Delivered', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
  cancelled: { label: 'Cancelled', className: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400' },
};

interface MessageListProps {
  onSchedule: () => void;
  onRecurring: () => void;
}

export function MessageList({ onSchedule, onRecurring }: MessageListProps) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  // Phone filter state
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneMode, setPhoneMode] = useState<'include' | 'exclude'>('include');
  const [activePhoneFilter, setActivePhoneFilter] = useState('');
  const [activePhoneMode, setActivePhoneMode] = useState<'include' | 'exclude'>('include');

  const params = {
    status: statusFilter === 'all' ? undefined : (statusFilter as MessageStatus),
    phone: activePhoneFilter || undefined,
    phoneMode: activePhoneFilter ? activePhoneMode : undefined,
    limit,
    offset,
  };

  const { data: messagesResult, isLoading } = useQuery({
    queryKey: queryKeys.messages.list(params as Record<string, unknown>),
    queryFn: () => api.messages.list(params),
  });

  const { data: rateLimitStatus } = useQuery({
    queryKey: queryKeys.rateLimit.status,
    queryFn: api.rateLimit.status,
    refetchInterval: 60_000,
  });

  const messages = messagesResult?.data ?? [];
  const total = messagesResult?.total ?? 0;
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.messages.cancel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
      toast.success('Message cancelled');
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to cancel message'),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.messages.retry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
      toast.success('Message retry scheduled');
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to retry message'),
  });

  function renderScheduleTime(msg: ScheduledMessage) {
    const date = new Date(msg.scheduledAt);
    if (msg.status === 'pending' && !isPast(date)) {
      return (
        <span className="text-xs">
          <span className="text-muted-foreground">
            {format(date, 'MMM d, h:mm a')}
          </span>
          <span className="ml-1 text-primary">
            ({formatDistanceToNow(date, { addSuffix: true })})
          </span>
        </span>
      );
    }
    return (
      <span className="text-xs text-muted-foreground">
        {format(date, 'MMM d, yyyy h:mm a')}
      </span>
    );
  }

  function renderActions(msg: ScheduledMessage) {
    if (msg.status === 'pending') {
      return (
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            setCancelId(msg.id);
          }}
          className="text-destructive hover:text-destructive"
        >
          <XCircle className="size-3" />
          Cancel
        </Button>
      );
    }
    if (msg.status === 'failed') {
      return (
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            retryMutation.mutate(msg.id);
          }}
        >
          <RotateCcw className="size-3" />
          Retry
        </Button>
      );
    }
    return null;
  }

  const columns: Column<ScheduledMessage>[] = [
    {
      header: 'Recipient',
      accessor: (m) => (
        <div className="flex items-center gap-1.5">
          {m.groupName ? (
            <>
              <Users className="size-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium">{m.groupName}</span>
            </>
          ) : (
            <>
              <span className="font-medium">
                {m.contactName || m.contactPhone}
              </span>
              {m.contactName && m.contactPhone && (
                <span className="ml-1 text-xs text-muted-foreground font-mono">
                  {m.contactPhone}
                </span>
              )}
            </>
          )}
        </div>
      ),
    },
    {
      header: 'Message',
      accessor: (m) => (
        <span className="text-sm line-clamp-1 max-w-[200px]">
          {m.content}
        </span>
      ),
    },
    {
      header: 'Scheduled',
      accessor: (m) => renderScheduleTime(m),
    },
    {
      header: 'Status',
      accessor: (m) => {
        const config = STATUS_CONFIG[m.status];
        return (
          <Badge variant="secondary" className={config.className}>
            {config.label}
          </Badge>
        );
      },
    },
    {
      header: 'Actions',
      accessor: (m) => renderActions(m),
    },
  ];

  // Rate limit indicator
  function RateLimitBadge() {
    if (!rateLimitStatus) return null;
    const { sentToday, dailyCap, remaining } = rateLimitStatus;
    const isWarning = remaining <= rateLimitStatus.warningThreshold;
    const isReached = remaining <= 0;

    return (
      <Badge
        variant="outline"
        className={
          isReached
            ? 'border-red-300 text-red-600 dark:text-red-400'
            : isWarning
              ? 'border-amber-300 text-amber-600 dark:text-amber-400'
              : ''
        }
      >
        <Clock className="size-3" />
        {sentToday}/{dailyCap} today
      </Badge>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <RateLimitBadge />
        {/* Phone filter */}
        <div className="flex items-center gap-2">
          <Filter className="size-4 text-muted-foreground" />
          <Select value={phoneMode} onValueChange={(v) => setPhoneMode(v as 'include' | 'exclude')}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="include">Includes</SelectItem>
              <SelectItem value="exclude">Excludes</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Phone number"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && phoneInput.trim()) {
                setActivePhoneFilter(phoneInput.trim());
                setActivePhoneMode(phoneMode);
                setOffset(0);
              }
            }}
            className="h-8 w-40"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!phoneInput.trim()}
            onClick={() => {
              setActivePhoneFilter(phoneInput.trim());
              setActivePhoneMode(phoneMode);
              setOffset(0);
            }}
          >
            Apply
          </Button>
          {activePhoneFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActivePhoneFilter('');
                setPhoneInput('');
                setOffset(0);
              }}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={onRecurring}>
            <RotateCcw className="size-4" />
            <span className="hidden sm:inline">Recurring</span>
          </Button>
          <Button size="sm" onClick={onSchedule}>
            <CalendarPlus className="size-4" />
            <span className="hidden sm:inline">Schedule Message</span>
          </Button>
        </div>
      </div>

      {/* Status Tabs */}
      <Tabs value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setOffset(0); }}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="sent">Sent</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
        </TabsList>

        <TabsContent value={statusFilter} className="mt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : (
            <ResponsiveList
              data={messages}
              columns={columns}
              emptyState={
                <EmptyState
                  icon={MessageSquare}
                  title="No messages yet"
                  description="Schedule your first message to a contact."
                  action={{ label: 'Schedule Message', onClick: onSchedule }}
                />
              }
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <p className="text-sm text-muted-foreground">
            {total} message{total !== 1 ? 's' : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
              disabled={offset <= 0}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset((o) => o + limit)}
              disabled={currentPage >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Cancel Confirmation */}
      <ConfirmDialog
        open={!!cancelId}
        onOpenChange={(o) => !o && setCancelId(null)}
        title="Cancel Message"
        description="Are you sure you want to cancel this scheduled message?"
        confirmLabel="Cancel Message"
        variant="destructive"
        onConfirm={() => {
          if (cancelId) cancelMutation.mutate(cancelId);
          setCancelId(null);
        }}
      />
    </div>
  );
}
