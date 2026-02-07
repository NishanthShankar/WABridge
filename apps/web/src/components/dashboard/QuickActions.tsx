import { Link } from 'react-router';
import { MessageSquare, Upload, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuickAction {
  label: string;
  description: string;
  icon: typeof MessageSquare;
  link: string;
  color: string;
}

const actions: QuickAction[] = [
  {
    label: 'Send Message',
    description: 'Send a WhatsApp message now',
    icon: MessageSquare,
    link: '/messages',
    color: 'bg-primary/10 text-primary',
  },
  {
    label: 'Import Contacts',
    description: 'Upload CSV or Excel file',
    icon: Upload,
    link: '/contacts',
    color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  },
  {
    label: 'Schedule Message',
    description: 'Plan messages for later',
    icon: Clock,
    link: '/messages',
    color: 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
  },
];

export function QuickActions() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-4">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <Link
            key={action.label}
            to={action.link}
            className={cn(
              'group flex items-center gap-4 rounded-xl border bg-card p-4 transition-all',
              'hover:shadow-md hover:scale-[1.02] active:scale-[0.98]',
            )}
          >
            <div className={cn('rounded-lg p-2.5', action.color)}>
              <Icon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">{action.label}</p>
              <p className="text-xs text-muted-foreground">{action.description}</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
