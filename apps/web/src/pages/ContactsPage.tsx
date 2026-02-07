import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ContactList } from '@/components/contacts/ContactList';
import { ContactForm } from '@/components/contacts/ContactForm';
import { ImportWizard } from '@/components/contacts/ImportWizard';
import { LabelManager } from '@/components/contacts/LabelManager';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Contact } from '@/types/api';

export function ContactsPage() {
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);

  const { data: contactsResult } = useQuery({
    queryKey: queryKeys.contacts.list({ page: 1 }),
    queryFn: () => api.contacts.list({ page: 1, limit: 1 }),
  });

  const totalContacts = contactsResult?.total ?? 0;

  function handleAdd() {
    setEditContact(null);
    setFormOpen(true);
  }

  function handleEdit(contact: Contact) {
    setEditContact(contact);
    setFormOpen(true);
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            {totalContacts > 0
              ? `${totalContacts} contact${totalContacts !== 1 ? 's' : ''}`
              : 'Manage your WhatsApp contacts'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setLabelsOpen(true)}>
          <Tag className="size-4" />
          <span className="hidden sm:inline">Labels</span>
        </Button>
      </div>

      {/* Contact List */}
      <ContactList
        onAdd={handleAdd}
        onEdit={handleEdit}
        onImport={() => setImportOpen(true)}
      />

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditContact(null);
        }}
        contact={editContact}
      />

      {/* Import Wizard Dialog */}
      <ImportWizard open={importOpen} onOpenChange={setImportOpen} />

      {/* Label Manager Dialog */}
      <Dialog open={labelsOpen} onOpenChange={setLabelsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage Labels</DialogTitle>
          </DialogHeader>
          <LabelManager
            onClose={() => setLabelsOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
