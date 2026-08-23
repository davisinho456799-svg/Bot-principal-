import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Command,
  Hash,
  Library,
  ListFilter,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Sparkles,
  Tv,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  getGetCurrentSeasonQueryKey,
  getGetDiscordConfigQueryKey,
  getGetDiscordStatusQueryKey,
  getListDiscordChannelsQueryKey,
  getListDiscordGuildsQueryKey,
  useGetCurrentSeason,
  useGetDiscordConfig,
  useGetDiscordStatus,
  useListDiscordChannels,
  useListDiscordGuilds,
  useSaveDiscordConfig,
  useSyncDiscordTable,
  type DiscordChannel,
  type DiscordGuild,
  type SeasonItem,
} from '@workspace/api-client-react';
import { Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

const formatDate = (value?: string | null, fallback = 'Not yet') => {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};

const formatRelative = (value?: string | null) => {
  if (!value) return 'Waiting for first sync';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

function BrandMark() {
  return (
    <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] shadow-[0_8px_18px_hsl(var(--accent)/.2)]">
      <Command className="h-5 w-5" strokeWidth={2.5} />
      <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[hsl(var(--sidebar))] bg-[hsl(var(--chart-2))]" />
    </div>
  );
}

function Sidebar({ status }: { status?: { configured: boolean; connected: boolean; enabled: boolean } }) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar))] text-[hsl(var(--sidebar-foreground))] md:min-h-[100dvh] md:w-[244px] md:border-b-0 md:border-r">
      <div className="flex items-center gap-3 px-5 py-5 md:px-6 md:py-7">
        <BrandMark />
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[.22em] text-[hsl(var(--sidebar-foreground)/.58)]">Season board</div>
          <div className="mt-0.5 text-[15px] font-extrabold tracking-[-.03em] text-[hsl(var(--sidebar-accent-foreground))]">Kitsu Relay</div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-y border-[hsl(var(--sidebar-border))] px-5 py-3 md:mx-4 md:rounded-lg md:border md:px-3">
        <span className={`flex h-7 w-7 items-center justify-center rounded-md ${status?.connected ? 'bg-[hsl(var(--chart-2)/.16)] text-[hsl(var(--chart-2))]' : 'bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-foreground)/.7)]'}`}>
          {status?.connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-[hsl(var(--sidebar-accent-foreground))]">Discord relay</div>
          <div className="font-mono text-[10px] text-[hsl(var(--sidebar-foreground)/.58)]">{status?.connected ? 'Connection healthy' : 'Awaiting connection'}</div>
        </div>
        <span className={`h-1.5 w-1.5 rounded-full ${status?.connected ? 'bg-[hsl(var(--chart-2))]' : 'bg-[hsl(var(--sidebar-foreground)/.35)]'}`} />
      </div>

      <nav className="flex gap-1 px-4 py-4 md:block md:flex-1 md:space-y-1 md:px-4 md:py-7" aria-label="Primary navigation">
        <div className="hidden px-3 pb-2 font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--sidebar-foreground)/.42)] md:block">Workspace</div>
        <a href="#catalog" data-testid="link-catalog" className="flex items-center gap-3 rounded-lg bg-[hsl(var(--sidebar-accent))] px-3 py-2.5 text-xs font-bold text-[hsl(var(--sidebar-accent-foreground))]">
          <Library className="h-4 w-4 text-[hsl(var(--sidebar-primary))]" />
          <span>Season catalog</span>
        </a>
        <a href="#discord" data-testid="link-discord-setup" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-semibold text-[hsl(var(--sidebar-foreground)/.68)] transition-colors hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-accent-foreground))]">
          <Settings2 className="h-4 w-4" />
          <span>Discord setup</span>
        </a>
      </nav>

      <div className="hidden border-t border-[hsl(var(--sidebar-border))] px-6 py-5 md:block">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-[hsl(var(--sidebar-foreground)/.45)]">
          <CircleDot className="h-3 w-3 text-[hsl(var(--sidebar-primary))]" /> v1.0 / live
        </div>
      </div>
    </aside>
  );
}

function SectionKicker({ children, icon: Icon }: { children: string; icon: typeof Library }) {
  return (
    <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">
      <Icon className="h-3.5 w-3.5 text-[hsl(var(--accent-foreground))]" />
      <span>{children}</span>
    </div>
  );
}

function StatusPill({ status }: { status: SeasonItem['status'] }) {
  const copy = status === 'airing' ? 'Airing' : status === 'upcoming' ? 'Upcoming' : 'Publishing';
  const tone = status === 'airing' ? 'bg-[hsl(var(--chart-2)/.12)] text-[hsl(var(--chart-2))]' : status === 'upcoming' ? 'bg-[hsl(var(--accent)/.23)] text-[hsl(27_52%_30%)]' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]';
  return <span className={`rounded-full px-2 py-1 font-mono text-[9px] font-medium uppercase tracking-[.08em] ${tone}`}>{copy}</span>;
}

function MediaCover({ item }: { item: SeasonItem }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative h-[118px] w-[82px] shrink-0 overflow-hidden rounded-lg bg-[hsl(var(--primary))]">
      {!failed && item.imageUrl ? (
        <img src={item.imageUrl} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="flex h-full w-full items-end bg-[linear-gradient(145deg,hsl(var(--primary)),hsl(var(--chart-3)/.7))] p-2">
          {item.kind === 'anime' ? <Tv className="h-6 w-6 text-[hsl(var(--accent)/.75)]" /> : <BookOpen className="h-6 w-6 text-[hsl(var(--accent)/.75)]" />}
        </div>
      )}
      <div className="absolute left-1.5 top-1.5 rounded bg-[hsl(var(--foreground)/.72)] px-1.5 py-1 font-mono text-[8px] uppercase tracking-widest text-[hsl(var(--card))]">
        {item.kind}
      </div>
    </div>
  );
}

function CatalogCard({ item, index }: { item: SeasonItem; index: number }) {
  return (
    <article className={`card-lift animate-rise-in flex gap-3 rounded-xl border border-[hsl(var(--card-border))] bg-[hsl(var(--card))] p-3 ${index > 5 ? 'animate-rise-in-delay-2' : ''}`} data-testid={`card-season-item-${item.id}`}>
      <MediaCover item={item} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-[13px] font-extrabold leading-[1.3] tracking-[-.02em] text-[hsl(var(--card-foreground))]" data-testid={`text-season-title-${item.id}`}>{item.title}</h3>
          {item.score != null && <span className="shrink-0 font-mono text-[10px] font-medium text-[hsl(var(--muted-foreground))]"><span className="text-[hsl(var(--accent-foreground))]">★</span> {item.score.toFixed(1)}</span>}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <StatusPill status={item.status} />
          <span className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">{item.kind === 'anime' ? item.episodes ? `${item.episodes} eps` : 'Series' : item.volumes ? `${item.volumes} vols` : 'Ongoing'}</span>
        </div>
        <p className="mt-auto line-clamp-2 pt-2 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">{item.synopsis || 'No synopsis available for this title yet.'}</p>
        <a href={item.url} target="_blank" rel="noreferrer" data-testid={`link-season-item-${item.id}`} className="mt-2 inline-flex items-center gap-1 self-start font-mono text-[9px] font-medium uppercase tracking-[.08em] text-[hsl(var(--chart-2))] hover:underline">
          Open details <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
    </article>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((item) => <div className="flex gap-3 rounded-xl border border-[hsl(var(--card-border))] bg-[hsl(var(--card))] p-3" key={item}><div className="skeleton h-[118px] w-[82px] shrink-0 rounded-lg" /><div className="flex-1 space-y-3 pt-1"><div className="skeleton h-3 w-4/5 rounded" /><div className="skeleton h-4 w-1/3 rounded" /><div className="skeleton h-7 w-full rounded" /></div></div>)}
    </div>
  );
}

function CatalogPanel() {
  const { data: catalog, isLoading, isError, refetch } = useGetCurrentSeason({ query: { queryKey: getGetCurrentSeasonQueryKey() } });
  const [tab, setTab] = useState<'anime' | 'manga'>('anime');
  const [query, setQuery] = useState('');
  const titles = useMemo(() => (tab === 'anime' ? catalog?.anime : catalog?.manga) ?? [], [catalog, tab]);
  const filtered = useMemo(() => titles.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [titles, query]);
  const airingCount = titles.filter((item) => item.status === 'airing' || item.status === 'publishing').length;

  return (
    <section id="catalog" className="animate-rise-in animate-rise-in-delay-1">
      <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <SectionKicker icon={Radio}>Broadcast index</SectionKicker>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-2xl font-extrabold tracking-[-.055em] text-[hsl(var(--foreground))] sm:text-[27px]">{catalog ? `${catalog.season} ${catalog.year}` : 'Current season'}</h2>
            {catalog && <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{airingCount} active releases</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[10px] text-[hsl(var(--muted-foreground))] sm:block">Updated {formatRelative(catalog?.updatedAt)}</span>
          <button onClick={() => refetch()} disabled={isLoading} data-testid="button-refresh-catalog" className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-[.08em] text-[hsl(var(--foreground))] transition-colors hover:border-[hsl(var(--accent))] disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg bg-[hsl(var(--secondary))] p-1">
          <button onClick={() => setTab('anime')} data-testid="button-tab-anime" className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-bold transition-colors ${tab === 'anime' ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))]'}`}><Tv className="h-3.5 w-3.5" /> Anime <span className="font-mono text-[9px] opacity-60">{catalog?.anime.length ?? '—'}</span></button>
          <button onClick={() => setTab('manga')} data-testid="button-tab-manga" className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-bold transition-colors ${tab === 'manga' ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))]'}`}><BookOpen className="h-3.5 w-3.5" /> Manga <span className="font-mono text-[9px] opacity-60">{catalog?.manga.length ?? '—'}</span></button>
        </div>
        <label className="relative flex min-w-[190px] items-center">
          <ListFilter className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} data-testid="input-filter-catalog" placeholder="Filter titles" className="h-9 w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] pl-9 pr-3 text-xs outline-none transition-colors placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--accent))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" />
        </label>
      </div>

      {isLoading && <CatalogSkeleton />}
      {isError && <div className="flex items-center justify-between gap-4 rounded-xl border border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.06)] p-5"><div className="flex items-center gap-3"><AlertCircle className="h-5 w-5 text-[hsl(var(--destructive))]" /><div><p className="text-sm font-bold">Catalog unavailable</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">The broadcast index could not be reached.</p></div></div><button onClick={() => refetch()} data-testid="button-retry-catalog" className="rounded-lg border border-[hsl(var(--destructive)/.35)] px-3 py-2 font-mono text-[10px] uppercase text-[hsl(var(--destructive))]">Retry</button></div>}
      {!isLoading && !isError && filtered.length === 0 && <div className="board-grid rounded-xl border border-dashed border-[hsl(var(--border))] px-6 py-14 text-center"><Library className="mx-auto h-7 w-7 text-[hsl(var(--muted-foreground)/.5)]" /><p className="mt-3 text-sm font-bold">No titles in this view</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{query ? 'Try a different filter.' : 'This catalog is waiting for its first release.'}</p></div>}
      {!isLoading && !isError && filtered.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{filtered.map((item, index) => <CatalogCard item={item} index={index} key={item.id} />)}</div>}
    </section>
  );
}

function Toggle({ checked, onChange, label, description, testId }: { checked: boolean; onChange: () => void; label: string; description: string; testId: string }) {
  return (
    <button type="button" onClick={onChange} data-testid={testId} aria-pressed={checked} className="flex w-full items-center justify-between gap-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background)/.55)] p-3 text-left transition-colors hover:border-[hsl(var(--accent)/.7)]">
      <span><span className="block text-xs font-bold text-[hsl(var(--foreground))]">{label}</span><span className="mt-1 block text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">{description}</span></span>
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-[hsl(var(--chart-2))]' : 'bg-[hsl(var(--border))]'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-[hsl(var(--card))] shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} /></span>
    </button>
  );
}

function DiscordSetup({ config, guilds, guildsLoading, guildsError, channels, channelsLoading, onRetryGuilds, onSaved }: { config?: { guildId: string | null; channelId: string | null; intervalMinutes: number; includeAnime: boolean; includeManga: boolean; enabled: boolean; lastSyncedAt?: string | null }; guilds?: DiscordGuild[]; guildsLoading: boolean; guildsError: boolean; channels?: DiscordChannel[]; channelsLoading: boolean; onRetryGuilds: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const saveConfig = useSaveDiscordConfig();
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [includeAnime, setIncludeAnime] = useState(true);
  const [includeManga, setIncludeManga] = useState(true);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!config) return;
    setGuildId(config.guildId ?? '');
    setChannelId(config.channelId ?? '');
    setIntervalMinutes(config.intervalMinutes || 60);
    setIncludeAnime(config.includeAnime);
    setIncludeManga(config.includeManga);
    setEnabled(config.enabled);
  }, [config]);

  const submit = () => {
    if (!guildId || !channelId) return;
    saveConfig.mutate({ data: { guildId, channelId, intervalMinutes: Math.min(10080, Math.max(15, Number(intervalMinutes))), includeAnime, includeManga, enabled } }, {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetDiscordConfigQueryKey(), saved);
        queryClient.invalidateQueries({ queryKey: getGetDiscordStatusQueryKey() });
        onSaved('Discord settings saved');
      },
    });
  };

  return (
    <section id="discord" className="animate-rise-in animate-rise-in-delay-2">
      <div className="mb-5">
        <SectionKicker icon={Settings2}>Relay configuration</SectionKicker>
        <h2 className="text-2xl font-extrabold tracking-[-.055em] text-[hsl(var(--foreground))] sm:text-[27px]">Send the signal where it belongs.</h2>
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">Choose a server and channel for the season board. Kitsu Relay keeps the post current without asking members to hunt for release dates.</p>
      </div>
      <div className="rounded-2xl border border-[hsl(var(--card-border))] bg-[hsl(var(--card))] p-4 shadow-[0_12px_32px_hsl(229_38%_19%/.04)] sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block"><span className="mb-2 flex items-center gap-2 text-[11px] font-bold"><Server className="h-3.5 w-3.5 text-[hsl(var(--chart-2))]" /> Discord server</span><div className="relative"><select value={guildId} onChange={(event) => { setGuildId(event.target.value); setChannelId(''); }} data-testid="select-discord-guild" disabled={guildsLoading || guildsError} className="h-11 w-full appearance-none rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 pr-9 text-xs font-semibold outline-none focus:border-[hsl(var(--accent))]">{guildsError ? <option>Unable to load servers</option> : <><option value="">{guildsLoading ? 'Loading servers...' : 'Select a server'}</option>{guilds?.map((guild) => <option value={guild.id} key={guild.id}>{guild.name}</option>)}</>}</select><ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-[hsl(var(--muted-foreground))]" /></div>{guildsError && <button type="button" onClick={onRetryGuilds} data-testid="button-retry-guilds" className="mt-2 font-mono text-[10px] uppercase text-[hsl(var(--destructive))]">Retry server list</button>}</label>
          <label className="block"><span className="mb-2 flex items-center gap-2 text-[11px] font-bold"><Hash className="h-3.5 w-3.5 text-[hsl(var(--chart-2))]" /> Text channel</span><div className="relative"><select value={channelId} onChange={(event) => setChannelId(event.target.value)} data-testid="select-discord-channel" disabled={!guildId || channelsLoading} className="h-11 w-full appearance-none rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 pr-9 text-xs font-semibold outline-none focus:border-[hsl(var(--accent))]"><option value="">{!guildId ? 'Choose a server first' : channelsLoading ? 'Loading channels...' : 'Select a channel'}</option>{channels?.filter((channel) => channel.type === 'text' || channel.type === 'GUILD_TEXT').map((channel) => <option value={channel.id} key={channel.id}># {channel.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-[hsl(var(--muted-foreground))]" /></div></label>
        </div>
        <div className="my-5 border-t border-[hsl(var(--border))]" />
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
          <label className="block"><span className="mb-2 flex items-center gap-2 text-[11px] font-bold"><Clock3 className="h-3.5 w-3.5 text-[hsl(var(--chart-2))]" /> Refresh interval</span><div className="flex items-center gap-2"><input type="number" min={15} max={10080} step={15} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} data-testid="input-refresh-interval" className="h-11 w-28 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 font-mono text-sm outline-none focus:border-[hsl(var(--accent))]" /><span className="text-xs text-[hsl(var(--muted-foreground))]">minutes</span></div><span className="mt-2 block text-[10px] text-[hsl(var(--muted-foreground))]">Between 15 minutes and 7 days.</span></label>
          <div className="space-y-2"><Toggle checked={enabled} onChange={() => setEnabled(!enabled)} label="Automatic refresh" description="Keep the Discord board synchronized." testId="toggle-enabled" /></div>
        </div>
        <div className="my-5 border-t border-[hsl(var(--border))]" />
        <div className="grid gap-2 sm:grid-cols-2"><Toggle checked={includeAnime} onChange={() => setIncludeAnime(!includeAnime)} label="Include anime" description="Airing and upcoming television releases." testId="toggle-include-anime" /><Toggle checked={includeManga} onChange={() => setIncludeManga(!includeManga)} label="Include manga" description="Current publishing titles and volumes." testId="toggle-include-manga" /></div>
        <div className="mt-5 flex flex-col-reverse items-stretch justify-between gap-3 border-t border-[hsl(var(--border))] pt-4 sm:flex-row sm:items-center">
          <p className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{config?.lastSyncedAt ? `Last saved ${formatDate(config.lastSyncedAt)}` : 'Configuration has not been saved yet.'}</p>
          <button type="button" onClick={submit} disabled={saveConfig.isPending || !guildId || !channelId} data-testid="button-save-discord-config" className="inline-flex items-center justify-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50">{saveConfig.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save configuration</button>
        </div>
        {saveConfig.isError && <p className="mt-3 flex items-center gap-2 text-[10px] text-[hsl(var(--destructive))]"><AlertCircle className="h-3.5 w-3.5" /> Could not save these settings. Check the server and channel, then try again.</p>}
      </div>
    </section>
  );
}

function SyncStatus({ status, config, onSync, syncPending, lastResult }: { status?: { configured: boolean; connected: boolean; enabled: boolean; lastSyncedAt: string | null }; config?: { guildId: string | null; channelId: string | null; intervalMinutes: number; lastSyncedAt?: string | null }; onSync: () => void; syncPending: boolean; lastResult?: { success: boolean; message: string; updatedAt: string } }) {
  const connected = status?.connected ?? false;
  const configured = status?.configured ?? !!config?.guildId;
  return (
    <section className="animate-rise-in animate-rise-in-delay-3">
      <div className="mb-5 flex items-end justify-between gap-3"><div><SectionKicker icon={Activity}>Relay health</SectionKicker><h2 className="text-2xl font-extrabold tracking-[-.055em] text-[hsl(var(--foreground))] sm:text-[27px]">The board, accounted for.</h2></div><span className={`hidden rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.12em] sm:inline-flex ${connected ? 'bg-[hsl(var(--chart-2)/.12)] text-[hsl(var(--chart-2))]' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'}`}>{connected ? 'Operational' : 'Needs attention'}</span></div>
      <div className="overflow-hidden rounded-2xl border border-[hsl(var(--card-border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
        <div className="grid md:grid-cols-[1.1fr_1fr]">
          <div className="board-grid border-b border-[hsl(var(--primary-foreground)/.1)] p-5 md:border-b-0 md:border-r md:p-6"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2 text-xs font-bold"><span className={`h-2 w-2 rounded-full ${connected ? 'bg-[hsl(var(--chart-2))]' : 'bg-[hsl(var(--accent))]'}`} /> {connected ? 'Discord connected' : 'Discord not connected'}</div><p className="mt-3 max-w-xs text-[11px] leading-relaxed text-[hsl(var(--primary-foreground)/.63)]">{configured ? status?.enabled ? 'Automatic refresh is on. Your members will see the latest catalog in the selected channel.' : 'Configuration is saved, but automatic refresh is paused.' : 'Choose a server and channel to start publishing a trusted season board.'}</p></div><Zap className="h-5 w-5 text-[hsl(var(--accent))]" /></div><button onClick={onSync} disabled={syncPending || !configured} data-testid="button-sync-now" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--accent))] px-4 py-2.5 text-xs font-extrabold text-[hsl(var(--accent-foreground))] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45">{syncPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync to Discord now</button></div>
          <div className="grid grid-cols-2 divide-x divide-[hsl(var(--primary-foreground)/.1)]"><div className="p-5"><div className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.48)]">Last update</div><div className="mt-3 text-lg font-extrabold tracking-[-.04em]" data-testid="text-last-sync">{formatRelative(status?.lastSyncedAt ?? config?.lastSyncedAt)}</div><div className="mt-1 text-[10px] text-[hsl(var(--primary-foreground)/.55)]">{formatDate(status?.lastSyncedAt ?? config?.lastSyncedAt)}</div></div><div className="p-5"><div className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.48)]">Cadence</div><div className="mt-3 text-lg font-extrabold tracking-[-.04em]">{config?.intervalMinutes ?? '—'}<span className="ml-1 text-xs font-medium text-[hsl(var(--primary-foreground)/.55)]">min</span></div><div className="mt-1 text-[10px] text-[hsl(var(--primary-foreground)/.55)]">{status?.enabled ? 'Auto refresh on' : 'Auto refresh off'}</div></div></div>
        </div>
        {lastResult && <div className={`flex items-center gap-2 border-t px-5 py-3 font-mono text-[10px] ${lastResult.success ? 'border-[hsl(var(--chart-2)/.2)] bg-[hsl(var(--chart-2)/.08)] text-[hsl(var(--chart-2))]' : 'border-[hsl(var(--destructive)/.2)] bg-[hsl(var(--destructive)/.08)] text-[hsl(4_75%_72%)]'}`}>{lastResult.success ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />} {lastResult.message} <span className="ml-auto opacity-60">{formatDate(lastResult.updatedAt)}</span></div>}
      </div>
    </section>
  );
}

function Home() {
  const queryClient = useQueryClient();
  const seasonQuery = useGetCurrentSeason({ query: { queryKey: getGetCurrentSeasonQueryKey() } });
  const guildsQuery = useListDiscordGuilds({ query: { queryKey: getListDiscordGuildsQueryKey() } });
  const configQuery = useGetDiscordConfig({ query: { queryKey: getGetDiscordConfigQueryKey() } });
  const statusQuery = useGetDiscordStatus({ query: { queryKey: getGetDiscordStatusQueryKey() } });
  const [selectedGuildId, setSelectedGuildId] = useState('');
  const channelsQuery = useListDiscordChannels(selectedGuildId, { query: { enabled: !!selectedGuildId, queryKey: getListDiscordChannelsQueryKey(selectedGuildId) } });
  const sync = useSyncDiscordTable();
  const [notice, setNotice] = useState<{ success: boolean; message: string; updatedAt: string }>();

  useEffect(() => {
    if (configQuery.data?.guildId) setSelectedGuildId(configQuery.data.guildId);
  }, [configQuery.data?.guildId]);

  const handleSync = () => {
    sync.mutate(undefined, {
      onSuccess: (result) => {
        setNotice(result);
        queryClient.invalidateQueries({ queryKey: getGetDiscordStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDiscordConfigQueryKey() });
      },
      onError: () => setNotice({ success: false, message: 'Sync could not reach Discord. Try again in a moment.', updatedAt: new Date().toISOString() }),
    });
  };

  return (
    <div className="noise-layer min-h-[100dvh] bg-[hsl(var(--background))]">
      <div className="flex min-h-[100dvh] flex-col md:flex-row">
        <Sidebar status={statusQuery.data} />
        <main className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.82)] px-5 py-5 backdrop-blur-sm sm:px-8 md:px-10 md:py-7">
            <div><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.16em] text-[hsl(var(--muted-foreground))]"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--chart-2))]" /> Command center</div><h1 className="mt-2 text-xl font-extrabold tracking-[-.055em] text-[hsl(var(--foreground))] sm:text-2xl">Good evening, operator.</h1></div>
            <div className="hidden items-center gap-3 sm:flex"><div className="text-right"><div className="font-mono text-[9px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">System time</div><div className="mt-1 text-xs font-bold text-[hsl(var(--foreground))]">{new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date())}</div></div><div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]"><MessageSquare className="h-4 w-4 text-[hsl(var(--muted-foreground))]" /></div></div>
          </header>
          <div className="mx-auto max-w-[1180px] space-y-12 px-5 py-8 sm:px-8 md:px-10 md:py-10">
            <div className="relative overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 sm:p-7">
              <div className="absolute right-[-20px] top-[-50px] h-48 w-48 rounded-full border-[22px] border-[hsl(var(--accent)/.13)]" /><div className="absolute right-12 top-8 h-3 w-3 rounded-full bg-[hsl(var(--accent))]" />
              <div className="relative max-w-2xl"><div className="mb-3 inline-flex items-center gap-2 rounded-full bg-[hsl(var(--accent)/.2)] px-2.5 py-1 font-mono text-[9px] font-medium uppercase tracking-[.14em] text-[hsl(var(--accent-foreground))]"><Sparkles className="h-3 w-3" /> Live season signal</div><h2 className="max-w-xl text-[clamp(1.8rem,4vw,2.65rem)] font-extrabold leading-[1.06] tracking-[-.065em] text-[hsl(var(--foreground))]">One reliable board for everything <span className="text-[hsl(var(--chart-2))]">worth watching.</span></h2><p className="mt-4 max-w-lg text-xs leading-[1.8] text-[hsl(var(--muted-foreground))]">Preview what is airing, point the relay at your community’s channel, and let the calendar stay alive between conversations.</p></div>
            </div>
            <CatalogPanel />
            <DiscordSetup config={configQuery.data} guilds={guildsQuery.data} guildsLoading={guildsQuery.isLoading} guildsError={guildsQuery.isError} channels={channelsQuery.data} channelsLoading={channelsQuery.isLoading} onRetryGuilds={() => guildsQuery.refetch()} onSaved={(message) => setNotice({ success: true, message, updatedAt: new Date().toISOString() })} />
            <SyncStatus status={statusQuery.data} config={configQuery.data} onSync={handleSync} syncPending={sync.isPending} lastResult={notice} />
            <footer className="flex flex-col gap-2 border-t border-[hsl(var(--border))] pt-5 text-[10px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center sm:justify-between"><span className="font-mono uppercase tracking-[.13em]">Kitsu Relay / anime season board</span><span>Catalog data updates with the broadcast cycle.</span></footer>
          </div>
        </main>
      </div>
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;