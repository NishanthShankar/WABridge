import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { queryKeys } from '@/lib/query-keys';

export function QRDisplay() {
  const queryClient = useQueryClient();
  const qrData = queryClient.getQueryData<string>(queryKeys.connection.qr);

  if (!qrData) {
    return (
      <div className="flex h-64 w-64 items-center justify-center rounded-lg border bg-white">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Waiting for QR code...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-2">
      <img
        src={qrData}
        alt="WhatsApp QR Code"
        className="h-64 w-64"
        draggable={false}
      />
    </div>
  );
}
