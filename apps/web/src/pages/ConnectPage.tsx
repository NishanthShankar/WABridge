import { CheckCircle, Loader2, Smartphone } from 'lucide-react';
import { useConnectionHealth } from '@/hooks/use-connection';
import { QRDisplay } from '@/components/connection/QRDisplay';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ConnectPage() {
  const { data: health } = useConnectionHealth();
  const status = health?.status ?? 'disconnected';

  return (
    <div className="flex items-start justify-center p-4 md:p-6 md:pt-12">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>
            {status === 'connected' ? 'WhatsApp Connected' : 'Connect WhatsApp'}
          </CardTitle>
          <CardDescription>
            {status === 'connected'
              ? `Linked to ${health?.account?.phoneNumber ?? 'your device'}`
              : 'Scan the QR code with your phone to link this device'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === 'connected' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <div className="text-center">
                <p className="font-medium">{health?.account?.name ?? 'WhatsApp'}</p>
                <p className="text-sm text-muted-foreground">
                  {health?.account?.phoneNumber}
                </p>
              </div>
            </div>
          )}

          {status === 'connecting' && (
            <div className="flex flex-col items-center gap-4 py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Reconnecting...</p>
            </div>
          )}

          {(status === 'pairing' || status === 'disconnected') && (
            <div className="flex flex-col items-center gap-6">
              <QRDisplay />
              <div className="space-y-3 text-sm text-muted-foreground">
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    1
                  </span>
                  <span>Open WhatsApp on your phone</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    2
                  </span>
                  <span>
                    Tap <Smartphone className="inline h-3.5 w-3.5" /> Menu &gt; Linked Devices &gt;
                    Link a Device
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    3
                  </span>
                  <span>Point your phone at this QR code</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
