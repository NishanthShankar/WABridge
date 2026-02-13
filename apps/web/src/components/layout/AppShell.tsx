import { useState } from 'react';
import { Outlet } from 'react-router';
import { useWebSocket } from '@/hooks/use-websocket';
import { getApiKey } from '@/lib/auth';
import { LoginPage } from '@/pages/LoginPage';
import { ConnectionBanner } from './ConnectionBanner';
import { TopNav } from './TopNav';
import { BottomTabBar } from './BottomTabBar';

export function AppShell() {
  const [authenticated, setAuthenticated] = useState(() => !!getApiKey());

  if (!authenticated) {
    return <LoginPage onLogin={() => setAuthenticated(true)} />;
  }

  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  // Connect WebSocket at shell level so it stays connected across navigations
  useWebSocket();

  return (
    <div className="min-h-screen bg-background">
      <ConnectionBanner />
      <TopNav />
      <main className="pb-16 md:pb-0">
        <Outlet />
      </main>
      <BottomTabBar />
    </div>
  );
}
