import React from 'react';
import { useLocation, Link } from 'wouter';
import { useAuth } from '@/hooks/use-auth';
import { removeToken } from '@/lib/auth';
import { Terminal, LayoutDashboard, Users, Shield, List, LogOut, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui';

export function Shell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user, isAuthenticated, isLoading } = useAuth();

  // If we're on login page, don't show the shell
  if (location === '/login') {
    return <>{children}</>;
  }

  // Redirect to login if not authenticated
  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation('/login');
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading || !isAuthenticated) {
    return null; // Will redirect or is loading
  }

  const navItems = [
    { icon: LayoutDashboard, label: 'Dashboard', href: '/dashboard' },
    { icon: List, label: 'Command Logs', href: '/logs' },
    { icon: Users, label: 'Top Users', href: '/usuarios' },
    { icon: Shield, label: 'Bot Admins', href: '/admins' },
  ];

  const handleLogout = () => {
    removeToken();
    setLocation('/login');
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col hidden md:flex shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 bg-primary rounded-lg flex items-center justify-center">
              <Terminal className="text-white h-4 w-4" />
            </div>
            <span className="font-bold font-mono tracking-tight text-lg">KAMI<span className="text-primary">BOT</span></span>
          </div>
        </div>

        <div className="p-4 flex-1 flex flex-col gap-1 overflow-y-auto">
          <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Overview
          </div>
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <item.icon className={cn("h-4 w-4", isActive ? "text-primary-foreground" : "text-muted-foreground")} />
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-border bg-muted/20">
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">
              {user?.name?.charAt(0).toUpperCase() || 'A'}
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold leading-none">{user?.name}</span>
              <span className="text-xs text-muted-foreground mt-1">{user?.email}</span>
            </div>
          </div>
          <Button variant="outline" className="w-full justify-start text-muted-foreground" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-background">
        {/* Mobile Header */}
        <header className="h-16 border-b border-border bg-card flex md:hidden items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-primary" />
            <span className="font-bold font-mono">KAMI<span className="text-primary">BOT</span></span>
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="h-5 w-5" />
          </Button>
        </header>

        {/* Mobile Nav */}
        <div className="md:hidden flex overflow-x-auto p-4 gap-2 border-b border-border bg-card shrink-0 scrollbar-hide">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap",
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "bg-muted text-muted-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
