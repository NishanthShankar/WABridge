import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { setApiKey } from '@/lib/auth';
import { API_BASE } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/health`, {
        headers: { 'X-API-Key': trimmed },
      });
      if (!res.ok) {
        toast.error('Invalid API key');
        return;
      }
      setApiKey(trimmed);
      onLogin();
    } catch {
      toast.error('Cannot reach server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>openWA</CardTitle>
          <CardDescription>Enter your API key to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                placeholder="API key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="pl-10"
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || !key.trim()}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Connect
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
