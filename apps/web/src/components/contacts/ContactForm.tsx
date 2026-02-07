import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Contact } from '@/types/api';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
}

export function ContactForm({ open, onOpenChange, contact }: ContactFormProps) {
  const queryClient = useQueryClient();
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [birthday, setBirthday] = useState('');
  const [notes, setNotes] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setBirthday(contact?.birthday ?? '');
      setNotes(contact?.notes ?? '');
      setPhoneError('');
    }
  }, [open, contact]);

  const createMutation = useMutation({
    mutationFn: (data: { phone: string; name?: string; email?: string; notes?: string; birthday?: string }) =>
      api.contacts.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('Contact created');
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create contact');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { phone?: string; name?: string; email?: string; notes?: string; birthday?: string | null }) =>
      api.contacts.update(contact!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('Contact updated');
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update contact');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.contacts.delete(contact!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('Contact deleted');
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete contact');
    },
  });

  function validatePhone(value: string): boolean {
    // Basic Indian phone validation: 10+ digits, optionally prefixed with +91
    const cleaned = value.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+91')) {
      return cleaned.length >= 12;
    }
    return cleaned.length >= 10;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!validatePhone(phone)) {
      setPhoneError('Enter a valid phone number (10+ digits, e.g., 9876543210)');
      return;
    }

    const data = {
      phone: phone.trim(),
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      notes: notes.trim() || undefined,
      birthday: birthday.trim() || undefined,
    };

    if (isEdit) {
      updateMutation.mutate({
        ...data,
        birthday: birthday.trim() || null,
      });
    } else {
      createMutation.mutate(data);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit Contact' : 'Add Contact'}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Customer name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">
                Phone <span className="text-destructive">*</span>
              </Label>
              <Input
                id="phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setPhoneError('');
                }}
                placeholder="+91 9876543210"
                aria-invalid={!!phoneError}
              />
              {phoneError && (
                <p className="text-xs text-destructive">{phoneError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Indian number with or without +91 prefix
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="birthday">Birthday (MM-DD)</Label>
              <Input
                id="birthday"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                placeholder="03-15"
                maxLength={5}
              />
              <p className="text-xs text-muted-foreground">
                Format: MM-DD (e.g., 03-15 for March 15)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes about this contact"
                rows={3}
              />
            </div>

            <DialogFooter className="gap-2">
              {isEdit && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="mr-auto"
                >
                  Delete
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Contact'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Contact"
        description={`Are you sure you want to delete ${contact?.name || contact?.phone || 'this contact'}? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleteMutation.mutate()}
      />
    </>
  );
}
