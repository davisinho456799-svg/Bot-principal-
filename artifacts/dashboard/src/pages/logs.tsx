import React, { useState } from 'react';
import { useGetLogs } from '@workspace/api-client-react';
import { Card, Input, Button, Badge, Skeleton } from '@/components/ui';
import { Search, Filter, Terminal, Calendar, Clock, Database, ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

export default function LogsPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  
  // Simple debounce for search
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // If search term starts with "cmd:", filter by command, otherwise filter by username
  const isCmdSearch = debouncedSearch.startsWith('cmd:');
  const searchValue = isCmdSearch ? debouncedSearch.replace('cmd:', '').trim() : debouncedSearch.trim();
  
  const { data: logs, isLoading } = useGetLogs({ 
    limit: 100,
    command: isCmdSearch && searchValue ? searchValue : undefined,
    // Note: the API expects userId, but we only have username to search by easily in UI.
    // For a real app we might need a separate endpoint to search by username, or do client-side filtering.
    // For now, we'll fetch all and client-side filter if it's not a cmd search.
  });

  // Client side filtering for username (since API only supports userId or command)
  const displayLogs = React.useMemo(() => {
    if (!logs) return [];
    if (isCmdSearch || !searchValue) return logs;
    return logs.filter(log => 
      log.discordUsername.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [logs, isCmdSearch, searchValue]);

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Command Logs</h1>
          <p className="text-muted-foreground">Detailed audit trail of all bot interactions.</p>
        </div>
        
        <div className="flex items-center gap-2 w-full md:w-auto">
          <div className="relative flex-1 md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search users... (use cmd: to search commands)" 
              className="pl-9 h-10"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" className="shrink-0 h-10 w-10">
            <Filter className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="border-border/50 shadow-sm overflow-hidden flex flex-col">
        <div className="table-container rounded-none border-x-0 border-t-0 border-b">
          <table className="w-full">
            <thead>
              <tr>
                <th className="w-[180px] font-mono text-xs uppercase tracking-wider">Timestamp</th>
                <th className="w-[200px] font-mono text-xs uppercase tracking-wider">User</th>
                <th className="w-[150px] font-mono text-xs uppercase tracking-wider">Command</th>
                <th className="font-mono text-xs uppercase tracking-wider">Query / Context</th>
                <th className="w-[150px] font-mono text-xs uppercase tracking-wider text-right">Guild ID</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    <td><Skeleton className="h-4 w-32" /></td>
                    <td><Skeleton className="h-4 w-24" /></td>
                    <td><Skeleton className="h-6 w-20 rounded-full" /></td>
                    <td><Skeleton className="h-4 w-full max-w-[300px]" /></td>
                    <td className="text-right"><Skeleton className="h-4 w-24 ml-auto" /></td>
                  </tr>
                ))
              ) : displayLogs.length > 0 ? (
                displayLogs.map((log) => (
                  <tr key={log.id} className="group">
                    <td className="text-muted-foreground whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(log.createdAt), 'MMM dd, yyyy')}
                        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {format(new Date(log.createdAt), 'HH:mm:ss')}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs uppercase">
                          {log.discordUsername.charAt(0)}
                        </div>
                        <span className="font-semibold">{log.discordUsername}</span>
                      </div>
                    </td>
                    <td>
                      <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 font-medium">
                        <Terminal className="h-3 w-3 mr-1" />
                        {log.command}
                      </Badge>
                    </td>
                    <td className="text-muted-foreground">
                      {log.query ? (
                        <span className="truncate block max-w-md" title={log.query}>
                          {log.query}
                        </span>
                      ) : (
                        <span className="text-muted/50 italic">-</span>
                      )}
                    </td>
                    <td className="text-right text-muted-foreground text-xs">
                      {log.guildId ? (
                        <div className="flex items-center justify-end gap-1" title={log.guildId}>
                          <Database className="h-3 w-3" />
                          {log.guildId.substring(0, 8)}...
                        </div>
                      ) : (
                        <span className="text-muted/50 italic">DM</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="h-32 text-center text-muted-foreground">
                    No logs found matching your criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        
        <div className="p-4 flex items-center justify-between bg-muted/10">
          <p className="text-sm text-muted-foreground">
            Showing <span className="font-medium text-foreground">{displayLogs.length}</span> results
            {isCmdSearch && searchValue && <span> for command <span className="font-mono text-primary">{searchValue}</span></span>}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled>
              <ChevronLeft className="h-4 w-4 mr-1" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled>
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
