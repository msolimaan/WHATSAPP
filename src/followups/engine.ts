import type { Config } from "../config.js";
import { chatFor } from "../crm/chat.js";
import { phoneKey } from "../crm/phones.js";
import { isAutoReply, meaningful } from "../crm/rules.js";
import { localDayAt } from "../crm/time.js";
import type { EventBus } from "../events/bus.js";
import { windowStatus } from "../store/queries.js";
import type { NewMessage, Store } from "../store/store.js";
import type { Messenger } from "../whatsapp/messenger.js";
import { build, type Content, describeContent } from "./content.js";
import { isOptOut } from "./optout.js";
import { nextAllowed, type SendWindow } from "./quiet.js";
import type { LeadVars } from "./vars.js";

export interface Step extends Content {
  /** Days after the previous step was sent (the first step: after enrolling). */
  after_days: number;
}

export interface OutboxRow {
  id: number;
  wa_id: string;
  content: string;
  preview: string;
  status: "draft" | "scheduled" | "sent" | "failed" | "rejected" | "cancelled";
  send_at: number | null;
  cancel_on_reply: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  message_id: string | null;
  error: string | null;
}

export interface SequenceRow {
  id: number;
  name: string;
  steps: string;
  created_at: number;
}

export interface EnrollmentRow {
  id: number;
  sequence_id: number;
  wa_id: string;
  vars: string;
  card_id: string | null;
  step: number;
  next_at: number | null;
  last_sent_at: number | null;
  status: "active" | "completed" | "stopped";
  stop_reason: string | null;
  created_at: number;
}

export interface EnrollTarget {
  waId: string;
  vars?: LeadVars;
  cardId?: string;
  label?: string;
}

type EventKind = "sent" | "skipped" | "stopped" | "failed" | "cancelled" | "opted_out";

const TICK_MS = 60 * 1000;

interface Deps {
  config: Config;
  store: Store;
  bus: EventBus;
  messenger: Messenger;
  now?: () => number;
  log?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Drafts, scheduled messages and automatic sequences.
 *
 * Every send goes through Messenger, so the 24-hour window and opt-outs are always respected.
 * Sequences stop as soon as the lead really replies, opts out, or you message them yourself
 * from your phone, and they never send during quiet hours or beyond the daily template cap.
 */
export class FollowupEngine {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly now: () => number;
  private readonly log: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? console;
  }

  private get db() {
    return this.deps.store.db;
  }

  private get nowSec() {
    return Math.floor(this.now() / 1000);
  }

  private get window(): SendWindow {
    const c = this.deps.config;
    return { quietHours: c.FOLLOWUP_QUIET_HOURS, skipWeekends: c.FOLLOWUP_SKIP_WEEKENDS, timeZone: c.TIMEZONE };
  }

  start(): void {
    this.deps.bus.on("message", (m, meta) => {
      if (!meta.backfill) this.handleMessage(m);
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- reacting to messages -------------------------------------------------------

  /** Stops what should stop when a message arrives. Synchronous: database work only. */
  handleMessage(m: NewMessage): void {
    if (m.type === "reaction") return;
    if (m.direction === "in") {
      const ids = this.sameNumber(m.waId);
      const chat = chatFor(this.db, ids);
      const msg = chat.find((c) => c.id === m.id);
      if (msg && isAutoReply(msg, chat)) return;
      if (isOptOut(m.body)) {
        for (const id of ids) this.db.prepare(`UPDATE contacts SET opted_out = 1, updated_at = ? WHERE wa_id = ?`).run(this.nowSec, id);
        this.event(m.waId, "opted_out", `asked to stop: “${(m.body ?? "").slice(0, 80)}”`);
        this.stopFor(m.waId, "opted out");
        this.cancelScheduledFor(m.waId, "they opted out", false);
        return;
      }
      this.stopFor(m.waId, "they replied");
      this.cancelScheduledFor(m.waId, "they replied", true);
    } else if (m.source === "echo") {
      // You typed to them on your phone: you've taken over, so the automation steps back.
      this.stopFor(m.waId, "you messaged them yourself");
    }
  }

  // ---- drafts and scheduled messages ------------------------------------------------

  createDraft(waId: string, content: Content, note?: string): OutboxRow {
    return this.insertOutbox(waId, content, "draft", null, true, note);
  }

  schedule(waId: string, content: Content, sendAt: number, cancelOnReply = true, note?: string): OutboxRow {
    return this.insertOutbox(waId, content, "scheduled", sendAt, cancelOnReply, note);
  }

  /** Sends drafts now, or schedules them when `sendAt` is given. */
  async approve(ids: number[], sendAt?: number): Promise<{ id: number; ok: boolean; detail: string }[]> {
    const out: { id: number; ok: boolean; detail: string }[] = [];
    for (const id of ids) {
      const row = this.outbox(id);
      if (!row || row.status !== "draft") {
        out.push({ id, ok: false, detail: row ? `is ${row.status}, not a draft` : "not found" });
        continue;
      }
      if (sendAt) {
        this.db.prepare(`UPDATE outbox SET status = 'scheduled', send_at = ?, updated_at = ? WHERE id = ?`).run(sendAt, this.nowSec, id);
        out.push({ id, ok: true, detail: "scheduled" });
      } else {
        const r = await this.sendOutbox(row);
        out.push({ id, ok: r.ok, detail: r.detail });
      }
    }
    return out;
  }

  /** Rejects drafts or cancels scheduled messages. */
  discard(ids: number[]): { id: number; ok: boolean; detail: string }[] {
    return ids.map((id) => {
      const row = this.outbox(id);
      if (!row) return { id, ok: false, detail: "not found" };
      if (row.status === "draft") {
        this.setOutbox(id, "rejected");
        return { id, ok: true, detail: "draft rejected" };
      }
      if (row.status === "scheduled") {
        this.setOutbox(id, "cancelled", { error: "cancelled by you" });
        return { id, ok: true, detail: "scheduled message cancelled" };
      }
      return { id, ok: false, detail: `already ${row.status}` };
    });
  }

  outbox(id: number): OutboxRow | undefined {
    return this.db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as OutboxRow | undefined;
  }

  listOutbox(statuses: OutboxRow["status"][], limit = 50): OutboxRow[] {
    const marks = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM outbox WHERE status IN (${marks}) ORDER BY COALESCE(send_at, created_at) LIMIT ?`)
      .all(...statuses, limit) as OutboxRow[];
  }

  // ---- sequences ------------------------------------------------------------------

  /** Creates or replaces a sequence. Returns warnings about steps that can't send. */
  saveSequence(name: string, steps: Step[], replace = false): { id: number; warnings: string[] } {
    const existing = this.sequence(name);
    if (existing && !replace) throw new Error(`A sequence named "${name}" exists. Pass replace=true to change it.`);
    const warnings = steps.flatMap((s, i) => {
      if (!s.text && !s.template) return [`Step ${i + 1} has no text and no template.`];
      if (!s.template) {
        return [
          `Step ${i + 1} has only free text. It can only be sent within 24h of the lead's last message, and sequences stop when they reply, so it will almost always be skipped. Add an approved template.`,
        ];
      }
      return [];
    });
    if (steps.some((s) => !s.text && !s.template)) throw new Error(warnings.join(" "));
    const json = JSON.stringify(steps);
    if (existing) {
      this.db.prepare(`UPDATE sequences SET steps = ?, updated_at = ? WHERE id = ?`).run(json, this.nowSec, existing.id);
      return { id: existing.id, warnings };
    }
    const r = this.db
      .prepare(`INSERT INTO sequences (name, steps, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(name, json, this.nowSec, this.nowSec);
    return { id: Number(r.lastInsertRowid), warnings };
  }

  sequence(name: string): SequenceRow | undefined {
    return this.db.prepare(`SELECT * FROM sequences WHERE name = ? COLLATE NOCASE`).get(name) as SequenceRow | undefined;
  }

  listSequences(): (SequenceRow & { active: number; completed: number; stopped: number })[] {
    return this.db
      .prepare(
        `SELECT s.*,
           SUM(e.status = 'active') AS active, SUM(e.status = 'completed') AS completed, SUM(e.status = 'stopped') AS stopped
         FROM sequences s LEFT JOIN enrollments e ON e.sequence_id = s.id
         GROUP BY s.id ORDER BY s.name`,
      )
      .all() as (SequenceRow & { active: number; completed: number; stopped: number })[];
  }

  /**
   * Checks who can join a sequence. Leads are left out when they opted out, are already in it,
   * or wrote last (they're waiting on you, so a canned follow-up would be wrong).
   */
  checkEnroll(sequenceName: string, targets: EnrollTarget[]): { ok: EnrollTarget[]; skipped: { target: EnrollTarget; reason: string }[] } {
    const seq = this.sequence(sequenceName);
    if (!seq) throw new Error(`No sequence named "${sequenceName}". Create it with followup_create_sequence.`);
    const ok: EnrollTarget[] = [];
    const skipped: { target: EnrollTarget; reason: string }[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      const waId = this.knownId(t.waId);
      const target = { ...t, waId };
      const key = phoneKey(waId);
      if (seen.has(key)) {
        skipped.push({ target, reason: "listed twice" });
        continue;
      }
      seen.add(key);
      if (this.sameNumber(waId).some((id) => this.deps.store.getContact(id)?.opted_out)) {
        skipped.push({ target, reason: "opted out" });
        continue;
      }
      const active = (this.db.prepare(`SELECT wa_id FROM enrollments WHERE sequence_id = ? AND status = 'active'`).all(seq.id) as { wa_id: string }[])
        .some((e) => phoneKey(e.wa_id) === key);
      if (active) {
        skipped.push({ target, reason: "already in this sequence" });
        continue;
      }
      const last = meaningful(chatFor(this.db, this.sameNumber(waId))).at(-1);
      if (last?.direction === "in") {
        skipped.push({ target, reason: "they wrote last and are waiting on your reply" });
        continue;
      }
      ok.push(target);
    }
    return { ok, skipped };
  }

  enroll(sequenceName: string, targets: EnrollTarget[]): { enrolled: EnrollTarget[]; skipped: { target: EnrollTarget; reason: string }[] } {
    const seq = this.sequence(sequenceName)!;
    const { ok, skipped } = this.checkEnroll(sequenceName, targets);
    const steps = JSON.parse(seq.steps) as Step[];
    const first = Math.floor(this.allowedAt(this.now() + steps[0].after_days * 86400_000) / 1000);
    const insert = this.db.prepare(
      `INSERT INTO enrollments (sequence_id, wa_id, vars, card_id, step, next_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, 'active', ?, ?)`,
    );
    this.db.transaction(() => {
      for (const t of ok) {
        this.deps.store.upsertContact({ waId: t.waId });
        insert.run(seq.id, t.waId, JSON.stringify(t.vars ?? {}), t.cardId ?? null, first, this.nowSec, this.nowSec);
      }
    })();
    return { enrolled: ok, skipped };
  }

  /** Stops active enrollments for a number (optionally only in one sequence). Returns how many. */
  stopFor(waId: string, reason: string, sequenceName?: string): number {
    const key = phoneKey(waId);
    const seqId = sequenceName ? this.sequence(sequenceName)?.id : undefined;
    const rows = (this.db.prepare(`SELECT id, wa_id, sequence_id FROM enrollments WHERE status = 'active'`).all() as EnrollmentRow[])
      .filter((e) => phoneKey(e.wa_id) === key && (seqId === undefined || e.sequence_id === seqId));
    for (const e of rows) {
      this.db.prepare(`UPDATE enrollments SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?`).run(reason, this.nowSec, e.id);
      this.event(e.wa_id, "stopped", reason, { enrollmentId: e.id });
    }
    return rows.length;
  }

  enrollments(filter: { waId?: string; sequenceName?: string; status?: EnrollmentRow["status"] } = {}): (EnrollmentRow & { sequence: string; steps: string })[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, s.name AS sequence, s.steps FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
         WHERE (@status IS NULL OR e.status = @status) AND (@seq IS NULL OR s.name = @seq COLLATE NOCASE)
         ORDER BY e.status, e.next_at`,
      )
      .all({ status: filter.status ?? null, seq: filter.sequenceName ?? null }) as (EnrollmentRow & { sequence: string; steps: string })[];
    return filter.waId ? rows.filter((r) => phoneKey(r.wa_id) === phoneKey(filter.waId!)) : rows;
  }

  // ---- the scheduler --------------------------------------------------------------

  /** Sends whatever is due. Runs every minute; a call while one is running waits for that one. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.runDue();
    this.running = run;
    try {
      await run;
    } finally {
      // Cleared here, after the assignment, so a run that finishes synchronously can't leave it stuck.
      if (this.running === run) this.running = undefined;
    }
  }

  private async runDue(): Promise<void> {
    try {
      const due = this.db
        .prepare(`SELECT * FROM outbox WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at`)
        .all(this.nowSec) as OutboxRow[];
      for (const row of due) await this.sendOutbox(row);

      const steps = this.db
        .prepare(`SELECT * FROM enrollments WHERE status = 'active' AND next_at <= ? ORDER BY next_at`)
        .all(this.nowSec) as EnrollmentRow[];
      for (const e of steps) await this.runStep(e);
    } catch (err) {
      this.log.error("followups: tick failed", err);
    }
  }

  private async sendOutbox(row: OutboxRow): Promise<{ ok: boolean; detail: string }> {
    if (row.status === "scheduled" && row.cancel_on_reply && this.repliedSince(row.wa_id, row.created_at)) {
      this.setOutbox(row.id, "cancelled", { error: "they replied before it was sent" });
      this.event(row.wa_id, "cancelled", "they replied before it was sent", { outboxId: row.id });
      return { ok: false, detail: "cancelled: they replied before it was sent" };
    }
    const content = JSON.parse(row.content) as Content;
    const built = build(content, this.windowOpen(row.wa_id));
    if (!built.ok) {
      this.setOutbox(row.id, "failed", { error: built.reason });
      this.event(row.wa_id, "failed", built.reason, { outboxId: row.id });
      return { ok: false, detail: `not sent: ${built.reason}` };
    }
    try {
      const r = await this.deps.messenger.send(row.wa_id, built.message);
      this.setOutbox(row.id, "sent", { messageId: r.messageId });
      this.event(row.wa_id, "sent", built.preview, { outboxId: row.id });
      return { ok: true, detail: `sent (${r.messageId})` };
    } catch (err) {
      const msg = (err as Error).message;
      this.setOutbox(row.id, "failed", { error: msg });
      this.event(row.wa_id, "failed", msg, { outboxId: row.id });
      return { ok: false, detail: `failed: ${msg}` };
    }
  }

  private async runStep(e: EnrollmentRow): Promise<void> {
    const seq = this.db.prepare(`SELECT * FROM sequences WHERE id = ?`).get(e.sequence_id) as SequenceRow;
    const steps = JSON.parse(seq.steps) as Step[];
    const stopHere = (reason: string) => {
      this.db.prepare(`UPDATE enrollments SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?`).run(reason, this.nowSec, e.id);
      this.event(e.wa_id, "stopped", reason, { enrollmentId: e.id });
    };
    if (e.step >= steps.length) {
      this.db.prepare(`UPDATE enrollments SET status = 'completed', next_at = NULL, updated_at = ? WHERE id = ?`).run(this.nowSec, e.id);
      return;
    }
    // Messages may have arrived while the server was down: check again before sending.
    if (this.repliedSince(e.wa_id, e.created_at)) return stopHere("they replied");
    if (this.youWroteSince(e.wa_id, e.created_at)) return stopHere("you messaged them yourself");
    if (this.sameNumber(e.wa_id).some((id) => this.deps.store.getContact(id)?.opted_out)) return stopHere("opted out");

    const nowMs = this.now();
    const later = this.allowedAt(nowMs);
    if (later > nowMs) {
      this.setNext(e.id, later);
      return;
    }
    const step = steps[e.step];
    const built = build(step, this.windowOpen(e.wa_id), JSON.parse(e.vars) as LeadVars);
    if (!built.ok) {
      this.event(e.wa_id, "skipped", `step ${e.step + 1} of "${seq.name}": ${built.reason}`, { enrollmentId: e.id });
      this.advance(e, steps, nowMs, false);
      return;
    }
    if (built.paid && this.templatesSentToday() >= this.deps.config.FOLLOWUP_DAILY_TEMPLATE_CAP) {
      // Daily budget used up: try again tomorrow morning.
      this.setNext(e.id, this.allowedAt(localDayAt(nowMs, 9, this.deps.config.TIMEZONE, 1).getTime()));
      return;
    }
    try {
      await this.deps.messenger.send(e.wa_id, built.message);
      this.event(e.wa_id, "sent", `step ${e.step + 1} of "${seq.name}": ${built.preview}`, { enrollmentId: e.id });
      this.advance(e, steps, nowMs, true);
    } catch (err) {
      const msg = (err as Error).message;
      this.event(e.wa_id, "failed", `step ${e.step + 1} of "${seq.name}": ${msg}`, { enrollmentId: e.id });
      stopHere(`sending failed: ${msg}`);
    }
  }

  private advance(e: EnrollmentRow, steps: Step[], nowMs: number, sent: boolean): void {
    const next = e.step + 1;
    if (next >= steps.length) {
      this.db
        .prepare(`UPDATE enrollments SET step = ?, status = 'completed', next_at = NULL, last_sent_at = COALESCE(?, last_sent_at), updated_at = ? WHERE id = ?`)
        .run(next, sent ? Math.floor(nowMs / 1000) : null, this.nowSec, e.id);
      return;
    }
    const at = this.allowedAt(nowMs + steps[next].after_days * 86400_000);
    this.db
      .prepare(`UPDATE enrollments SET step = ?, next_at = ?, last_sent_at = COALESCE(?, last_sent_at), updated_at = ? WHERE id = ?`)
      .run(next, Math.floor(at / 1000), sent ? Math.floor(nowMs / 1000) : null, this.nowSec, e.id);
  }

  // ---- helpers --------------------------------------------------------------------

  /** Template messages sent through the API since local midnight (yours via Claude included). */
  templatesSentToday(): number {
    const midnight = Math.floor(localDayAt(this.now(), 0, this.deps.config.TIMEZONE).getTime() / 1000);
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE source = 'api' AND type = 'template' AND timestamp >= ?`)
        .get(midnight) as { n: number }
    ).n;
  }

  /** Earliest allowed send time at or after `ms`, in ms. */
  private allowedAt(ms: number): number {
    return nextAllowed(ms, this.window);
  }

  private setNext(id: number, ms: number): void {
    this.db.prepare(`UPDATE enrollments SET next_at = ?, updated_at = ? WHERE id = ?`).run(Math.floor(ms / 1000), this.nowSec, id);
  }

  /** Every WhatsApp id we know for the same phone line (Brazilian ids with and without the 9). */
  private sameNumber(waId: string): string[] {
    const key = phoneKey(waId);
    const ids = (this.db.prepare(`SELECT wa_id FROM contacts`).all() as { wa_id: string }[])
      .map((r) => r.wa_id)
      .filter((id) => phoneKey(id) === key);
    return ids.length ? ids : [waId];
  }

  /** Prefer the id WhatsApp already uses for this line, so window checks see their messages. */
  private knownId(waId: string): string {
    const ids = this.sameNumber(waId);
    return ids.find((id) => this.deps.store.getContact(id)?.last_inbound_at) ?? ids[0];
  }

  private windowOpen(waId: string): boolean {
    return this.sameNumber(waId).some((id) => windowStatus(this.deps.store.getContact(id), this.now() / 1000).open);
  }

  private repliedSince(waId: string, since: number): boolean {
    const chat = chatFor(this.db, this.sameNumber(waId));
    return meaningful(chat).some((m) => m.direction === "in" && m.timestamp > since);
  }

  private youWroteSince(waId: string, since: number): boolean {
    const marks = this.sameNumber(waId);
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM messages WHERE wa_id IN (${marks.map(() => "?").join(",")})
           AND direction = 'out' AND source = 'echo' AND type != 'reaction' AND timestamp > ? LIMIT 1`,
        )
        .get(...marks, since),
    );
  }

  private cancelScheduledFor(waId: string, reason: string, onlyCancelOnReply: boolean): void {
    const key = phoneKey(waId);
    const rows = (this.db.prepare(`SELECT * FROM outbox WHERE status = 'scheduled'`).all() as OutboxRow[]).filter(
      (r) => phoneKey(r.wa_id) === key && (!onlyCancelOnReply || r.cancel_on_reply),
    );
    for (const r of rows) {
      this.setOutbox(r.id, "cancelled", { error: reason });
      this.event(r.wa_id, "cancelled", reason, { outboxId: r.id });
    }
  }

  private insertOutbox(waId: string, content: Content, status: "draft" | "scheduled", sendAt: number | null, cancelOnReply: boolean, note?: string): OutboxRow {
    if (!content.text && !content.template) throw new Error("Give the message text, a template, or both.");
    const id = this.knownId(waId);
    this.deps.store.upsertContact({ waId: id });
    const r = this.db
      .prepare(
        `INSERT INTO outbox (wa_id, content, preview, status, send_at, cancel_on_reply, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, JSON.stringify(content), describeContent(content), status, sendAt, cancelOnReply ? 1 : 0, note ?? null, this.nowSec, this.nowSec);
    return this.outbox(Number(r.lastInsertRowid))!;
  }

  private setOutbox(id: number, status: OutboxRow["status"], extra: { messageId?: string; error?: string } = {}): void {
    this.db
      .prepare(`UPDATE outbox SET status = ?, message_id = COALESCE(?, message_id), error = ?, updated_at = ? WHERE id = ?`)
      .run(status, extra.messageId ?? null, extra.error ?? null, this.nowSec, id);
  }

  private event(waId: string, kind: EventKind, detail: string, refs: { enrollmentId?: number; outboxId?: number } = {}): void {
    this.db
      .prepare(`INSERT INTO followup_events (at, wa_id, enrollment_id, outbox_id, kind, detail) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(this.nowSec, waId, refs.enrollmentId ?? null, refs.outboxId ?? null, kind, detail);
    if (kind === "failed") this.log.warn(`followups: +${waId}: ${detail}`);
  }
}
