import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { useApp, computePropertyMetrics } from "@/lib/store";
import { KpiCard, Card, Stat, SignalChip } from "@/components/atoms";
import { format } from "date-fns";
import { AlertTriangle, ArrowUpRight, CalendarPlus, Flame, Building2, Zap, Sun, TrendingUp, Sparkles, IndianRupee } from "lucide-react";
import { useMemo } from "react";
import { useMountedNow } from "@/hooks/use-now";
import { buildDoNextQueue, liveConfidence, intentFor } from "@/lib/engine";
import { scanRevivals } from "@/lib/revival";
import { QuickActionRow } from "@/components/QuickActionRow";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Gharpayy" },
      { name: "description", content: "Live command center: leads, tours, follow-ups, deal probability and inventory pressure." },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { leads, tours, followUps, properties, role, currentTcmId, selectLead, bookings, handoffs } = useApp();
  const [now, mounted] = useMountedNow();

  const filterTcm = role === "tcm" ? currentTcmId : undefined;
  const metrics = useMemo(() => computePropertyMetrics(properties, leads, tours), [properties, leads, tours]);
  const queue = useMemo(
    () => buildDoNextQueue(leads, tours, followUps, now, filterTcm),
    [leads, tours, followUps, now, filterTcm],
  );
  const revivals = useMemo(
    () => scanRevivals(leads, properties, tours, now),
    [leads, properties, tours, now],
  );

  // Live, decayed view of every lead
  const liveLeads = useMemo(
    () => leads.map((l) => ({ ...l, confidence: liveConfidence(l, tours, now), intent: intentFor(liveConfidence(l, tours, now)) })),
    [leads, tours, now],
  );
  const hotLeads = liveLeads.filter((l) => l.intent === "hot" && l.stage !== "booked" && l.stage !== "dropped");
  const incompleteTours = tours.filter((t) => t.status === "completed" && !t.postTour.filledAt);
  const todayTours = tours.filter((t) => t.status === "scheduled" && sameDay(+new Date(t.scheduledAt), now));
  const booked = tours.filter((t) => t.decision === "booked").length;
  const conversion = tours.length ? Math.round((booked / tours.length) * 100) : 0;
  const overdueFu = followUps.filter((f) => !f.done && +new Date(f.dueAt) < now).length;
  const monthlyRevenue = bookings.reduce((s, b) => s + b.amount, 0);
  const unreadHandoffs = handoffs.filter((h) => !h.read && h.to === role).length;

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Arena Infrastructure</h1>
            <p className="text-sm text-muted-foreground">
              Every lead, every tour, every follow-up — one operating layer. <span className="text-accent font-mono">live</span>
            </p>
          </div>
          <div className="text-xs text-muted-foreground font-mono min-h-[1em]">
            {mounted ? format(new Date(now), "EEEE, MMM d · h:mm a") : "\u00a0"}
          </div>
        </header>

        {unreadHandoffs > 0 && (
          <Link to="/handoffs" className="block rounded-xl border border-info/30 bg-info/5 p-3 hover:bg-info/10 transition-colors">
            <div className="flex items-center gap-3">
              <Sparkles className="h-4 w-4 text-info" />
              <div className="flex-1 text-sm">
                <span className="font-semibold">{unreadHandoffs} unread handoff{unreadHandoffs > 1 ? "s" : ""}</span>
                <span className="text-muted-foreground"> from {role === "tcm" ? "Flow Ops" : "TCM team"}</span>
              </div>
              <ArrowUpRight className="h-4 w-4 text-info" />
            </div>
          </Link>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard label="Active leads" value={liveLeads.filter((l) => l.stage !== "booked" && l.stage !== "dropped").length} sub={`${hotLeads.length} hot · live score`} />
          <KpiCard label="Today's tours" value={todayTours.length} sub="Scheduled" tone="accent" />
          <KpiCard label="Overdue follow-ups" value={overdueFu} sub={`${incompleteTours.length} post-tour pending`} tone={overdueFu || incompleteTours.length ? "destructive" : "default"} />
          <KpiCard label="Conversion rate" value={`${conversion}%`} sub={`${booked} booked total`} tone="success" />
          <KpiCard label="MRR closed" value={`₹${(monthlyRevenue / 1000).toFixed(0)}k`} sub={`${bookings.length} booking${bookings.length === 1 ? "" : "s"}`} tone="success" />
        </div>

        {/* Today's queue (top 5 quick view) */}
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-accent" />
              <h2 className="font-display text-sm font-semibold">Do this next</h2>
              <span className="text-[10px] text-muted-foreground font-mono">{queue.length} ranked</span>
            </div>
            <Link to="/today" className="text-xs text-accent inline-flex items-center gap-1">
              <Sun className="h-3 w-3" /> Today view <ArrowUpRight className="h-3 w-3" />
            </Link>
          </header>
          {queue.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">Inbox zero. Nothing pending right now.</div>
          ) : (
            <div className="divide-y divide-border">
              {queue.slice(0, 5).map((a) => {
                const lead = leads.find((l) => l.id === a.leadId);
                if (!lead) return null;
                return (
                  <QuickActionRow
                    key={`${a.leadId}-${a.kind}`}
                    lead={lead}
                    reason={a.reason}
                    accent={a.kind === "post-tour-overdue" || a.kind === "first-response" || a.kind === "follow-up-overdue" ? "destructive" : a.kind === "no-follow-up" ? "warning" : "accent"}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* Post-tour enforcement banner */}
        {incompleteTours.length > 0 && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5 animate-pulse" />
            <div className="flex-1">
              <div className="font-semibold text-destructive text-sm">
                {incompleteTours.length} post-tour update{incompleteTours.length > 1 ? "s" : ""} missing
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Auto-escalation triggers at 6h. Click any name to fill the form now.
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {incompleteTours.map((t) => {
                  const lead = leads.find((l) => l.id === t.leadId);
                  if (!lead) return null;
                  const hrs = Math.round((now - +new Date(t.scheduledAt)) / 36e5);
                  return (
                    <button
                      key={t.id}
                      onClick={() => selectLead(lead.id)}
                      className="text-[11px] rounded-md border border-destructive/30 bg-card px-2 py-0.5 hover:bg-destructive/10 transition-colors inline-flex items-center gap-1"
                    >
                      {lead.name} <span className="font-mono text-destructive min-w-[2ch] inline-block text-right">{mounted ? `${hrs}h` : '…'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Hot pipeline */}
          <Card title="Hot pipeline" icon={Flame} accent action={<Link to="/leads" className="text-xs text-accent inline-flex items-center gap-1">All leads <ArrowUpRight className="h-3 w-3" /></Link>}>
            <div className="divide-y divide-border -mx-3">
              {hotLeads.slice(0, 5).map((l) => (
                <QuickActionRow key={l.id} lead={l} accent="accent" />
              ))}
              {hotLeads.length === 0 && <div className="text-xs text-muted-foreground text-center py-6">No hot leads right now.</div>}
            </div>
          </Card>

          {/* Today's tours */}
          <Card title="Today's tours" icon={CalendarPlus} action={<Link to="/tours" className="text-xs text-accent inline-flex items-center gap-1">All tours <ArrowUpRight className="h-3 w-3" /></Link>}>
            <div className="space-y-2">
              {todayTours.map((t) => {
                const lead = leads.find((l) => l.id === t.leadId);
                const prop = properties.find((p) => p.id === t.propertyId);
                if (!lead) return null;
                const minsTo = (+new Date(t.scheduledAt) - now) / 60_000;
                return (
                  <button
                    key={t.id}
                    onClick={() => selectLead(lead.id)}
                    className="w-full text-left rounded-lg border border-border bg-card hover:border-accent/40 transition-colors p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">{lead.name}</span>
                      <span className={`text-xs font-mono ${mounted && minsTo < 60 && minsTo > 0 ? "text-accent" : "text-muted-foreground"}`}>
                        {mounted ? (minsTo > 0 ? `in ${formatMins(minsTo)}` : `${formatMins(-minsTo)} ago`) : "\u00a0"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{prop?.name} · {format(new Date(t.scheduledAt), "p")}</div>
                  </button>
                );
              })}
              {todayTours.length === 0 && <div className="text-xs text-muted-foreground text-center py-6">No tours scheduled today.</div>}
            </div>
          </Card>
        </div>

        {/* Revival opportunities */}
        {revivals.length > 0 && (
          <section className="rounded-xl border border-info/30 bg-info/5 overflow-hidden">
            <header className="flex items-center justify-between px-4 py-3 border-b border-info/20">
              <div className="flex items-center gap-2">
                <IndianRupee className="h-4 w-4 text-info" />
                <h2 className="font-display text-sm font-semibold">Hidden revenue · revival queue</h2>
                <span className="text-[10px] text-muted-foreground font-mono">{revivals.length} candidate{revivals.length === 1 ? "" : "s"}</span>
              </div>
              <Link to="/revival" className="text-xs text-info inline-flex items-center gap-1">
                Open queue <ArrowUpRight className="h-3 w-3" />
              </Link>
            </header>
            <div className="divide-y divide-info/10">
              {revivals.slice(0, 4).map((r) => {
                const lead = leads.find((l) => l.id === r.leadId);
                if (!lead) return null;
                return (
                  <button
                    key={r.leadId}
                    onClick={() => selectLead(lead.id)}
                    className="w-full text-left px-4 py-2 hover:bg-info/5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{lead.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{r.reason}</div>
                    </div>
                    <span className="text-[10px] font-mono text-info shrink-0">score {r.score}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Inventory pressure */}
        <Card title="Inventory pressure" icon={Building2} action={<Link to="/inventory" className="text-xs text-accent inline-flex items-center gap-1">All properties <ArrowUpRight className="h-3 w-3" /></Link>}>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {metrics.slice(0, 6).map((m) => (
              <div key={m.property.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-sm leading-tight">{m.property.name}</div>
                    <div className="text-[11px] text-muted-foreground">{m.property.area}</div>
                  </div>
                  <SignalChip signal={m.signal} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <Stat label="Demand" value={m.demandScore} />
                  <Stat label="Conv %" value={m.conversionPct} />
                  <Stat label="Vacant" value={`${m.property.vacantBeds}/${m.property.totalBeds}`} mono />
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${m.pressureScore}%` }} />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Pressure {m.pressureScore}/100</span>
                  <span className="inline-flex items-center gap-1"><TrendingUp className="h-2.5 w-2.5" /> live</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}



function sameDay(a: number, b: number) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function formatMins(m: number): string {
  if (m < 60) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`;
}
