import React, { useState } from 'react';
import { useGetBotAdmins, useAddBotAdmin, useRemoveBotAdmin, getGetBotAdminsQueryKey } from '@workspace/api-client-react';
import { Card, Input, Button, Badge, Skeleton, Label } from '@/components/ui';
import { Shield, ShieldAlert, Trash2, Plus, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

const addAdminSchema = z.object({
  discordUserId: z.string().min(17, 'ID deve ter pelo menos 17 caracteres').max(20, 'ID deve ter no máximo 20 caracteres').regex(/^\d+$/, 'ID deve conter apenas números'),
  discordUsername: z.string().min(2, 'Username é obrigatório'),
});

type AddAdminFormValues = z.infer<typeof addAdminSchema>;

export default function AdminsPage() {
  const { data: admins, isLoading } = useGetBotAdmins();
  const queryClient = useQueryClient();
  
  const addMutation = useAddBotAdmin();
  const removeMutation = useRemoveBotAdmin();
  
  const [showAddForm, setShowAddForm] = useState(false);

  const form = useForm<AddAdminFormValues>({
    resolver: zodResolver(addAdminSchema),
    defaultValues: {
      discordUserId: '',
      discordUsername: '',
    },
  });

  const onSubmit = (data: AddAdminFormValues) => {
    addMutation.mutate({ data }, {
      onSuccess: () => {
        toast.success('Admin added successfully');
        queryClient.invalidateQueries({ queryKey: getGetBotAdminsQueryKey() });
        setShowAddForm(false);
        form.reset();
      },
      onError: () => {
        toast.error('Failed to add admin');
      }
    });
  };

  const handleRemove = (id: string, username: string) => {
    if (confirm(`Are you sure you want to remove ${username} from bot admins?`)) {
      removeMutation.mutate({ discordUserId: id }, {
        onSuccess: () => {
          toast.success('Admin removed successfully');
          queryClient.invalidateQueries({ queryKey: getGetBotAdminsQueryKey() });
        },
        onError: () => {
          toast.error('Failed to remove admin');
        }
      });
    }
  };

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Bot Administrators</h1>
          <p className="text-muted-foreground">Manage users who have administrative privileges within the bot.</p>
        </div>
        
        <Button onClick={() => setShowAddForm(!showAddForm)} className="shrink-0 gap-2">
          {showAddForm ? 'Cancel' : <><Plus className="h-4 w-4" /> Add Admin</>}
        </Button>
      </div>

      {showAddForm && (
        <Card className="mb-8 border-primary/20 bg-primary/5 shadow-sm animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4 text-primary font-semibold">
              <ShieldAlert className="h-5 w-5" />
              Grant Administrative Access
            </div>
            
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col md:flex-row gap-4 items-start">
              <div className="space-y-2 flex-1 w-full">
                <Label htmlFor="discordUserId">Discord User ID</Label>
                <Input 
                  id="discordUserId" 
                  placeholder="e.g. 123456789012345678" 
                  {...form.register('discordUserId')} 
                  className="font-mono bg-background"
                />
                {form.formState.errors.discordUserId && (
                  <p className="text-xs text-destructive">{form.formState.errors.discordUserId.message}</p>
                )}
              </div>
              
              <div className="space-y-2 flex-1 w-full">
                <Label htmlFor="discordUsername">Discord Username</Label>
                <Input 
                  id="discordUsername" 
                  placeholder="e.g. wumpus" 
                  {...form.register('discordUsername')}
                  className="bg-background"
                />
                {form.formState.errors.discordUsername && (
                  <p className="text-xs text-destructive">{form.formState.errors.discordUsername.message}</p>
                )}
              </div>
              
              <div className="pt-8 w-full md:w-auto">
                <Button type="submit" disabled={addMutation.isPending} className="w-full md:w-auto">
                  {addMutation.isPending ? 'Adding...' : 'Confirm Access'}
                </Button>
              </div>
            </form>
            
            <div className="mt-4 flex items-start gap-2 text-xs text-muted-foreground bg-background/50 p-3 rounded-md border border-border">
              <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p>Bot admins have full access to all privileged commands across all guilds the bot is in. Ensure you trust the user before granting these permissions.</p>
            </div>
          </div>
        </Card>
      )}

      <Card className="border-border/50 shadow-sm overflow-hidden">
        <div className="table-container border-0 rounded-none">
          <table className="w-full">
            <thead>
              <tr>
                <th className="font-mono text-xs uppercase tracking-wider">Admin User</th>
                <th className="w-[200px] font-mono text-xs uppercase tracking-wider">Discord ID</th>
                <th className="w-[200px] font-mono text-xs uppercase tracking-wider">Added By</th>
                <th className="w-[180px] font-mono text-xs uppercase tracking-wider">Date Added</th>
                <th className="w-[80px] text-right font-mono text-xs uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td><div className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-full" /><Skeleton className="h-4 w-32" /></div></td>
                    <td><Skeleton className="h-5 w-32 rounded" /></td>
                    <td><Skeleton className="h-4 w-24" /></td>
                    <td><Skeleton className="h-4 w-24" /></td>
                    <td className="text-right"><Skeleton className="h-8 w-8 ml-auto rounded" /></td>
                  </tr>
                ))
              ) : admins && admins.length > 0 ? (
                admins.map((admin) => (
                  <tr key={admin.discordUserId} className="group">
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                          <Shield className="h-4 w-4" />
                        </div>
                        <span className="font-semibold text-base">{admin.discordUsername}</span>
                      </div>
                    </td>
                    <td>
                      <Badge variant="secondary" className="font-mono font-normal">
                        {admin.discordUserId}
                      </Badge>
                    </td>
                    <td className="text-muted-foreground text-sm">
                      {admin.addedBy}
                    </td>
                    <td className="text-muted-foreground text-sm">
                      {format(new Date(admin.addedAt), 'MMM dd, yyyy')}
                    </td>
                    <td className="text-right">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleRemove(admin.discordUserId, admin.discordUsername)}
                        disabled={removeMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="h-32 text-center text-muted-foreground">
                    No administrators found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
