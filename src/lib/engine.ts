/**
 * Arena Infrastructure — engine layer.
 * Pure functions. No state. Compose on top of the store.
 *
 * Encodes the real-life rules of the system:
 *   - SLA clocks (response, follow-up, post-tour)
 *   - Confidence decay (silence is the enemy)
 *   - Escalation thresholds
 *   - Smart "do next" prioritization
 */
import type { Lead, Tour, FollowUp, Intent } from "./types";

/* ============== SLA RULES ============== */

export const SLA = {
  firstResponseMins: 5,         // first response after lead arrives
  followUpHours: 24,            // every lead has a follow-up within 24h
  postTourHours: 1,             // post-tour form filled within 1h
  postTourAlertHours: 2,        // soft alert
  postTourEscalateHours: 6,     // hard escalation to Flow Ops
  reassignDays: 3,              // T+3 with no action → reassign
} as const;

export type SlaState = "ok" | "warn" | "breach";

export function slaForFollowUp(dueAt: string | null, now: number): SlaState {
  if (!dueAt) return "breach"; // no follow-up = breach
  const due = +new Date(dueAt);
  if (now > due) return "breach";
  if (due - now < 60 * 60 * 1000) return "warn"; // <1h
  return "ok";
}

export function slaForPostTour(tour: Tour, now: number): SlaState {
  if (tour.status !== "completed" || tour.postTour.filledAt) return "ok";
  const elapsedHrs = (now - +new Date(tour.scheduledAt)) / 36e5;
  if (elapsedHrs >= SLA.postTourEscalateHours) return "breach";
  if (elapsedHrs >= SLA.postTourAlertHours) return "warn";
  return "ok";
}

export function slaForFirstResponse(lead: Lead): SlaState {
  if (lead.responseSpeedMins <= SLA.firstResponseMins) return "ok";
  if (lead.responseSpeedMins <= SLA.firstResponseMins * 3) return "warn";
  return "breach";
}

/* ============== CONFIDENCE DECAY ============== */

/**
 * Live confidence — silence kills deals.
 *  - -1 per hour of silence after 6h
 *  - -5 if no follow-up scheduled
 *  - -8 if move-in date passed
 *  - +6 if move-in <= 3 days
 *  - +5 if response speed <= 5min
 *  - +8 if a tour is already completed
 */
export function liveConfidence(lead: Lead, tours: Tour[], now: number): number {
  let s = lead.confidence;
  const silentHrs = (now - +new Date(lead.updatedAt)) / 36e5;
  if (silentHrs > 6) s -= Math.min(20, Math.floor(silentHrs - 6));
  if (!lead.nextFollowUpAt) s -= 5;
  if (lead.responseSpeedMins <= 5) s += 5;
  else if (lead.responseSpeedMins > 15) s -= 4;

  const days = (+new Date(lead.moveInDate) - now) / (24 * 36e5);
  if (days < 0) s -= 8;
  else if (days <= 3) s += 6;
  else if (days >= 14) s -= 3;

  if (tours.some((tour) => tour.leadId === lead.id && tour.status === "completed")) s += 8;
  if (tours.some((tour) => tour.leadId === lead.id && tour.decision === "booked")) s = 100;
  if (lead.stage === "dropped") s = Math.min(s, 15);
  if (lead.stage === "booked") s = 100;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function intentFor(confidence: number): Intent {
  if (confidence >= 75) return "hot";
  if (confidence >= 50) return "warm";
  return "cold";
}

/* ============== SMART "DO NEXT" QUEUE ============== */

export interface NextAction {
  leadId: string;
  reason: string;
  /** higher = do first */
  score: number;
  kind:
    | "post-tour-overdue"
    | "follow-up-overdue"
    | "follow-up-today"
    | "no-follow-up"
    | "first-response"
    | "tour-today";
  dueAt?: string;
}

/** The single source-of-truth queue. Replaces "browse leads". */
export function buildDoNextQueue(
  leads: Lead[],
  tours: Tour[],
  followUps: FollowUp[],
  now: number,
  filterTcmId?: string,
): NextAction[] {
  const actions: NextAction[] = [];
  const byLead = (l: Lead) => !filterTcmId || l.assignedTcmId === filterTcmId;

  // 1. post-tour pending — highest priority
  tours
    .filter((tour) => tour.status === "completed" && !tour.postTour.filledAt)
    .forEach((tour) => {
      const lead = leads.find((lead) => lead.id === tour.leadId);
      if (!lead || !byLead(lead)) return;
      const hrs = (now - +new Date(tour.scheduledAt)) / 36e5;
      actions.push({
        leadId: lead.id,
        reason: `Post-tour form pending · ${Math.max(1, Math.round(hrs))}h overdue`,
        kind: "post-tour-overdue",
        score: 1000 + Math.min(100, hrs * 5),
      });
    });

  // 2. overdue follow-ups
  followUps
    .filter((followUp) => !followUp.done && +new Date(followUp.dueAt) < now)
    .forEach((followUp) => {
      const lead = leads.find((lead) => lead.id === followUp.leadId);
      if (!lead || !byLead(lead)) return;
      const hrs = (now - +new Date(followUp.dueAt)) / 36e5;
      actions.push({
        leadId: lead.id,
        reason: `Follow-up overdue · ${followUp.reason}`,
        kind: "follow-up-overdue",
        score: 800 + Math.min(150, hrs * 2) + intentBoost(lead.intent),
        dueAt: followUp.dueAt,
      });
    });

  // 3. tours scheduled today
  tours
    .filter((tour) => tour.status === "scheduled" && sameDay(+new Date(tour.scheduledAt), now))
    .forEach((tour) => {
      const lead = leads.find((lead) => lead.id === tour.leadId);
      if (!lead || !byLead(lead)) return;
      const minsToTour = (+new Date(tour.scheduledAt) - now) / 60_000;
      actions.push({
        leadId: lead.id,
        reason: minsToTour > 0
          ? `Tour today in ${formatRel(minsToTour)}`
          : `Tour was ${formatRel(-minsToTour)} ago — confirm`,
        kind: "tour-today",
        score: 700 + intentBoost(lead.intent) - Math.abs(minsToTour) / 30,
        dueAt: tour.scheduledAt,
      });
    });

  // 4. follow-ups due today
  followUps
    .filter((followUp) => !followUp.done && sameDay(+new Date(followUp.dueAt), now) && +new Date(followUp.dueAt) >= now)
    .forEach((followUp) => {
      const lead = leads.find((lead) => lead.id === followUp.leadId);
      if (!lead || !byLead(lead)) return;
      actions.push({
        leadId: lead.id,
        reason: `Follow-up today · ${followUp.reason}`,
        kind: "follow-up-today",
        score: 500 + intentBoost(lead.intent),
        dueAt: followUp.dueAt,
      });
    });

  // 5. leads without any follow-up scheduled (and not closed)
  leads
    .filter((lead) => byLead(lead) && !lead.nextFollowUpAt && lead.stage !== "booked" && lead.stage !== "dropped")
    .forEach((lead) => {
      actions.push({
        leadId: lead.id,
        reason: `No follow-up set · SLA breach`,
        kind: "no-follow-up",
        score: 600 + intentBoost(lead.intent),
      });
    });

  // 6. brand-new leads waiting for first response
  leads
    .filter((lead) => byLead(lead) && lead.stage === "new")
    .forEach((lead) => {
      const ageMin = (now - +new Date(lead.createdAt)) / 60_000;
      if (ageMin > SLA.firstResponseMins) {
        actions.push({
          leadId: lead.id,
          reason: `First response overdue · created ${formatRel(ageMin)} ago`,
          kind: "first-response",
          score: 900 + Math.min(100, ageMin / 5),
        });
      }
    });

  // de-dup by lead+kind, sort
  const seen = new Set<string>();
  return actions
    .sort((a, b) => b.score - a.score)
    .filter((action) => {
      const k = `${action.leadId}:${action.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

function intentBoost(i: Intent) {
  return i === "hot" ? 50 : i === "warm" ? 20 : 0;
}

function sameDay(a: number, b: number) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() &&
         da.getMonth() === db.getMonth() &&
         da.getDate() === db.getDate();
}

function formatRel(mins: number): string {
  if (mins < 1) return "now";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = mins / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.round(h / 24)}d`;
}

/* ============== TCM PERFORMANCE ============== */

export interface TcmPerformance {
  tcmId: string;
  leadCount: number;
  toursDone: number;
  bookings: number;
  conversion: number; // 0-100
  pendingPostTour: number;
  overdueFollowUps: number;
  discipline: number; // 0-100, higher = better
}

export function computeTcmPerformance(
  tcmId: string,
  leads: Lead[],
  tours: Tour[],
  followUps: FollowUp[],
  now: number,
): TcmPerformance {
  const myLeads = leads.filter((lead) => lead.assignedTcmId === tcmId);
  const myTours = tours.filter((tour) => tour.tcmId === tcmId);
  const toursDone = myTours.filter((tour) => tour.status === "completed").length;
  const bookings = myTours.filter((tour) => tour.decision === "booked").length;
  const conversion = toursDone > 0 ? Math.round((bookings / toursDone) * 100) : 0;
  const pendingPostTour = myTours.filter((tour) => tour.status === "completed" && !tour.postTour.filledAt).length;
  const overdueFollowUps = followUps.filter((followUp) => followUp.tcmId === tcmId && !followUp.done && +new Date(followUp.dueAt) < now).length;
  const total = myLeads.length || 1;
  const discipline = Math.max(0, Math.min(100,
    100 - (pendingPostTour / total) * 100 - (overdueFollowUps / total) * 60,
  ));
  return {
    tcmId, leadCount: myLeads.length, toursDone, bookings, conversion,
    pendingPostTour, overdueFollowUps, discipline: Math.round(discipline),
  };
}
