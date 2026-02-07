import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Check, ChevronRight, X } from 'lucide-react';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useConnectionHealth } from '@/hooks/use-connection';
import { Card, CardHeader, CardTitle, CardContent, CardAction } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'openwa-checklist-dismissed';

interface ChecklistItem {
  key: string;
  label: string;
  description: string;
  link: string;
  complete: boolean;
}

export function OnboardingChecklist() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === 'true',
  );

  const { data: health } = useConnectionHealth();
  const { data: contactsResult } = useQuery({
    queryKey: queryKeys.contacts.list({ limit: 1 }),
    queryFn: () => api.contacts.list({ limit: 1 }),
    staleTime: 60_000,
  });
  const { data: messagesResult } = useQuery({
    queryKey: queryKeys.messages.list({ limit: 1 }),
    queryFn: () => api.messages.list({ limit: 1 }),
    staleTime: 60_000,
  });

  const items: ChecklistItem[] = [
    {
      key: 'connect',
      label: 'Connect WhatsApp',
      description: 'Scan a QR code to link your WhatsApp account',
      link: '/connect',
      complete: health?.status === 'connected',
    },
    {
      key: 'contacts',
      label: 'Import contacts',
      description: 'Add or import your customer contacts',
      link: '/contacts',
      complete: (contactsResult?.total ?? 0) > 0,
    },
    {
      key: 'messages',
      label: 'Schedule first message',
      description: 'Send or schedule your first WhatsApp message',
      link: '/messages',
      complete: (messagesResult?.total ?? 0) > 0,
    },
  ];

  const completedCount = items.filter((i) => i.complete).length;
  const allComplete = completedCount === items.length;

  // Don't show if dismissed or all items complete
  if (dismissed || allComplete) return null;

  function handleDismiss() {
    localStorage.setItem(STORAGE_KEY, 'true');
    setDismissed(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Get started with openWA</CardTitle>
        <CardAction>
          <Button variant="ghost" size="icon-xs" onClick={handleDismiss} title="Dismiss checklist">
            <X className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>Setup progress</span>
            <span>
              {completedCount} of {items.length} complete
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(completedCount / items.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Checklist items */}
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                to={item.link}
                className={cn(
                  'flex items-center gap-3 rounded-lg p-3 transition-colors',
                  item.complete
                    ? 'bg-muted/50'
                    : 'bg-muted/30 hover:bg-muted',
                )}
              >
                <div
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border-2',
                    item.complete
                      ? 'border-green-500 bg-green-500 text-white'
                      : 'border-muted-foreground/30',
                  )}
                >
                  {item.complete && <Check className="size-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      item.complete && 'line-through text-muted-foreground',
                    )}
                  >
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                </div>
                {!item.complete && (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
