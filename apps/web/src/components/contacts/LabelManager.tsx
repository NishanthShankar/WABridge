import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Label, Contact } from '@/types/api';

const PRESET_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#84cc16', // lime
];

interface LabelManagerProps {
  /** When provided, shows label assignment checkboxes for this contact */
  contact?: Contact | null;
  onClose?: () => void;
}

export function LabelManager({ contact, onClose }: LabelManagerProps) {
  const queryClient = useQueryClient();
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState(PRESET_COLORS[0]);
  const [editingLabel, setEditingLabel] = useState<Label | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [deleteLabel, setDeleteLabel] = useState<Label | null>(null);

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.labels.all,
    queryFn: api.labels.list,
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; color?: string }) => api.labels.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labels.all });
      setNewLabelName('');
      toast.success('Label created');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create label'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; color?: string | null } }) =>
      api.labels.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labels.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      setEditingLabel(null);
      toast.success('Label updated');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update label'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.labels.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labels.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('Label deleted');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete label'),
  });

  const assignMutation = useMutation({
    mutationFn: ({ contactId, labelIds }: { contactId: string; labelIds: string[] }) =>
      api.contacts.assignLabel(contactId, labelIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('Labels updated');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to assign label'),
  });

  const removeLabelMutation = useMutation({
    mutationFn: ({ contactId, labelId }: { contactId: string; labelId: string }) =>
      api.contacts.removeLabel(contactId, labelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove label'),
  });

  function handleCreateLabel(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabelName.trim()) return;
    createMutation.mutate({ name: newLabelName.trim(), color: newLabelColor });
  }

  function handleUpdateLabel() {
    if (!editingLabel || !editName.trim()) return;
    updateMutation.mutate({
      id: editingLabel.id,
      data: { name: editName.trim(), color: editColor },
    });
  }

  function startEdit(label: Label) {
    setEditingLabel(label);
    setEditName(label.name);
    setEditColor(label.color ?? PRESET_COLORS[0] ?? '#3b82f6');
  }

  function handleToggleLabel(labelId: string) {
    if (!contact) return;
    const isAssigned = contact.labels.some((l) => l.id === labelId);
    if (isAssigned) {
      removeLabelMutation.mutate({ contactId: contact.id, labelId });
    } else {
      assignMutation.mutate({ contactId: contact.id, labelIds: [labelId] });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Tag className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Labels</h3>
        {onClose && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        )}
      </div>

      {/* Create new label */}
      <form onSubmit={handleCreateLabel} className="flex items-center gap-2">
        <Input
          value={newLabelName}
          onChange={(e) => setNewLabelName(e.target.value)}
          placeholder="New label name"
          className="h-8 text-sm"
        />
        <div className="flex gap-1">
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="size-5 rounded-full ring-offset-background transition-all"
              style={{
                backgroundColor: color,
                outline: newLabelColor === color ? '2px solid currentColor' : 'none',
                outlineOffset: '2px',
              }}
              onClick={() => setNewLabelColor(color)}
            />
          ))}
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!newLabelName.trim()}>
          <Plus className="size-3" />
        </Button>
      </form>

      {/* Labels list */}
      <div className="space-y-2">
        {labels.map((label) => (
          <div key={label.id} className="flex items-center gap-2 group">
            {contact && (
              <input
                type="checkbox"
                checked={contact.labels.some((l) => l.id === label.id)}
                onChange={() => handleToggleLabel(label.id)}
                className="size-4 rounded"
              />
            )}

            {editingLabel?.id === label.id ? (
              <div className="flex items-center gap-2 flex-1">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-7 text-sm"
                  autoFocus
                />
                <div className="flex gap-1">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className="size-4 rounded-full"
                      style={{
                        backgroundColor: color,
                        outline: editColor === color ? '2px solid currentColor' : 'none',
                        outlineOffset: '1px',
                      }}
                      onClick={() => setEditColor(color)}
                    />
                  ))}
                </div>
                <Button size="xs" onClick={handleUpdateLabel}>
                  Save
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setEditingLabel(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <Badge
                  variant="secondary"
                  className="gap-1"
                  style={
                    label.color
                      ? { backgroundColor: `${label.color}20`, color: label.color, borderColor: `${label.color}40` }
                      : undefined
                  }
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: label.color ?? '#888' }}
                  />
                  {label.name}
                </Badge>
                <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon-xs" onClick={() => startEdit(label)}>
                    <Pencil className="size-3" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" onClick={() => setDeleteLabel(label)}>
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}

        {labels.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">
            No labels yet. Create one above.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteLabel}
        onOpenChange={(o) => !o && setDeleteLabel(null)}
        title="Delete Label"
        description={`Delete "${deleteLabel?.name}"? It will be removed from all contacts.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleteLabel && deleteMutation.mutate(deleteLabel.id)}
      />
    </div>
  );
}
