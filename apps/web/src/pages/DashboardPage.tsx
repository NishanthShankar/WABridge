import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useConnectionHealth } from '@/hooks/use-connection';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { QuickActions } from '@/components/dashboard/QuickActions';
import { StatsCards } from '@/components/dashboard/StatsCards';
import { UpcomingMessages } from '@/components/dashboard/UpcomingMessages';
import { RecentActivity } from '@/components/dashboard/RecentActivity';

export function DashboardPage() {
  const { data: health } = useConnectionHealth();

  // Pre-fetch data used by multiple child components
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

  // Determine if user is new (nothing set up yet)
  const isNewUser =
    health?.status !== 'connected' &&
    (contactsResult?.total ?? 0) === 0 &&
    (messagesResult?.total ?? 0) === 0;

  return (
    <div className="space-y-4 p-4 md:space-y-6 md:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {isNewUser ? 'Welcome to openWA' : 'Dashboard'}
      </h1>

      {/* Onboarding checklist - shows only for incomplete setup */}
      <OnboardingChecklist />

      {/* Quick action cards */}
      <QuickActions />

      {/* Stats overview */}
      <StatsCards />

      {/* Two-column layout on desktop */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
        <UpcomingMessages />
        <RecentActivity />
      </div>
    </div>
  );
}
