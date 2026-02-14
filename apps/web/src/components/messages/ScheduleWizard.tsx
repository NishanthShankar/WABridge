import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { User, Users, FileText, Calendar, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Wizard } from '@/components/shared/Wizard';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Contact, Group } from '@/types/api';

interface ScheduleWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type RecipientType = 'individual' | 'group';

export function ScheduleWizard({ open, onOpenChange }: ScheduleWizardProps) {
  const queryClient = useQueryClient();

  // Step 1: Recipient
  const [recipientType, setRecipientType] = useState<RecipientType>('individual');
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [directPhone, setDirectPhone] = useState('');
  const [directName, setDirectName] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);

  // Step 2: Compose
  const [content, setContent] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  // Step 3: Schedule
  const [sendNow, setSendNow] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('09:00');

  // Load contacts for picker
  const { data: contactsResult } = useQuery({
    queryKey: queryKeys.contacts.list({ search: contactSearch, limit: 20 } as Record<string, unknown>),
    queryFn: () => api.contacts.list({ search: contactSearch || undefined, limit: 20 }),
    enabled: open && recipientType === 'individual',
  });

  // Load groups for picker
  const { data: groupsResult } = useQuery({
    queryKey: queryKeys.groups.list({ search: groupSearch, limit: 20 } as Record<string, unknown>),
    queryFn: () => api.groups.list({ search: groupSearch || undefined, limit: 20 }),
    enabled: open && recipientType === 'group',
  });

  // Load templates
  const { data: templates = [] } = useQuery({
    queryKey: queryKeys.templates.all,
    queryFn: api.templates.list,
    enabled: open,
  });

  const contacts = contactsResult?.data ?? [];
  const groupsList = groupsResult?.data ?? [];

  const syncGroupsMutation = useMutation({
    mutationFn: () => api.groups.sync(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.all });
      toast.success(`Synced ${result.synced} groups from WhatsApp`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to sync groups');
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: (data: { contactId?: string; phone?: string; name?: string; groupId?: string; content: string; scheduledAt?: string }) =>
      api.messages.schedule(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.rateLimit.status });
      toast.success('Message scheduled!');
      handleClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 429) {
        toast.error('Rate limit exceeded. Try again later or increase your daily cap.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to schedule message');
      }
    },
  });

  function handleClose() {
    onOpenChange(false);
    setRecipientType('individual');
    setSelectedContact(null);
    setContactSearch('');
    setDirectPhone('');
    setDirectName('');
    setGroupSearch('');
    setSelectedGroup(null);
    setContent('');
    setSelectedTemplateId('');
    setSendNow(false);
    setScheduledDate('');
    setScheduledTime('09:00');
  }

  async function handleTemplateSelect(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId || !selectedContact) return;

    try {
      const preview = await api.templates.preview(templateId, selectedContact.id);
      setContent(preview.rendered);
      if (preview.unresolvedVariables.length > 0) {
        toast.info(
          `Some variables could not be resolved: ${preview.unresolvedVariables.join(', ')}`,
        );
      }
    } catch {
      // If preview fails, use the raw template body
      const template = templates.find((t) => t.id === templateId);
      if (template) setContent(template.body);
    }
  }

  // Derive recipient display for summary
  const recipientDisplay = useMemo(() => {
    if (recipientType === 'group' && selectedGroup) {
      return selectedGroup.name;
    }
    if (selectedContact) {
      return selectedContact.name || selectedContact.phone;
    }
    if (directPhone) {
      return directName || directPhone;
    }
    return null;
  }, [recipientType, selectedGroup, selectedContact, directPhone, directName]);

  const steps = useMemo(
    () => [
      {
        title: 'Recipient',
        component: (
          <div className="space-y-4">
            {/* Recipient type toggle */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant={recipientType === 'individual' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setRecipientType('individual');
                  setSelectedGroup(null);
                  setGroupSearch('');
                }}
              >
                <User className="size-4" />
                Individual
              </Button>
              <Button
                type="button"
                variant={recipientType === 'group' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setRecipientType('group');
                  setSelectedContact(null);
                  setDirectPhone('');
                  setDirectName('');
                  setContactSearch('');
                }}
              >
                <Users className="size-4" />
                Group
              </Button>
            </div>

            {recipientType === 'individual' ? (
              <>
                {/* Direct phone entry */}
                <div className="space-y-2">
                  <Label>Phone Number (direct entry)</Label>
                  <Input
                    value={directPhone}
                    onChange={(e) => {
                      setDirectPhone(e.target.value);
                      if (e.target.value) setSelectedContact(null);
                    }}
                    placeholder="e.g. 9876543210 or +919876543210"
                  />
                  {directPhone && (
                    <Input
                      value={directName}
                      onChange={(e) => setDirectName(e.target.value)}
                      placeholder="Name (optional)"
                    />
                  )}
                </div>

                <div className="relative flex items-center py-1">
                  <div className="flex-1 border-t" />
                  <span className="px-3 text-xs text-muted-foreground">or pick a contact</span>
                  <div className="flex-1 border-t" />
                </div>

                <div className="space-y-2">
                  <Label>Search Contacts</Label>
                  <Input
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Search by name or phone..."
                  />
                </div>

                <div className="max-h-[200px] overflow-y-auto space-y-1 rounded-md border p-2">
                  {contacts.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      {contactSearch ? 'No contacts found' : 'Start typing to search'}
                    </p>
                  ) : (
                    contacts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                          selectedContact?.id === c.id
                            ? 'bg-primary/10 border border-primary/30'
                            : ''
                        }`}
                        onClick={() => {
                          setSelectedContact(c);
                          setDirectPhone('');
                          setDirectName('');
                        }}
                      >
                        <User className="size-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">
                            {c.name || 'Unnamed'}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono">
                            {c.phone}
                          </p>
                        </div>
                        {selectedContact?.id === c.id && (
                          <Badge variant="secondary" className="shrink-0">
                            Selected
                          </Badge>
                        )}
                      </button>
                    ))
                  )}
                </div>

                {selectedContact && (
                  <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3">
                    <User className="size-4 text-primary" />
                    <span className="text-sm font-medium">
                      {selectedContact.name || selectedContact.phone}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Group picker */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 space-y-2">
                    <Label>Search Groups</Label>
                    <Input
                      value={groupSearch}
                      onChange={(e) => setGroupSearch(e.target.value)}
                      placeholder="Search by group name..."
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-6"
                    onClick={() => syncGroupsMutation.mutate()}
                    disabled={syncGroupsMutation.isPending}
                  >
                    <RefreshCw className={`size-4 ${syncGroupsMutation.isPending ? 'animate-spin' : ''}`} />
                    Sync
                  </Button>
                </div>

                <div className="max-h-[200px] overflow-y-auto space-y-1 rounded-md border p-2">
                  {groupsList.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      {groupSearch ? 'No groups found' : 'No groups synced. Click Sync to fetch groups from WhatsApp.'}
                    </p>
                  ) : (
                    groupsList.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                          selectedGroup?.id === g.id
                            ? 'bg-primary/10 border border-primary/30'
                            : ''
                        }`}
                        onClick={() => setSelectedGroup(g)}
                      >
                        <Users className="size-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{g.name}</p>
                          {g.participantCount != null && (
                            <p className="text-xs text-muted-foreground">
                              {g.participantCount} participants
                            </p>
                          )}
                        </div>
                        {selectedGroup?.id === g.id && (
                          <Badge variant="secondary" className="shrink-0">
                            Selected
                          </Badge>
                        )}
                      </button>
                    ))
                  )}
                </div>

                {selectedGroup && (
                  <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3">
                    <Users className="size-4 text-primary" />
                    <span className="text-sm font-medium">{selectedGroup.name}</span>
                  </div>
                )}
              </>
            )}
          </div>
        ),
        validate: () => {
          if (recipientType === 'group') {
            if (!selectedGroup) {
              toast.error('Please select a group');
              return false;
            }
          } else {
            if (!selectedContact && !directPhone.trim()) {
              toast.error('Please select a contact or enter a phone number');
              return false;
            }
          }
          return true;
        },
      },
      {
        title: 'Compose',
        component: (
          <div className="space-y-4">
            {templates.length > 0 && recipientType === 'individual' && (
              <div className="space-y-2">
                <Label>
                  <FileText className="inline size-3 mr-1" />
                  Use Template (optional)
                </Label>
                <Select
                  value={selectedTemplateId}
                  onValueChange={handleTemplateSelect}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="msg-content">Message</Label>
              <Textarea
                id="msg-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Type your message..."
                rows={5}
              />
              <div className="flex justify-end">
                <span className="text-xs text-muted-foreground">
                  {content.length} character{content.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>
        ),
        validate: () => {
          if (!content.trim()) {
            toast.error('Please enter a message');
            return false;
          }
          return true;
        },
      },
      {
        title: 'Schedule',
        component: (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendNow}
                  onChange={(e) => setSendNow(e.target.checked)}
                  className="size-4 rounded"
                />
                <span className="text-sm font-medium">Send now</span>
              </label>
            </div>

            {!sendNow && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="sched-date">
                    <Calendar className="inline size-3 mr-1" />
                    Date
                  </Label>
                  <Input
                    id="sched-date"
                    type="date"
                    value={scheduledDate}
                    onChange={(e) => setScheduledDate(e.target.value)}
                    min={format(new Date(), 'yyyy-MM-dd')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="sched-time">Time</Label>
                  <Input
                    id="sched-time"
                    type="time"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                  />
                </div>

                <p className="text-xs text-muted-foreground">
                  Messages are scheduled in your local timezone.
                </p>
              </>
            )}

            {/* Summary */}
            {recipientDisplay && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-1.5 text-sm">
                <p>
                  <span className="text-muted-foreground">To:</span>{' '}
                  <span className="font-medium">
                    {recipientType === 'group' && <Users className="inline size-3 mr-1" />}
                    {recipientDisplay}
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">Message:</span>{' '}
                  <span className="line-clamp-2">{content}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">When:</span>{' '}
                  {sendNow
                    ? 'Immediately'
                    : scheduledDate
                      ? `${scheduledDate} at ${scheduledTime}`
                      : 'Not set'}
                </p>
              </div>
            )}
          </div>
        ),
        validate: () => {
          if (!sendNow && !scheduledDate) {
            toast.error('Please select a date or choose "Send now"');
            return false;
          }
          return true;
        },
      },
    ],
    [
      recipientType,
      contactSearch,
      selectedContact,
      contacts,
      directPhone,
      directName,
      groupSearch,
      selectedGroup,
      groupsList,
      syncGroupsMutation,
      content,
      selectedTemplateId,
      templates,
      sendNow,
      scheduledDate,
      scheduledTime,
      recipientDisplay,
    ],
  );

  const handleComplete = useCallback(async () => {
    let scheduledAt: string | undefined;
    if (!sendNow && scheduledDate) {
      const dt = new Date(`${scheduledDate}T${scheduledTime}`);
      scheduledAt = dt.toISOString();
    }

    if (recipientType === 'group' && selectedGroup) {
      await scheduleMutation.mutateAsync({
        groupId: selectedGroup.id,
        content: content.trim(),
        scheduledAt,
      });
    } else if (selectedContact) {
      await scheduleMutation.mutateAsync({
        contactId: selectedContact.id,
        content: content.trim(),
        scheduledAt,
      });
    } else if (directPhone.trim()) {
      await scheduleMutation.mutateAsync({
        phone: directPhone.trim(),
        name: directName.trim() || undefined,
        content: content.trim(),
        scheduledAt,
      });
    }
  }, [recipientType, selectedGroup, selectedContact, directPhone, directName, sendNow, scheduledDate, scheduledTime, content, scheduleMutation]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule Message</DialogTitle>
        </DialogHeader>
        <Wizard
          steps={steps}
          onComplete={handleComplete}
          onCancel={handleClose}
          completeLabel="Schedule"
        />
      </DialogContent>
    </Dialog>
  );
}
