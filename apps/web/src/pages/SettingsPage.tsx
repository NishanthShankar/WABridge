import { useState } from 'react';
import { LogOut, Monitor, Moon, Sun, Plus, Trash2, Power, PowerOff } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTheme } from '@/components/theme-provider';
import { clearApiKey } from '@/lib/auth';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import type { Webhook } from '@/types/api';

const themes = [
  { value: 'light' as const, label: 'Light', icon: Sun },
  { value: 'dark' as const, label: 'Dark', icon: Moon },
  { value: 'system' as const, label: 'System', icon: Monitor },
];

function WebhookRow({ webhook, onDelete, onToggle }: {
  webhook: Webhook;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{webhook.phone || 'All numbers'}</p>
        <p className="text-xs text-muted-foreground truncate">{webhook.url}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onToggle(webhook.id, !webhook.enabled)}
          title={webhook.enabled ? 'Disable' : 'Enable'}
        >
          {webhook.enabled
            ? <Power className="h-4 w-4 text-green-500" />
            : <PowerOff className="h-4 w-4 text-muted-foreground" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive"
          onClick={() => onDelete(webhook.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function WebhooksSection() {
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [showForm, setShowForm] = useState(false);

  const { data: webhooks = [], isLoading } = useQuery({
    queryKey: queryKeys.webhooks.all,
    queryFn: api.webhooks.list,
  });

  const createMutation = useMutation({
    mutationFn: api.webhooks.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.all });
      setPhone('');
      setUrl('');
      setSecret('');
      setShowForm(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.webhooks.delete,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.all }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.webhooks.update(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.all }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    createMutation.mutate({ phone: phone || undefined, url, secret: secret || undefined });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Webhooks</CardTitle>
            <CardDescription>Get notified when a specific number sends a message.</CardDescription>
          </div>
          {!showForm && (
            <Button size="sm" variant="outline" onClick={() => setShowForm(true)} className="gap-1">
              <Plus className="h-4 w-4" /> Add
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showForm && (
          <form onSubmit={handleSubmit} className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="wh-phone">Sender Phone (optional)</Label>
              <Input
                id="wh-phone"
                placeholder="Leave empty for all numbers"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-url">Webhook URL</Label>
              <Input
                id="wh-url"
                placeholder="https://example.com/webhook"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-secret">Secret (optional)</Label>
              <Input
                id="wh-secret"
                placeholder="HMAC signing secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {!isLoading && webhooks.length === 0 && !showForm && (
          <p className="text-sm text-muted-foreground">No webhooks configured.</p>
        )}

        {webhooks.map((wh) => (
          <WebhookRow
            key={wh.id}
            webhook={wh}
            onDelete={(id) => deleteMutation.mutate(id)}
            onToggle={(id, enabled) => toggleMutation.mutate({ id, enabled })}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 text-muted-foreground">Manage your WABridge preferences.</p>

      <Separator className="my-6" />

      <div className="space-y-6">
        <WebhooksSection />

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose how WABridge looks to you.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {themes.map(({ value, label, icon: Icon }) => (
                <Button
                  key={value}
                  variant={theme === value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTheme(value)}
                  className="gap-2"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>Disconnect from the dashboard and return to the login screen.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              onClick={() => {
                clearApiKey();
                window.location.reload();
              }}
              className="gap-2"
            >
              <LogOut className="h-4 w-4" />
              Disconnect
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
