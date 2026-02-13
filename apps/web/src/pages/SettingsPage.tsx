import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { clearApiKey } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

const themes = [
  { value: 'light' as const, label: 'Light', icon: Sun },
  { value: 'dark' as const, label: 'Dark', icon: Moon },
  { value: 'system' as const, label: 'System', icon: Monitor },
];

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 text-muted-foreground">Manage your openWA preferences.</p>

      <Separator className="my-6" />

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how openWA looks to you.</CardDescription>
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
  );
}
