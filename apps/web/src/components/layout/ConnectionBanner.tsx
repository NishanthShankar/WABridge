import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, X, WifiOff } from 'lucide-react';
import { useConnectionHealth } from '@/hooks/use-connection';
import { ROUTES } from '@/lib/constants';

export function ConnectionBanner() {
  const { data: health } = useConnectionHealth();
  const status = health?.status;
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal when status changes to a non-warning state and back
  useEffect(() => {
    if (status === 'connected' || status === 'connecting') {
      setDismissed(false);
    }
  }, [status]);

  // Only show when disconnected or pairing
  if (!status || status === 'connected' || status === 'connecting' || dismissed) {
    return null;
  }

  const isDisconnected = status === 'disconnected';

  return (
    <div
      className={cn(
        'relative flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium',
        isDisconnected
          ? 'bg-destructive/10 text-destructive'
          : 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
      )}
    >
      {isDisconnected ? (
        <WifiOff className="h-4 w-4 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      )}
      <span>
        {isDisconnected ? 'WhatsApp disconnected' : 'WhatsApp pairing required'}
        {' -- '}
        <Link to={ROUTES.CONNECT} className="underline underline-offset-2 hover:opacity-80">
          go to Connect
        </Link>
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}
