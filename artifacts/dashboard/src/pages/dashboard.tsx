import React from 'react';
import { useGetStats, useGetLogs, useGetUsuarios } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Badge } from '@/components/ui';
import { Activity, Command, Users, Star, ArrowUpRight, Clock, Zap } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useGetStats();
  const { data: recentLogs, isLoading: logsLoading } = useGetLogs({ limit: 5 });
  const { data: topUsers, isLoading: usersLoading } = useGetUsuarios();

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard Overview</h1>
        <p className="text-muted-foreground">Monitor your bot's performance and community engagement.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          title="Total Commands" 
          value={stats?.totalComandos} 
          icon={Command} 
          loading={statsLoading}
          description="All-time executions"
        />
        <StatCard 
          title="Total Users" 
          value={stats?.totalUsuarios} 
          icon={Users} 
          loading={statsLoading}
          description="Unique discord users"
        />
        <StatCard 
          title="Favorites Added" 
          value={stats?.totalFavoritos} 
          icon={Star} 
          loading={statsLoading}
          description="Tracked manga/anime"
        />
        <StatCard 
          title="Most Used" 
          value={stats?.comandoMaisUsado || 'N/A'} 
          icon={Zap} 
          loading={statsLoading}
          description="Top command"
          isText
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Recent Activity */}
        <Card className="col-span-1 lg:col-span-2 border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div className="space-y-1">
              <CardTitle className="text-xl flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                Live Activity Feed
              </CardTitle>
              <CardDescription>Recent command executions across all servers</CardDescription>
            </div>
            <Link href="/logs" className="text-sm font-medium text-primary flex items-center gap-1 hover:underline">
              View all <ArrowUpRight className="h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent>
            {logsLoading ? (
              <div className="space-y-4 mt-4">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : recentLogs && recentLogs.length > 0 ? (
              <div className="space-y-4 mt-4 relative">
                <div className="absolute left-[19px] top-4 bottom-4 w-px bg-border z-0" />
                {recentLogs.map((log) => (
                  <div key={log.id} className="flex gap-4 relative z-10 group">
                    <div className="w-10 h-10 rounded-full bg-background border-2 border-border flex items-center justify-center shrink-0 group-hover:border-primary transition-colors">
                      <Command className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    <div className="flex-1 space-y-1 bg-muted/30 p-3 rounded-lg border border-transparent group-hover:border-border transition-colors">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">
                          <span className="font-bold text-foreground">{log.discordUsername}</span> used{' '}
                          <Badge variant="secondary" className="font-mono px-1.5 py-0">/{log.command}</Badge>
                        </p>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {format(new Date(log.createdAt), 'HH:mm:ss')}
                        </span>
                      </div>
                      {log.query && (
                        <p className="text-sm text-muted-foreground italic border-l-2 border-primary/30 pl-2 ml-1">
                          "{log.query}"
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No recent activity found.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Users */}
        <Card className="col-span-1 border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <Star className="h-5 w-5 text-accent" />
              Power Users
            </CardTitle>
            <CardDescription>Most active community members</CardDescription>
          </CardHeader>
          <CardContent>
            {usersLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : topUsers && topUsers.length > 0 ? (
              <div className="space-y-4">
                {topUsers.slice(0, 5).map((user, index) => (
                  <div key={user.discordUserId} className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                        index === 0 ? 'bg-amber-500/20 text-amber-500 border border-amber-500/50' : 
                        index === 1 ? 'bg-slate-300/20 text-slate-400 border border-slate-300/50' :
                        index === 2 ? 'bg-amber-700/20 text-amber-700 border border-amber-700/50' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        #{index + 1}
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{user.discordUsername}</p>
                        <p className="text-xs text-muted-foreground font-mono">{user.total} cmds</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No user data available.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function StatCard({ 
  title, 
  value, 
  icon: Icon, 
  loading, 
  description,
  isText = false 
}: { 
  title: string; 
  value: string | number | undefined; 
  icon: React.ElementType; 
  loading: boolean;
  description: string;
  isText?: boolean;
}) {
  return (
    <Card className="overflow-hidden border-border/50 shadow-sm relative group">
      <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/5 rounded-full blur-2xl group-hover:bg-primary/10 transition-colors duration-500 pointer-events-none" />
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 relative z-10">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
          <Icon className="h-4 w-4 text-primary" />
        </div>
      </CardHeader>
      <CardContent className="relative z-10">
        {loading ? (
          <Skeleton className="h-8 w-24 mb-1" />
        ) : (
          <div className={`text-2xl font-bold ${isText ? 'text-primary truncate font-mono' : ''}`}>
            {typeof value === 'number' ? new Intl.NumberFormat('en-US').format(value) : value}
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {description}
        </p>
      </CardContent>
    </Card>
  );
}
