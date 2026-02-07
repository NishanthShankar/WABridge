import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Clock, CalendarPlus } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function UpcomingMessages() {
  const { data } = useQuery({
    queryKey: queryKeys.messages.list({ status: 'pending', limit: 5 }),
    queryFn: () => api.messages.list({ status: 'pending', limit: 5 }),
    staleTime: 30_000,
  });

  const messages = data?.data ?? [];

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4 text-muted-foreground" />
          Upcoming Messages
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <CalendarPlus className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">No messages scheduled</p>
            <Button variant="link" size="sm" className="mt-1" asChild>
              <Link to="/messages">Schedule one</Link>
            </Button>
          </div>
        ) : (
          <ul className="space-y-3">
            {messages.map((msg) => (
              <li key={msg.id} className="flex items-start gap-3">
                <div className="mt-0.5 size-2 shrink-0 rounded-full bg-amber-400" />
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
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(msg.scheduledAt), { addSuffix: true })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {messages.length > 0 && (
        <CardFooter className="justify-center border-t pt-3">
          <Button variant="link" size="sm" asChild>
            <Link to="/messages">View all</Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
