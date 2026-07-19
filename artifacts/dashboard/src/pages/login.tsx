import React from 'react';
import { useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLoginAdmin } from '@workspace/api-client-react';
import { setToken } from '../lib/auth';
import { Button, Input, Label, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui';
import { Terminal, Shield, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';

const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'A senha é obrigatória'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  
  const loginMutation = useLoginAdmin();
  
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  React.useEffect(() => {
    if (isAuthenticated) {
      setLocation('/dashboard');
    }
  }, [isAuthenticated, setLocation]);

  if (authLoading || isAuthenticated) {
    return <div className="min-h-screen bg-background flex items-center justify-center">
      <Terminal className="h-8 w-8 text-primary animate-pulse" />
    </div>;
  }

  const onSubmit = (data: LoginFormValues) => {
    loginMutation.mutate({ data }, {
      onSuccess: (response) => {
        setToken(response.token);
        toast.success("Login realizado com sucesso", {
          description: `Bem-vindo de volta, ${response.name}.`,
        });
        setLocation('/dashboard');
      },
      onError: () => {
        toast.error("Erro no login", {
          description: "Credenciais inválidas. Verifique seu email e senha.",
        });
      }
    });
  };

  return (
    <div className="min-h-screen flex w-full">
      {/* Left side - Branding/Visuals */}
      <div className="hidden lg:flex w-1/2 bg-zinc-950 p-12 flex-col justify-between relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute top-0 left-0 w-full h-full opacity-20 pointer-events-none">
          <div className="absolute top-[20%] left-[10%] w-64 h-64 rounded-full bg-primary/30 blur-[100px]" />
          <div className="absolute bottom-[20%] right-[10%] w-80 h-80 rounded-full bg-accent/20 blur-[120px]" />
          
          {/* Grid pattern */}
          <div className="w-full h-full" style={{ 
            backgroundImage: `radial-gradient(circle at 2px 2px, rgba(255,255,255,0.15) 1px, transparent 0)`,
            backgroundSize: '32px 32px'
          }} />
        </div>

        <div className="relative z-10 flex items-center gap-3">
          <div className="h-10 w-10 bg-primary rounded-xl flex items-center justify-center">
            <Terminal className="text-white h-6 w-6" />
          </div>
          <span className="text-2xl font-bold text-white font-mono tracking-tight">KAMI<span className="text-primary">BOT</span></span>
        </div>
        
        <div className="relative z-10 max-w-lg">
          <Badge variant="outline" className="mb-6 border-white/20 text-white/70 bg-white/5 backdrop-blur-sm">
            Admin Central v2.4.0
          </Badge>
          <h1 className="text-5xl font-bold text-white mb-6 leading-tight font-sans">
            Command Center for your <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Discord Community</span>.
          </h1>
          <p className="text-lg text-zinc-400 font-sans">
            Monitor activity, manage admins, and analyze command usage across all guilds from a single, dense, high-performance interface.
          </p>
        </div>

        <div className="relative z-10 flex items-center gap-4 text-sm text-zinc-500 font-mono">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Systems Operational
          </div>
          <span>•</span>
          <span>Latency: 42ms</span>
        </div>
      </div>

      {/* Right side - Login Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-background relative">
        {/* Mobile header */}
        <div className="absolute top-8 left-8 flex lg:hidden items-center gap-3">
          <div className="h-8 w-8 bg-primary rounded-lg flex items-center justify-center">
            <Terminal className="text-white h-5 w-5" />
          </div>
          <span className="text-xl font-bold font-mono tracking-tight">KAMI<span className="text-primary">BOT</span></span>
        </div>

        <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="space-y-2 text-center lg:text-left">
            <div className="inline-flex items-center justify-center p-3 bg-primary/10 rounded-2xl mb-4 lg:hidden">
              <Shield className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight">Sign In</h2>
            <p className="text-muted-foreground text-lg">
              Enter your credentials to access the admin panel.
            </p>
          </div>

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input 
                  id="email" 
                  placeholder="admin@kamibot.com" 
                  type="email"
                  className="h-12 bg-muted/50 border-transparent focus:bg-background focus:border-primary transition-all duration-300"
                  {...form.register('email')} 
                />
                {form.formState.errors.email && (
                  <p className="text-sm text-destructive font-medium">{form.formState.errors.email.message}</p>
                )}
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                </div>
                <Input 
                  id="password" 
                  type="password" 
                  placeholder="••••••••"
                  className="h-12 bg-muted/50 border-transparent focus:bg-background focus:border-primary transition-all duration-300 font-mono"
                  {...form.register('password')} 
                />
                {form.formState.errors.password && (
                  <p className="text-sm text-destructive font-medium">{form.formState.errors.password.message}</p>
                )}
              </div>
            </div>

            <Button 
              type="submit" 
              className="w-full h-12 text-base font-semibold group" 
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 animate-spin" />
                  Authenticating...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Access Terminal
                  <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                </span>
              )}
            </Button>
          </form>
          
          <p className="text-center text-sm text-muted-foreground pt-4">
            Authorized personnel only. All access attempts are logged.
          </p>
        </div>
      </div>
    </div>
  );
}

// Inline badge for login page to avoid circular deps
function Badge({ className, variant = 'default', children, ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'outline' }) {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  )
}
