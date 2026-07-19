import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter, Redirect } from 'wouter';
import { Toaster } from 'sonner';
import { Shell } from '@/components/shell';

// Pages
import LoginPage from '@/pages/login';
import DashboardPage from '@/pages/dashboard';
import LogsPage from '@/pages/logs';
import UsuariosPage from '@/pages/usuarios';
import AdminsPage from '@/pages/admins';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
      <h1 className="text-6xl font-bold font-mono text-primary">404</h1>
      <p className="text-xl text-muted-foreground">Sector not found.</p>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      
      <Route path="/dashboard">
        <Shell><DashboardPage /></Shell>
      </Route>
      <Route path="/logs">
        <Shell><LogsPage /></Shell>
      </Route>
      <Route path="/usuarios">
        <Shell><UsuariosPage /></Shell>
      </Route>
      <Route path="/admins">
        <Shell><AdminsPage /></Shell>
      </Route>
      
      <Route>
        <Shell><NotFound /></Shell>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
      <Toaster theme="light" position="top-right" />
    </QueryClientProvider>
  );
}

export default App;