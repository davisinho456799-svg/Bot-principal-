import React from 'react';
import { useGetUsuarios } from '@workspace/api-client-react';
import { Card, Badge, Skeleton } from '@/components/ui';
import { Users, Trophy, Target, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function UsuariosPage() {
  const { data: users, isLoading } = useGetUsuarios();

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Active Users</h1>
          <p className="text-muted-foreground">Global ranking of the most engaged community members.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-6 border-border/50 flex items-center gap-4">
              <Skeleton className="w-16 h-16 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
            </Card>
          ))
        ) : users && users.length >= 3 ? (
          <>
            {/* 2nd Place */}
            <Card className="p-6 border-border/50 flex flex-col items-center text-center gap-3 relative overflow-hidden order-2 md:order-1 mt-4">
              <div className="absolute top-0 w-full h-1 bg-slate-400" />
              <div className="w-16 h-16 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-2xl font-bold border-4 border-white shadow-sm z-10">
                2
              </div>
              <div>
                <h3 className="font-bold text-lg">{users[1].discordUsername}</h3>
                <Badge variant="secondary" className="mt-1 font-mono">{users[1].total} cmds</Badge>
              </div>
            </Card>
            
            {/* 1st Place */}
            <Card className="p-6 border-amber-500/50 shadow-md flex flex-col items-center text-center gap-3 relative overflow-hidden order-1 md:order-2">
              <div className="absolute top-0 w-full h-2 bg-gradient-to-r from-amber-400 to-amber-600" />
              <div className="absolute -top-10 -right-10 w-32 h-32 bg-amber-500/10 rounded-full blur-2xl" />
              <div className="w-20 h-20 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-4xl font-bold border-4 border-white shadow-md z-10 relative">
                <Trophy className="absolute -top-3 h-6 w-6 text-amber-500" />
                1
              </div>
              <div>
                <h3 className="font-bold text-xl">{users[0].discordUsername}</h3>
                <Badge className="mt-1 bg-amber-500 hover:bg-amber-600 text-white font-mono text-sm px-3 py-1">
                  {users[0].total} cmds
                </Badge>
              </div>
            </Card>
            
            {/* 3rd Place */}
            <Card className="p-6 border-border/50 flex flex-col items-center text-center gap-3 relative overflow-hidden order-3 mt-8">
              <div className="absolute top-0 w-full h-1 bg-amber-800" />
              <div className="w-14 h-14 rounded-full bg-amber-900/10 text-amber-800 flex items-center justify-center text-xl font-bold border-4 border-white shadow-sm z-10">
                3
              </div>
              <div>
                <h3 className="font-bold text-lg">{users[2].discordUsername}</h3>
                <Badge variant="secondary" className="mt-1 font-mono">{users[2].total} cmds</Badge>
              </div>
            </Card>
          </>
        ) : null}
      </div>

      <Card className="border-border/50 shadow-sm overflow-hidden">
        <div className="table-container border-0 rounded-none">
          <table className="w-full">
            <thead>
              <tr>
                <th className="w-[80px] text-center font-mono text-xs uppercase tracking-wider">Rank</th>
                <th className="font-mono text-xs uppercase tracking-wider">User</th>
                <th className="w-[200px] font-mono text-xs uppercase tracking-wider text-right">Total Commands</th>
                <th className="w-[250px] font-mono text-xs uppercase tracking-wider text-right">Last Active</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    <td className="text-center"><Skeleton className="h-6 w-6 rounded-full mx-auto" /></td>
                    <td><Skeleton className="h-4 w-32" /></td>
                    <td className="text-right"><Skeleton className="h-6 w-16 ml-auto rounded-full" /></td>
                    <td className="text-right"><Skeleton className="h-4 w-24 ml-auto" /></td>
                  </tr>
                ))
              ) : users && users.length > 0 ? (
                users.map((user, index) => (
                  <tr key={user.discordUserId} className="group">
                    <td className="text-center">
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                        index < 3 ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                      }`}>
                        {index + 1}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-muted flex items-center justify-center shrink-0">
                          <Users className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="font-semibold group-hover:text-primary transition-colors">{user.discordUsername}</p>
                          <p className="text-xs text-muted-foreground font-mono">{user.discordUserId}</p>
                        </div>
                      </div>
                    </td>
                    <td className="text-right">
                      <Badge variant="outline" className="font-mono text-sm px-2">
                        <Target className="h-3 w-3 mr-1.5 text-muted-foreground" />
                        {new Intl.NumberFormat('en-US').format(user.total)}
                      </Badge>
                    </td>
                    <td className="text-right text-muted-foreground text-sm">
                      {user.ultimoUso ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(user.ultimoUso), { addSuffix: true })}
                        </div>
                      ) : (
                        <span className="italic text-muted/50">Never</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="h-32 text-center text-muted-foreground">
                    No user data available.
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
