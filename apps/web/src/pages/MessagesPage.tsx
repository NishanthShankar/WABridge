import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { CalendarPlus } from 'lucide-react';
import { MessageList } from '@/components/messages/MessageList';
import { ScheduleWizard } from '@/components/messages/ScheduleWizard';
import { RecurringForm } from '@/components/messages/RecurringForm';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export function MessagesPage() {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('messages');

  const { data: messagesResult } = useQuery({
    queryKey: queryKeys.messages.list({ limit: 1 } as Record<string, unknown>),
    queryFn: () => api.messages.list({ limit: 1 }),
  });

  const totalMessages = messagesResult?.total ?? 0;

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
          <p className="text-sm text-muted-foreground">
            {totalMessages > 0
              ? `${totalMessages} scheduled message${totalMessages !== 1 ? 's' : ''}`
              : 'Schedule and track your messages'}
          </p>
        </div>
        <Button size="sm" onClick={() => setScheduleOpen(true)}>
          <CalendarPlus className="size-4" />
          <span className="hidden sm:inline">Schedule Message</span>
        </Button>
      </div>

      {/* Main tabs: Messages vs Recurring */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="recurring">Recurring Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="messages" className="mt-4">
          <MessageList
            onSchedule={() => setScheduleOpen(true)}
            onRecurring={() => setActiveTab('recurring')}
          />
        </TabsContent>

        <TabsContent value="recurring" className="mt-4">
          <RecurringForm />
        </TabsContent>
      </Tabs>

      {/* Schedule Wizard */}
      <ScheduleWizard open={scheduleOpen} onOpenChange={setScheduleOpen} />
    </div>
  );
}
