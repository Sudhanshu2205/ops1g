import { create } from "zustand";
import { persist } from "zustand/middleware";
import { supabase } from "./supabase";
import type {
  ActivityLog, FollowUp, Lead, Property, Role, TCM, Tour,
  PostTourUpdate, ClientDecision, LeadStage, Intent,
  HandoffMessage, ActiveSequence, SequenceKind, Booking,
} from "./types";
import { ACTIVITIES, FOLLOWUPS, LEADS, PROPERTIES, TCMS, TOURS, HANDOFFS, SEQUENCES_INIT } from "./mock-data";
import { autoAssign as autoAssignFn } from "./routing";
import { pushObjectionToOwner, pushTourViewToOwner } from "@/owner/team-bridge";
import { emit as emitConnector } from "./connectors";
import { personName } from "./people";

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

interface AppState {
  role: Role;
  currentTcmId: string;
  setRole: (r: Role) => void;
  setCurrentTcmId: (id: string) => void;

  selectedLeadId: string | null;
  selectLead: (id: string | null) => void;

  tcms: TCM[];
  properties: Property[];
  leads: Lead[];
  tours: Tour[];
  activities: ActivityLog[];
  followUps: FollowUp[];
  handoffs: HandoffMessage[];
  sequences: ActiveSequence[];
  bookings: Booking[];

  setLeadStage: (leadId: string, stage: LeadStage) => void;
  setLeadIntent: (leadId: string, intent: Intent) => void;
  setLeadFollowUp: (leadId: string, dueAt: string, priority: FollowUp["priority"], reason?: string) => void;
  addLeadTag: (leadId: string, tag: string) => void;
  removeLeadTag: (leadId: string, tag: string) => void;
  reassignLead: (leadId: string, tcmId: string, reason: string) => void;
  autoAssignLead: (leadId: string) => { tcmId: string; reasons: string[] };

  scheduleTour: (input: { leadId: string; propertyId: string; tcmId: string; scheduledAt: string }) => Tour;
  cancelTour: (tourId: string) => void;
  rescheduleTour: (tourId: string, scheduledAt: string) => void;
  completeTour: (tourId: string) => void;

  setDecision: (tourId: string, decision: ClientDecision) => void;
  updatePostTour: (tourId: string, patch: Partial<PostTourUpdate>) => void;

  addNote: (leadId: string, note: string, tourId?: string) => void;
  logCall: (leadId: string) => void;
  sendMessage: (leadId: string, text: string) => void;

  completeFollowUp: (followUpId: string) => void;
  addFollowUp: (input: Omit<FollowUp, "id" | "done">) => void;

  sendHandoff: (input: { leadId: string; from: Role; fromId: string; text: string; priority: "normal" | "urgent" }) => void;
  markHandoffsRead: (leadId: string) => void;

  startSequence: (leadId: string, kind: SequenceKind) => void;
  toggleSequencePause: (leadId: string) => void;
  stopSequence: (leadId: string, reason: string) => void;
  advanceSequenceStep: (leadId: string) => void;

  closeDeal: (input: { leadId: string; tourId: string; propertyId: string; tcmId: string; amount: number }) => void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
  role: "flow-ops",
  currentTcmId: "tcm-1",
  setRole: (r) => set({ role: r }),
  setCurrentTcmId: (id) => set({ currentTcmId: id }),

  selectedLeadId: null,
  selectLead: (id) => set({ selectedLeadId: id }),

  tcms: TCMS,
  properties: PROPERTIES,
  leads: LEADS,
  tours: TOURS,
  activities: ACTIVITIES,
  followUps: FOLLOWUPS,
  handoffs: HANDOFFS,
  sequences: SEQUENCES_INIT,
  bookings: [],

  setLeadStage: (leadId, stage) => {
    set((state) => ({
      leads: state.leads.map((lead) =>
        lead.id === leadId ? { ...lead, stage, updatedAt: new Date().toISOString() } : lead,
      ),
    }));
    pushActivity(set, get, {
      kind: "status_changed", actor: get().role, leadId,
      text: `Status changed to ${stage}`,
    });
  },

  setLeadIntent: (leadId, intent) => {
    set((state) => ({
      leads: state.leads.map((lead) => (lead.id === leadId ? { ...lead, intent } : lead)),
    }));
  },

  setLeadFollowUp: (leadId, dueAt, priority, reason = "Manual follow-up") => {
    set((state) => ({
      leads: state.leads.map((lead) => (lead.id === leadId ? { ...lead, nextFollowUpAt: dueAt } : lead)),
    }));
    const lead = get().leads.find((lead) => lead.id === leadId);
    if (!lead) return;
    const f: FollowUp = {
      id: uid("f"), leadId, tcmId: lead.assignedTcmId,
      dueAt, priority, reason, done: false,
    };
    set((state) => ({ followUps: [f, ...state.followUps] }));
    pushActivity(set, get, { kind: "follow_up_set", actor: get().role, leadId, text: `Follow-up set: ${reason}` });
  },

  addLeadTag: (leadId, tag) => {
    set((state) => ({
      leads: state.leads.map((lead) =>
        lead.id === leadId && !lead.tags.includes(tag) ? { ...lead, tags: [...lead.tags, tag] } : lead,
      ),
    }));
  },

  removeLeadTag: (leadId, tag) => {
    set((state) => ({
      leads: state.leads.map((lead) =>
        lead.id === leadId ? { ...lead, tags: lead.tags.filter((t) => t !== tag) } : lead,
      ),
    }));
  },

  scheduleTour: ({ leadId, propertyId, tcmId, scheduledAt }) => {
    const lead = get().leads.find((lead) => lead.id === leadId)!;
    const tour: Tour = {
      id: uid("t"), leadId, propertyId, tcmId, scheduledAt,
      status: "scheduled", decision: null,
      postTour: {
        outcome: null, confidence: 0, objection: null, objectionNote: "",
        expectedDecisionAt: null, nextFollowUpAt: null, filledAt: null,
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    set((state) => ({
      tours: [tour, ...state.tours],
      leads: state.leads.map((lead) =>
        lead.id === leadId ? { ...lead, stage: "tour-scheduled", updatedAt: new Date().toISOString() } : lead,
      ),
    }));
    pushActivity(set, get, {
      kind: "tour_scheduled", actor: tcmId, leadId, tourId: tour.id, propertyId,
      text: `Tour scheduled for ${lead.name}`,
    });
    pushActivity(set, get, {
      kind: "message_sent", actor: "system", leadId, tourId: tour.id,
      text: `Auto WhatsApp confirmation sent to ${lead.name}`,
    });
    // Connector — Flow Ops scheduling earns assist; TCM is primary.
    const actorRole = get().role;
    const actorId = actorRole === "tcm" ? get().currentTcmId : actorRole;
    emitConnector({
      kind: "tour.scheduled",
      actorRole,
      actorId,
      leadId, tourId: tour.id, propertyId,
      text: `${personName(actorId, "Someone")} scheduled tour for ${lead.name}`,
      assists: actorRole === "flow-ops"
        ? [{ role: "tcm", id: tcmId }]
        : actorRole === "tcm" && tcmId !== actorId
          ? [{ role: "tcm", id: tcmId }]
          : undefined,
    });
    return tour;
  },

  cancelTour: (tourId) => {
    const tour = get().tours.find((item) => item.id === tourId);
    if (!tour) return;
    set((state) => ({
      tours: state.tours.map((item) =>
        item.id === tourId ? { ...item, status: "cancelled", updatedAt: new Date().toISOString() } : item,
      ),
    }));
    pushActivity(set, get, { kind: "tour_cancelled", actor: get().role, leadId: tour.leadId, tourId, text: "Tour cancelled" });
  },

  rescheduleTour: (tourId, scheduledAt) => {
    set((state) => ({
      tours: state.tours.map((item) =>
        item.id === tourId ? { ...item, scheduledAt, updatedAt: new Date().toISOString() } : item,
      ),
    }));
    const tour = get().tours.find((item) => item.id === tourId);
    if (tour) pushActivity(set, get, { kind: "tour_scheduled", actor: get().role, leadId: tour.leadId, tourId, text: "Tour rescheduled" });
  },

  completeTour: (tourId) => {
    const tour = get().tours.find((item) => item.id === tourId);
    if (!tour) return;
    set((state) => ({
      tours: state.tours.map((item) =>
        item.id === tourId ? { ...item, status: "completed", updatedAt: new Date().toISOString() } : item,
      ),
      leads: state.leads.map((lead) =>
        lead.id === tour.leadId ? { ...lead, stage: "tour-done", updatedAt: new Date().toISOString() } : lead,
      ),
    }));
    pushActivity(set, get, { kind: "tour_completed", actor: tour.tcmId, leadId: tour.leadId, tourId, text: "Tour marked completed" });
    // Bridge → owner: every completed tour bumps the room's view counter
    const prop = get().properties.find((property) => property.id === tour.propertyId);
    if (prop) pushTourViewToOwner(prop.name);
    const lead = get().leads.find((lead) => lead.id === tour.leadId);
    emitConnector({
      kind: "tour.completed",
      actorRole: "tcm", actorId: tour.tcmId,
      leadId: tour.leadId, tourId, propertyId: tour.propertyId,
      text: `${personName(tour.tcmId, "TCM")} completed tour with ${lead?.name ?? "lead"}`,
    });
  },

  setDecision: (tourId, decision) => {
    const tour = get().tours.find((item) => item.id === tourId);
    if (!tour) return;
    set((state) => ({
      tours: state.tours.map((item) => (item.id === tourId ? { ...item, decision, updatedAt: new Date().toISOString() } : item)),
      leads: state.leads.map((lead) =>
        lead.id === tour.leadId
          ? {
              ...lead,
              stage:
                decision === "booked" ? "booked" :
                decision === "dropped" ? "dropped" : "negotiation",
              updatedAt: new Date().toISOString(),
            }
          : lead,
      ),
    }));
    pushActivity(set, get, {
      kind: "decision_logged", actor: tour.tcmId, leadId: tour.leadId, tourId,
      text: `Decision: ${decision ?? "—"}`,
    });
  },

  updatePostTour: (tourId, patch) => {
    const tour = get().tours.find((item) => item.id === tourId);
    if (!tour) return;
    const prevObjection = tour.postTour.objection;
    const next: PostTourUpdate = { ...tour.postTour, ...patch };
    const complete =
      next.outcome !== null &&
      next.confidence > 0 &&
      next.expectedDecisionAt !== null &&
      next.nextFollowUpAt !== null;
    if (complete && !next.filledAt) {
      next.filledAt = new Date().toISOString();
      pushActivity(set, get, { kind: "post_tour_filled", actor: tour.tcmId, leadId: tour.leadId, tourId, text: "Post-tour form completed" });
      const lead = get().leads.find((lead) => lead.id === tour.leadId);
      emitConnector({
        kind: "post_tour.filled",
        actorRole: "tcm", actorId: tour.tcmId,
        leadId: tour.leadId, tourId, propertyId: tour.propertyId,
        text: `${personName(tour.tcmId, "TCM")} closed post-tour loop · ${lead?.name ?? ""}`.trim(),
      });
    }
    set((state) => ({
      tours: state.tours.map((item) => (item.id === tourId ? { ...item, postTour: next, updatedAt: new Date().toISOString() } : item)),
      leads: state.leads.map((lead) =>
        lead.id === tour.leadId
          ? {
              ...lead,
              confidence: next.confidence > 0 ? next.confidence : lead.confidence,
              nextFollowUpAt: next.nextFollowUpAt ?? lead.nextFollowUpAt,
            }
          : lead,
      ),
    }));
    if (next.nextFollowUpAt) {
      const exists = get().followUps.find((followUp) => followUp.tourId === tourId && !followUp.done);
      if (!exists) {
        const f: FollowUp = {
          id: uid("f"), tourId, leadId: tour.leadId, tcmId: tour.tcmId,
          dueAt: next.nextFollowUpAt,
          priority: next.confidence >= 75 ? "high" : next.confidence >= 50 ? "medium" : "low",
          reason: "Post-tour scheduled follow-up",
          done: false,
        };
        set((state) => ({ followUps: [f, ...state.followUps] }));
      }
    }
    // Bridge → Owner: every NEW objection logged here pushes a demand-signal
    // record into the Owner store so the owner's bars reflect real team activity.
    if (next.objection && next.objection !== prevObjection) {
      const prop = get().properties.find((property) => property.id === tour.propertyId);
      const tcm = get().tcms.find((m) => m.id === tour.tcmId);
      if (prop) {
        pushObjectionToOwner({
          propertyKey: prop.name,
          reasonLabel: next.objection,
          notes: next.objectionNote || undefined,
          loggedBy: tcm?.name ? `${tcm.name} (TCM)` : "TCM",
        });
      }
    }
  },

  addNote: (leadId, note, tourId) => {
    pushActivity(set, get, { kind: "note_added", actor: get().role, leadId, tourId, text: note });
  },

  logCall: (leadId) => {
    pushActivity(set, get, { kind: "call_logged", actor: get().role, leadId, text: "Call logged" });
  },

  sendMessage: (leadId, text) => {
    pushActivity(set, get, { kind: "message_sent", actor: get().role, leadId, text: `Message: ${text}` });
  },

  completeFollowUp: (followUpId) => {
    const followUp = get().followUps.find((item) => item.id === followUpId);
    if (!followUp) return;
    set((state) => ({
      followUps: state.followUps.map((item) => (item.id === followUpId ? { ...item, done: true } : item)),
      leads: state.leads.map((lead) => (lead.id === followUp.leadId ? { ...lead, nextFollowUpAt: null } : lead)),
    }));
    pushActivity(set, get, { kind: "follow_up_done", actor: followUp.tcmId, leadId: followUp.leadId, tourId: followUp.tourId, text: `Follow-up done: ${followUp.reason}` });
  },

  addFollowUp: (input) => {
    const f: FollowUp = { ...input, id: uid("f"), done: false };
    set((state) => ({ followUps: [f, ...state.followUps] }));
  },

  reassignLead: (leadId, tcmId, reason) => {
    const tcm = get().tcms.find((tour) => tour.id === tcmId);
    set((state) => ({
      leads: state.leads.map((lead) =>
        lead.id === leadId ? { ...lead, assignedTcmId: tcmId, updatedAt: new Date().toISOString() } : lead,
      ),
    }));
    pushActivity(set, get, { kind: "status_changed", actor: get().role, leadId, text: `Reassigned to ${tcm?.name ?? tcmId} · ${reason}` });
    // auto-handoff
    const lead = get().leads.find((lead) => lead.id === leadId);
    if (lead) {
      get().sendHandoff({
        leadId,
        from: get().role,
        fromId: get().role === "tcm" ? get().currentTcmId : get().role,
        text: `Reassigned to ${tcm?.name ?? tcmId}. Reason: ${reason}`,
        priority: lead.intent === "hot" ? "urgent" : "normal",
      });
    }
  },

  autoAssignLead: (leadId) => {
    const lead = get().leads.find((lead) => lead.id === leadId);
    if (!lead) return { tcmId: "", reasons: [] };
    const pick = autoAssignFn(lead, get().tcms, get().leads, get().tours);
    get().reassignLead(leadId, pick.tcmId, pick.reasons.join(" · "));
    return { tcmId: pick.tcmId, reasons: pick.reasons };
  },

  sendHandoff: ({ leadId, from, fromId, text, priority }) => {
    const to: Role = from === "flow-ops" ? "tcm" : from === "tcm" ? "flow-ops" : "flow-ops";
    const msg: HandoffMessage = {
      id: uid("h"), leadId, ts: new Date().toISOString(),
      from, fromId, to, text, priority, read: false,
    };
    set((state) => ({ handoffs: [...state.handoffs, msg] }));
    emitConnector({
      kind: "handoff.sent",
      actorRole: from, actorId: fromId, leadId,
      text: `${personName(fromId, from)} → ${to}: ${text.slice(0, 80)}`,
    });
  },

  markHandoffsRead: (leadId) => {
    set((state) => ({
      handoffs: state.handoffs.map((h) => (h.leadId === leadId ? { ...h, read: true } : h)),
    }));
  },

  startSequence: (leadId, kind) => {
    const existing = get().sequences.find((s) => s.leadId === leadId && !s.stoppedReason);
    if (existing) return;
    const seq: ActiveSequence = {
      id: uid("s"), leadId, kind, startedAt: new Date().toISOString(),
      currentStep: 0, paused: false,
    };
    set((state) => ({ sequences: [...state.sequences, seq] }));
    pushActivity(set, get, { kind: "message_sent", actor: "system", leadId, text: `Sequence started: ${kind}` });
  },

  toggleSequencePause: (leadId) => {
    set((state) => ({
      sequences: state.sequences.map((seq) =>
        seq.leadId === leadId && !seq.stoppedReason ? { ...seq, paused: !seq.paused } : seq,
      ),
    }));
  },

  stopSequence: (leadId, reason) => {
    set((state) => ({
      sequences: state.sequences.map((seq) =>
        seq.leadId === leadId && !seq.stoppedReason ? { ...seq, stoppedReason: reason } : seq,
      ),
    }));
  },

  advanceSequenceStep: (leadId) => {
    set((state) => ({
      sequences: state.sequences.map((seq) =>
        seq.leadId === leadId && !seq.stoppedReason ? { ...seq, currentStep: seq.currentStep + 1 } : seq,
      ),
    }));
  },

  closeDeal: ({ leadId, tourId, propertyId, tcmId, amount }) => {
    const booking: Booking = {
      id: uid("b"), leadId, tourId, propertyId, tcmId, amount,
      ts: new Date().toISOString(),
    };
    set((state) => ({
      bookings: [booking, ...state.bookings],
      properties: state.properties.map((property) =>
        property.id === propertyId
          ? { ...property, vacantBeds: Math.max(0, property.vacantBeds - 1), daysSinceLastBooking: 0 }
          : property,
      ),
      leads: state.leads.map((lead) =>
        lead.id === leadId ? { ...lead, stage: "booked", confidence: 100, updatedAt: new Date().toISOString() } : lead,
      ),
      tours: state.tours.map((tour) =>
        tour.id === tourId ? { ...tour, decision: "booked", status: "completed" } : tour,
      ),
      sequences: state.sequences.map((seq) =>
        seq.leadId === leadId && !seq.stoppedReason ? { ...seq, stoppedReason: "Booked" } : seq,
      ),
    }));
    pushActivity(set, get, { kind: "decision_logged", actor: tcmId, leadId, tourId, propertyId, text: `Deal closed · ₹${amount.toLocaleString("en-IN")}/mo` });
    // Connector — find which Flop scheduled this lead's tour, give them assist XP.
    const sched = get().activities.find(
      (a) => a.kind === "tour_scheduled" && a.leadId === leadId && a.tourId === tourId,
    );
    const lead = get().leads.find((lead) => lead.id === leadId);
    const ownerEvt = get().properties.find((property) => property.id === propertyId);
    emitConnector({
      kind: "booking.closed",
      actorRole: "tcm", actorId: tcmId,
      leadId, tourId, propertyId, bookingId: booking.id,
      text: `${personName(tcmId, "TCM")} booked ${lead?.name ?? "lead"} at ${ownerEvt?.name ?? "property"} · ₹${Math.round(amount).toLocaleString("en-IN")}/mo`,
      assists: sched && sched.actor !== tcmId
        ? [{ role: sched.actor === "flow-ops" ? "flow-ops" : "tcm", id: sched.actor }]
        : undefined,
    });
  },
}), { name: "gharpayy-crm-store" }));

function pushActivity(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  _get: () => AppState,
  a: Omit<ActivityLog, "id" | "ts">,
) {
  const log: ActivityLog = { id: uid("a"), ts: new Date().toISOString(), ...a };
  set((state) => ({ activities: [log, ...state.activities] }));
}

/* ============== SELECTORS / DERIVED ============== */

export function getTcm(id: string) {
  return TCMS.find((tour) => tour.id === id);
}

export function getProperty(id: string, properties: Property[]) {
  return properties.find((property) => property.id === id);
}

export function getLead(id: string, leads: Lead[]) {
  return leads.find((lead) => lead.id === id);
}

export interface PropertyMetrics {
  property: Property;
  leadCount: number;
  tourCount: number;
  bookings: number;
  conversionPct: number; // 0-100
  occupancyPct: number;
  demandScore: number; // 0-100
  pressureScore: number; // 0-100
  signal: "high-demand-low-conv" | "low-demand-high-vacancy" | "high-conv-low-supply" | "balanced";
}

export function computePropertyMetrics(
  properties: Property[],
  leads: Lead[],
  tours: Tour[],
): PropertyMetrics[] {
  return properties.map((property) => {
    const propTours = tours.filter((tour) => tour.propertyId === property.id);
    const propLeads = leads.filter((lead) => lead.preferredArea === property.area);
    const bookings = propTours.filter((tour) => tour.decision === "booked").length;
    const completed = propTours.filter((tour) => tour.status === "completed").length;
    const conversionPct = completed > 0 ? Math.round((bookings / completed) * 100) : 0;
    const occupancyPct = Math.round(((property.totalBeds - property.vacantBeds) / property.totalBeds) * 100);
    const demandScore = Math.min(
      100,
      Math.round(propLeads.length * 12 + propTours.length * 8 - property.daysSinceLastBooking * 2),
    );
    const pressureScore = Math.round(
      Math.max(0, Math.min(100, demandScore * 0.6 + (100 - occupancyPct) * 0.4)),
    );

    let signal: PropertyMetrics["signal"] = "balanced";
    if (demandScore >= 60 && conversionPct < 25) signal = "high-demand-low-conv";
    else if (demandScore < 30 && occupancyPct < 60) signal = "low-demand-high-vacancy";
    else if (conversionPct >= 40 && property.vacantBeds <= 3) signal = "high-conv-low-supply";

    return {
      property: property, leadCount: propLeads.length, tourCount: propTours.length,
      bookings, conversionPct, occupancyPct, demandScore, pressureScore, signal,
    };
  });
}

/** Dynamic deal probability score */
export function recomputeConfidence(lead: Lead, tours: Tour[]): number {
  let score = lead.confidence;
  // Response speed weight
  if (lead.responseSpeedMins <= 5) score += 5;
  else if (lead.responseSpeedMins > 15) score -= 5;
  // Tour completed?
  const hasCompleted = tours.some((tour) => tour.leadId === lead.id && tour.status === "completed");
  if (hasCompleted) score += 8;
  // Move-in urgency
  const days = (new Date(lead.moveInDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days <= 3) score += 6;
  else if (days >= 14) score -= 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function intentForConfidence(c: number): Intent {
  if (c >= 75) return "hot";
  if (c >= 50) return "warm";
  return "cold";
}

// --- SUPABASE SYNC LOGIC ---
const STATE_ID = '00000000-0000-0000-0000-000000000001';
let isHydrating = false;

export async function hydrateFromSupabase() {
  isHydrating = true;
  try {
    const { data, error } = await supabase
      .from('crm_state')
      .select('state_data')
      .eq('id', STATE_ID)
      .single();

    if (error) {
      console.error("Supabase fetch error:", error);
      return;
    }

    if (data && data.state_data && Object.keys(data.state_data).length > 0) {
      useApp.setState(data.state_data);
      console.log("Hydrated state from Supabase");
    }
  } catch (err) {
    console.error("Failed to hydrate from Supabase", err);
  } finally {
    isHydrating = false;
  }
}

// Execute hydration on load
if (typeof window !== "undefined") {
  hydrateFromSupabase();
}

// Subscribe to local state changes and push to Supabase
useApp.subscribe((state) => {
  if (isHydrating) return;

  clearTimeout((window as any)._supabaseSyncTimeout);
  (window as any)._supabaseSyncTimeout = setTimeout(async () => {
    try {
      const { error } = await supabase
        .from('crm_state')
        .update({ state_data: state, updated_at: new Date().toISOString() })
        .eq('id', STATE_ID);

      if (error) {
        console.error("Supabase sync error:", error);
      }
    } catch (err) {
      console.error("Failed to sync to Supabase", err);
    }
  }, 1000);
});
