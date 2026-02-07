import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Upload, UserPlus, Users } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ResponsiveList, type Column } from '@/components/shared/ResponsiveList';
import { EmptyState } from '@/components/shared/EmptyState';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Contact } from '@/types/api';

interface ContactListProps {
  onAdd: () => void;
  onEdit: (contact: Contact) => void;
  onImport: () => void;
}

export function ContactList({ onAdd, onEdit, onImport }: ContactListProps) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search input
  const searchTimeoutRef = useState<ReturnType<typeof setTimeout> | null>(null);
  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchTimeoutRef[0]) clearTimeout(searchTimeoutRef[0]);
    searchTimeoutRef[0] = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  }

  const params = {
    page,
    limit: 20,
    search: debouncedSearch || undefined,
    label: labelFilter || undefined,
  };

  const { data: contactsResult, isLoading } = useQuery({
    queryKey: queryKeys.contacts.list(params as Record<string, unknown>),
    queryFn: () => api.contacts.list(params),
  });

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.labels.all,
    queryFn: api.labels.list,
  });

  const contacts = contactsResult?.data ?? [];
  const total = contactsResult?.total ?? 0;
  const totalPages = Math.ceil(total / 20);

  const columns: Column<Contact>[] = [
    {
      header: 'Name',
      accessor: (c) => (
        <span className="font-medium">{c.name || 'Unnamed'}</span>
      ),
    },
    {
      header: 'Phone',
      accessor: (c) => <span className="font-mono text-xs">{c.phone}</span>,
    },
    {
      header: 'Labels',
      accessor: (c) =>
        c.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {c.labels.map((label) => (
              <Badge
                key={label.id}
                variant="secondary"
                className="text-xs"
                style={
                  label.color
                    ? {
                        backgroundColor: `${label.color}20`,
                        color: label.color,
                        borderColor: `${label.color}40`,
                      }
                    : undefined
                }
              >
                {label.name}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">--</span>
        ),
    },
    {
      header: 'Created',
      accessor: (c) => (
        <span className="text-xs text-muted-foreground">
          {format(new Date(c.createdAt), 'MMM d, yyyy')}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search contacts..."
            className="pl-9"
          />
        </div>

        <Select
          value={labelFilter}
          onValueChange={(v) => {
            setLabelFilter(v === '_all' ? '' : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="All labels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All labels</SelectItem>
            {labels.map((label) => (
              <SelectItem key={label.id} value={label.id}>
                {label.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={onImport}>
            <Upload className="size-4" />
            <span className="hidden sm:inline">Import</span>
          </Button>
          <Button size="sm" onClick={onAdd}>
            <UserPlus className="size-4" />
            <span className="hidden sm:inline">Add Contact</span>
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <ResponsiveList
          data={contacts}
          columns={columns}
          onRowClick={onEdit}
          emptyState={
            <EmptyState
              icon={Users}
              title="No contacts yet"
              description="Import your contacts from a CSV or Excel file, or add them one by one."
              action={{ label: 'Import Contacts', onClick: onImport }}
            />
          }
        />
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <p className="text-sm text-muted-foreground">
            {total} contact{total !== 1 ? 's' : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
