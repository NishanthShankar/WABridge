import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ResponsiveList, type Column } from '@/components/shared/ResponsiveList';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { RecurringRule, RecurringType } from '@/types/api';

const RECURRENCE_TYPES: { value: RecurringType; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom Interval' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function RecurringForm() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RecurringRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<RecurringRule | null>(null);

  // Form fields
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactId, setSelectedContactId] = useState('');
  const [directPhone, setDirectPhone] = useState('');
  const [directName, setDirectName] = useState('');
  const [type, setType] = useState<RecurringType>('daily');
  const [content, setContent] = useState('');
  const [sendHour, setSendHour] = useState(9);
  const [sendMinute, setSendMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [intervalDays, setIntervalDays] = useState(7);
  const [enabled, setEnabled] = useState(true);

  // Load data
  const { data: rulesResult, isLoading } = useQuery({
    queryKey: queryKeys.messages.recurring.all,
    queryFn: () => api.messages.recurring.list({ limit: 200 }),
  });

  const { data: contactsResult } = useQuery({
    queryKey: queryKeys.contacts.list({ search: contactSearch, limit: 50 } as Record<string, unknown>),
    queryFn: () => api.contacts.list({ search: contactSearch || undefined, limit: 50 }),
    enabled: formOpen,
  });

  const { data: templates = [] } = useQuery({
    queryKey: queryKeys.templates.all,
    queryFn: api.templates.list,
    enabled: formOpen,
  });

  const rules = rulesResult?.data ?? [];
  const contacts = contactsResult?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.messages.recurring.create>[0]) =>
      api.messages.recurring.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.recurring.all });
      toast.success('Recurring rule created');
      closeForm();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to create rule'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.messages.recurring.update>[1] }) =>
      api.messages.recurring.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.recurring.all });
      toast.success('Recurring rule updated');
      closeForm();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update rule'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.messages.recurring.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.recurring.all });
      toast.success('Recurring rule deleted');
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to delete rule'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled: en }: { id: string; enabled: boolean }) =>
      api.messages.recurring.update(id, { enabled: en }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.recurring.all });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to toggle rule'),
  });

  function openCreate() {
    setEditingRule(null);
    setSelectedContactId('');
    setContactSearch('');
    setDirectPhone('');
    setDirectName('');
    setType('daily');
    setContent('');
    setSendHour(9);
    setSendMinute(0);
    setDayOfWeek(1);
    setDayOfMonth(1);
    setIntervalDays(7);
    setEnabled(true);
    setFormOpen(true);
  }

  function openEdit(rule: RecurringRule) {
    setEditingRule(rule);
    setSelectedContactId(rule.contactId);
    setType(rule.type);
    setContent(rule.content);
    setEnabled(rule.enabled);
    // Parse time from cron or use defaults
    setSendHour(9);
    setSendMinute(0);
    setDayOfWeek(1);
    setDayOfMonth(1);
    setIntervalDays(rule.intervalDays ?? 7);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingRule(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!selectedContactId && !directPhone.trim()) {
      toast.error('Please select a contact or enter a phone number');
      return;
    }
    if (!content.trim()) {
      toast.error('Please enter message content');
      return;
    }

    const base = {
      ...(selectedContactId
        ? { contactId: selectedContactId }
        : { phone: directPhone.trim(), name: directName.trim() || undefined }),
      type,
      content: content.trim(),
      sendHour,
      sendMinute,
      ...(type === 'weekly' ? { dayOfWeek } : {}),
      ...(type === 'monthly' ? { dayOfMonth } : {}),
      ...(type === 'custom' ? { intervalDays } : {}),
    };

    if (editingRule) {
      const { contactId: _cid, phone: _p, name: _n, ...updateData } = base as Record<string, unknown>;
      updateMutation.mutate({
        id: editingRule.id,
        data: { ...updateData, enabled } as Parameters<typeof updateMutation.mutate>[0]['data'],
      });
    } else {
      createMutation.mutate(base);
    }
  }

  function handleTemplateSelect(templateId: string) {
    const template = templates.find((t) => t.id === templateId);
    if (template) {
      setContent(template.body);
    }
  }

  const columns: Column<RecurringRule>[] = [
    {
      header: 'Contact',
      accessor: (r) => (
        <span className="font-medium">
          {r.contactName || r.contactPhone}
        </span>
      ),
    },
    {
      header: 'Type',
      accessor: (r) => (
        <Badge variant="outline" className="capitalize">
          {r.type}
        </Badge>
      ),
    },
    {
      header: 'Message',
      accessor: (r) => (
        <span className="text-sm line-clamp-1 max-w-[200px]">
          {r.content}
        </span>
      ),
    },
    {
      header: 'Enabled',
      accessor: (r) => (
        <label
          className="relative inline-flex cursor-pointer items-center"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) =>
              toggleMutation.mutate({ id: r.id, enabled: e.target.checked })
            }
            className="size-4 rounded"
          />
          <span className="ml-2 text-xs text-muted-foreground">
            {r.enabled ? 'On' : 'Off'}
          </span>
        </label>
      ),
    },
    {
      header: 'Actions',
      accessor: (r) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon-xs" onClick={() => openEdit(r)}>
            <Pencil className="size-3" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => setDeleteRule(r)}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ),
    },
  ];

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Recurring Rules</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">New Rule</span>
        </Button>
      </div>

      {/* Rules list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <ResponsiveList
          data={rules}
          columns={columns}
          onRowClick={openEdit}
          emptyState={
            <EmptyState
              icon={RotateCcw}
              title="No recurring rules"
              description="Create a recurring rule to automatically send messages on a schedule."
              action={{ label: 'Create Rule', onClick: openCreate }}
            />
          }
        />
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={formOpen} onOpenChange={(o) => { if (!o) closeForm(); else setFormOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingRule ? 'Edit Recurring Rule' : 'New Recurring Rule'}
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Contact picker */}
            {!editingRule && (
              <div className="space-y-2">
                <Label>Phone Number (direct entry)</Label>
                <Input
                  value={directPhone}
                  onChange={(e) => {
                    setDirectPhone(e.target.value);
                    if (e.target.value) {
                      setSelectedContactId('');
                      setContactSearch('');
                    }
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

                <div className="relative flex items-center py-1">
                  <div className="flex-1 border-t" />
                  <span className="px-3 text-xs text-muted-foreground">or pick a contact</span>
                  <div className="flex-1 border-t" />
                </div>

                <Input
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  placeholder="Search contacts..."
                />
                {contacts.length > 0 && !selectedContactId && (
                  <div className="max-h-[120px] overflow-y-auto rounded-md border p-1 space-y-0.5">
                    {contacts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="w-full text-left px-2 py-1 text-sm rounded hover:bg-muted"
                        onClick={() => {
                          setSelectedContactId(c.id);
                          setContactSearch(c.name || c.phone);
                          setDirectPhone('');
                          setDirectName('');
                        }}
                      >
                        {c.name || 'Unnamed'}{' '}
                        <span className="text-xs text-muted-foreground font-mono">
                          {c.phone}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Type */}
            <div className="space-y-2">
              <Label>Recurrence Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as RecurringType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Type-specific fields */}
            {type === 'weekly' && (
              <div className="space-y-2">
                <Label>Day of Week</Label>
                <div className="flex gap-1 flex-wrap">
                  {DAY_NAMES.map((name, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        dayOfWeek === i
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                      onClick={() => setDayOfWeek(i)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {type === 'monthly' && (
              <div className="space-y-2">
                <Label htmlFor="day-of-month">Day of Month</Label>
                <Input
                  id="day-of-month"
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                />
              </div>
            )}

            {type === 'custom' && (
              <div className="space-y-2">
                <Label htmlFor="interval-days">Repeat every N days</Label>
                <Input
                  id="interval-days"
                  type="number"
                  min={1}
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(Number(e.target.value))}
                />
              </div>
            )}

            {/* Time */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="send-hour">Hour (0-23)</Label>
                <Input
                  id="send-hour"
                  type="number"
                  min={0}
                  max={23}
                  value={sendHour}
                  onChange={(e) => setSendHour(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="send-minute">Minute (0-59)</Label>
                <Input
                  id="send-minute"
                  type="number"
                  min={0}
                  max={59}
                  value={sendMinute}
                  onChange={(e) => setSendMinute(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Message content */}
            <div className="space-y-2">
              <Label>Message Content</Label>
              {templates.length > 0 && (
                <Select onValueChange={handleTemplateSelect}>
                  <SelectTrigger>
                    <SelectValue placeholder="Load from template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Message content (supports {{name}}, {{phone}} variables)"
                rows={3}
              />
            </div>

            {/* Enabled toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4 rounded"
              />
              <span className="text-sm">Enabled</span>
            </label>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending
                  ? 'Saving...'
                  : editingRule
                    ? 'Update Rule'
                    : 'Create Rule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteRule}
        onOpenChange={(o) => !o && setDeleteRule(null)}
        title="Delete Recurring Rule"
        description="Are you sure you want to delete this recurring rule? Future scheduled messages will not be sent."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (deleteRule) deleteMutation.mutate(deleteRule.id);
          setDeleteRule(null);
        }}
      />
    </div>
  );
}
