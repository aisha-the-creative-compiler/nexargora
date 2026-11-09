/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FIXED_NOW_MS,
  formatCents,
  getCustomer,
  getLedger,
  getOrder,
  issueRefund,
  Order,
  RefundLedgerEntry,
} from './store.ts';

export type Verdict = 'ALLOW' | 'REVIEW' | 'BLOCK';
export type FindingLevel = 'BLOCK' | 'REVIEW';

export interface Finding {
  level: FindingLevel;
  rule: string;
  detail: string;
}

export interface Action {
  type: string;
  orderId?: string;
  amountCents?: number;
  destination?: string;
  [key: string]: unknown;
}

/**
 * Editable Policy Object
 * All thresholds ($100, 30 days, 3 refunds, $500, 24 hours) live here, not hard-coded.
 */
export interface GatePolicy {
  autoLimitCents: number; // $100 -> 10000 cents
  returnWindowDays: number; // 30 days
  frequentRefundCount: number; // 3 refunds
  frequentRefundDays: number; // 30 days
  dailyStoreCapCents: number; // $500 -> 50000 cents
  dailyWindowHours: number; // 24 hours
  duplicateWindowHours: number; // 24 hours
}

export const DEFAULT_POLICY: GatePolicy = {
  autoLimitCents: 10000, // $100.00
  returnWindowDays: 30, // 30 days
  frequentRefundCount: 3, // 3 or more refunds
  frequentRefundDays: 30, // in the last 30 days
  dailyStoreCapCents: 50000, // $500.00 store-wide
  dailyWindowHours: 24, // 24 hours
  duplicateWindowHours: 24, // 24 hours
};

// Global active policy object
export let policy: GatePolicy = { ...DEFAULT_POLICY };

const policyListeners = new Set<() => void>();

export function updatePolicy(newPolicy: Partial<GatePolicy>): void {
  policy = { ...policy, ...newPolicy };
  policyListeners.forEach((fn) => fn());
}

export function resetPolicy(): void {
  policy = { ...DEFAULT_POLICY };
  policyListeners.forEach((fn) => fn());
}

export function subscribePolicy(listener: () => void): () => void {
  policyListeners.add(listener);
  return () => policyListeners.delete(listener);
}

/**
 * Pending Review Tickets
 */
export interface PendingTicket {
  id: string; // Short random ID, e.g. TKT-9X42
  action: Action;
  findings: Finding[];
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  refundResult?: ReturnType<typeof issueRefund>;
}

const pendingTickets: Map<string, PendingTicket> = new Map();

export function getPendingTickets(): PendingTicket[] {
  return Array.from(pendingTickets.values()).reverse();
}

export function setPendingTickets(tickets: PendingTicket[]): void {
  pendingTickets.clear();
  for (const t of tickets) {
    pendingTickets.set(t.id, t);
  }
}

export function getPendingTicket(id: string): PendingTicket | undefined {
  return pendingTickets.get(id);
}

export function clearPendingTickets(): void {
  pendingTickets.clear();
}

function generateShortTicketId(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TKT-${rand}`;
}

/**
 * Audit Log Subsystem
 * Records every event: time, who did it, action, verdict, execution status, rules fired.
 * Events: proposed, approved, rejected, approval blocked by re-check.
 */
export type AuditActor = 'agent' | 'human' | 'test';
export type AuditEventType = 'proposed' | 'approved' | 'rejected' | 'approval blocked by re-check';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: AuditActor;
  actorName?: string;
  event: AuditEventType;
  action: Action;
  verdict: Verdict;
  executed: boolean;
  rulesFired: string[];
  ticketId?: string;
  note?: string;
}

let auditLog: AuditLogEntry[] = [];
const auditListeners = new Set<() => void>();

function notifyAudit() {
  auditListeners.forEach((fn) => fn());
}

export function getAuditLog(): AuditLogEntry[] {
  return [...auditLog];
}

export function setAuditLog(entries: AuditLogEntry[]): void {
  auditLog = [...entries];
  notifyAudit();
}

export function clearAuditLog(): void {
  auditLog = [];
  notifyAudit();
}

export function subscribeAuditLog(listener: () => void): () => void {
  auditListeners.add(listener);
  return () => auditListeners.delete(listener);
}

export function recordAuditEvent(entry: Omit<AuditLogEntry, 'id' | 'timestamp'> & { timestamp?: string }): AuditLogEntry {
  const id = `AUD-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
  const fullEntry: AuditLogEntry = {
    id,
    timestamp: entry.timestamp || new Date(FIXED_NOW_MS).toISOString(),
    ...entry,
  };
  auditLog.unshift(fullEntry);
  notifyAudit();
  return fullEntry;
}

export interface ProposeResult {
  verdict: Verdict;
  findings: Finding[];
  ticketId?: string;
  refundResult?: ReturnType<typeof issueRefund>;
  order?: Order;
}

/**
 * Checks all structural and BLOCK rules against the current store state.
 * Used both in propose() and when approving pending tickets to prevent race conditions.
 */
export function checkBlockRules(action: Action): Finding[] {
  const blockFindings: Finding[] = [];

  // 1. Structural checks
  if (!action || action.type !== 'refund') {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'unknown_action',
      detail: `Action type "${action?.type}" is not recognized. The gate only handles "refund" actions.`,
    });
    return blockFindings;
  }

  if (
    typeof action.amountCents !== 'number' ||
    !Number.isInteger(action.amountCents) ||
    action.amountCents <= 0
  ) {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'bad_amount',
      detail: `Amount ${action.amountCents} is not a valid positive whole number of cents.`,
    });
    return blockFindings;
  }

  if (!action.orderId) {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'order_not_found',
      detail: 'No orderId was provided in the proposal.',
    });
    return blockFindings;
  }

  const order = getOrder(action.orderId);
  if (!order) {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'order_not_found',
      detail: `Order "${action.orderId}" does not exist in store records.`,
    });
    return blockFindings;
  }

  // 2. BLOCK rules against live store state

  // Rule: not_delivered (order status is not "delivered")
  if (order.status !== 'delivered') {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'not_delivered',
      detail: `Order ${order.id} status is "${order.status}". Refunds are only permitted for delivered orders.`,
    });
  }

  // Rule: exceeds_refundable (amount is more than total minus already refunded)
  const remainingRefundableCents = order.totalAmountCents - order.refundedAmountCents;
  if (action.amountCents > remainingRefundableCents) {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'exceeds_refundable',
      detail: `Proposed refund of ${formatCents(action.amountCents)} exceeds remaining refundable balance of ${formatCents(remainingRefundableCents)} on order ${order.id}.`,
    });
  }

  // Rule: wrong_destination (destination is set and is not the original payment method)
  if (
    action.destination !== undefined &&
    action.destination !== null &&
    action.destination.trim() !== ''
  ) {
    const originalMethod = order.originalPaymentMethod || 'original_payment_method';
    const matchesOriginal =
      action.destination === originalMethod ||
      action.destination === 'original' ||
      action.destination === 'original_payment_method';

    if (!matchesOriginal) {
      blockFindings.push({
        level: 'BLOCK',
        rule: 'wrong_destination',
        detail: `Destination "${action.destination}" does not match the original payment method (${originalMethod}).`,
      });
    }
  }

  // Rule: duplicate (same order and same amount already refunded in the last 24 hours)
  const ledger = getLedger();
  const duplicateCutoffMs = FIXED_NOW_MS - policy.duplicateWindowHours * 60 * 60 * 1000;
  const duplicateEntry = ledger.find((entry) => {
    const entryTimeMs = new Date(entry.timestamp).getTime();
    return (
      entry.orderId === action.orderId &&
      entry.amountCents === action.amountCents &&
      entryTimeMs >= duplicateCutoffMs &&
      entryTimeMs <= FIXED_NOW_MS
    );
  });

  if (duplicateEntry) {
    blockFindings.push({
      level: 'BLOCK',
      rule: 'duplicate',
      detail: `A refund of ${formatCents(action.amountCents)} for order ${action.orderId} was already issued within the last ${policy.duplicateWindowHours} hours (Ledger ID: ${duplicateEntry.id}).`,
    });
  }

  return blockFindings;
}

/**
 * Main Deterministic Gate Function: propose(action, actor?)
 * Pure, rule-based logic with zero AI model / API dependencies.
 */
export function propose(action: Action, actor: AuditActor = 'agent'): ProposeResult {
  // Run structural checks first
  if (!action || action.type !== 'refund') {
    const result: ProposeResult = {
      verdict: 'BLOCK',
      findings: [
        {
          level: 'BLOCK',
          rule: 'unknown_action',
          detail: `Action type "${action?.type}" is not recognized. The gate only handles "refund" actions.`,
        },
      ],
    };
    recordAuditEvent({
      actor,
      actorName: actor === 'agent' ? 'Autonomous CX Agent' : actor === 'test' ? 'Test Runner' : 'Supervisor',
      event: 'proposed',
      action: { ...action },
      verdict: 'BLOCK',
      executed: false,
      rulesFired: ['unknown_action'],
    });
    return result;
  }

  if (
    typeof action.amountCents !== 'number' ||
    !Number.isInteger(action.amountCents) ||
    action.amountCents <= 0
  ) {
    const result: ProposeResult = {
      verdict: 'BLOCK',
      findings: [
        {
          level: 'BLOCK',
          rule: 'bad_amount',
          detail: `Amount ${action.amountCents} is not a valid positive whole number of cents.`,
        },
      ],
    };
    recordAuditEvent({
      actor,
      actorName: actor === 'agent' ? 'Autonomous CX Agent' : actor === 'test' ? 'Test Runner' : 'Supervisor',
      event: 'proposed',
      action: { ...action },
      verdict: 'BLOCK',
      executed: false,
      rulesFired: ['bad_amount'],
    });
    return result;
  }

  if (!action.orderId) {
    const result: ProposeResult = {
      verdict: 'BLOCK',
      findings: [
        {
          level: 'BLOCK',
          rule: 'order_not_found',
          detail: 'No orderId was provided in the proposal.',
        },
      ],
    };
    recordAuditEvent({
      actor,
      actorName: actor === 'agent' ? 'Autonomous CX Agent' : actor === 'test' ? 'Test Runner' : 'Supervisor',
      event: 'proposed',
      action: { ...action },
      verdict: 'BLOCK',
      executed: false,
      rulesFired: ['order_not_found'],
    });
    return result;
  }

  const order = getOrder(action.orderId);
  if (!order) {
    const result: ProposeResult = {
      verdict: 'BLOCK',
      findings: [
        {
          level: 'BLOCK',
          rule: 'order_not_found',
          detail: `Order "${action.orderId}" does not exist in store records.`,
        },
      ],
    };
    recordAuditEvent({
      actor,
      actorName: actor === 'agent' ? 'Autonomous CX Agent' : actor === 'test' ? 'Test Runner' : 'Supervisor',
      event: 'proposed',
      action: { ...action },
      verdict: 'BLOCK',
      executed: false,
      rulesFired: ['order_not_found'],
    });
    return result;
  }

  const findings: Finding[] = [];

  // ==========================================
  // BLOCK Rules
  // ==========================================
  const blockFindings = checkBlockRules(action);
  findings.push(...blockFindings);

  // ==========================================
  // REVIEW Rules (Valid on paper, but risky)
  // ==========================================

  // Rule: over_auto_limit (amount above $100)
  if (action.amountCents > policy.autoLimitCents) {
    findings.push({
      level: 'REVIEW',
      rule: 'over_auto_limit',
      detail: `Proposed refund of ${formatCents(action.amountCents)} exceeds the autonomous limit of ${formatCents(policy.autoLimitCents)}.`,
    });
  }

  // Rule: outside_window (delivered more than 30 days ago)
  if (order.deliveredAt) {
    const deliveryMs = new Date(order.deliveredAt).getTime();
    const daysSinceDelivery = Math.floor((FIXED_NOW_MS - deliveryMs) / (24 * 60 * 60 * 1000));
    if (daysSinceDelivery > policy.returnWindowDays) {
      findings.push({
        level: 'REVIEW',
        rule: 'outside_window',
        detail: `Order was delivered ${daysSinceDelivery} days ago, exceeding the ${policy.returnWindowDays}-day return policy window.`,
      });
    }
  }

  // Rule: risky_customer (customer is flagged)
  const customer = getCustomer(order.customerId);
  if (customer && customer.riskFlag === 'high_risk') {
    findings.push({
      level: 'REVIEW',
      rule: 'risky_customer',
      detail: `Customer ${customer.name} (${customer.id}) is flagged high risk: ${customer.riskReason || 'Account risk flag active'}.`,
    });
  }

  // Rule: frequent_refunds (customer has 3 or more refunds in the last 30 days)
  if (customer) {
    const frequentCutoffMs = FIXED_NOW_MS - policy.frequentRefundDays * 24 * 60 * 60 * 1000;
    const ledger = getLedger();
    const customerPastRefunds = ledger.filter((entry) => {
      const entryMs = new Date(entry.timestamp).getTime();
      return (
        entry.customerId === customer.id &&
        entryMs >= frequentCutoffMs &&
        entryMs <= FIXED_NOW_MS
      );
    });

    if (customerPastRefunds.length >= policy.frequentRefundCount) {
      findings.push({
        level: 'REVIEW',
        rule: 'frequent_refunds',
        detail: `Customer ${customer.name} has had ${customerPastRefunds.length} refunds in the last ${policy.frequentRefundDays} days (threshold is ${policy.frequentRefundCount}).`,
      });
    }
  }

  // Rule: daily_cap (total refunds in the last 24 hours plus this one would be over $500)
  const ledger = getLedger();
  const dailyCutoffMs = FIXED_NOW_MS - policy.dailyWindowHours * 60 * 60 * 1000;
  const recentStoreRefunds = ledger.filter((entry) => {
    const entryMs = new Date(entry.timestamp).getTime();
    return entryMs >= dailyCutoffMs && entryMs <= FIXED_NOW_MS;
  });
  const total24hStoreCents = recentStoreRefunds.reduce((sum, e) => sum + e.amountCents, 0);

  if (total24hStoreCents + action.amountCents > policy.dailyStoreCapCents) {
    findings.push({
      level: 'REVIEW',
      rule: 'daily_cap',
      detail: `Store refunds in the last ${policy.dailyWindowHours}h (${formatCents(total24hStoreCents)}) plus this refund (${formatCents(action.amountCents)}) total ${formatCents(total24hStoreCents + action.amountCents)}, exceeding the ${formatCents(policy.dailyStoreCapCents)} daily safety cap.`,
    });
  }

  // ==========================================
  // Final Verdict & Execution
  // ==========================================
  const hasBlock = findings.some((f) => f.level === 'BLOCK');
  const hasReview = findings.some((f) => f.level === 'REVIEW');

  let verdict: Verdict = 'ALLOW';
  let ticketId: string | undefined;
  let refundResult: ReturnType<typeof issueRefund> | undefined;

  if (hasBlock) {
    verdict = 'BLOCK';
  } else if (hasReview) {
    verdict = 'REVIEW';
    ticketId = generateShortTicketId();
    const ticket: PendingTicket = {
      id: ticketId,
      action: { ...action },
      findings: findings.filter((f) => f.level === 'REVIEW'),
      createdAt: new Date(FIXED_NOW_MS).toISOString(),
      status: 'pending',
    };
    pendingTickets.set(ticketId, ticket);
  } else {
    verdict = 'ALLOW';
    refundResult = issueRefund(
      action.orderId,
      action.amountCents,
      `Gate ALLOW: Autonomous refund for order ${action.orderId}`
    );
  }

  // Record to Audit Log
  recordAuditEvent({
    actor,
    actorName: actor === 'agent' ? 'Autonomous CX Agent' : actor === 'test' ? 'Test Runner' : 'Supervisor',
    event: 'proposed',
    action: { ...action },
    verdict,
    executed: verdict === 'ALLOW',
    rulesFired: findings.map((f) => f.rule),
    ticketId,
  });

  return {
    verdict,
    findings,
    ticketId,
    refundResult,
    order: getOrder(action.orderId),
  };
}

export interface ApproveResult {
  success: boolean;
  blockFindings?: Finding[];
  error?: string;
  refundResult?: ReturnType<typeof issueRefund>;
}

/**
 * Approves a pending ticket.
 * FIRST runs all the BLOCK rules again against the current state of the store.
 * If any BLOCK rule now fires, does not execute the refund, and shows why.
 * If none fire, calls issueRefund.
 */
export function approve(ticketId: string, approver: string): ApproveResult {
  const ticket = pendingTickets.get(ticketId);
  if (!ticket) {
    return { success: false, error: `Ticket "${ticketId}" not found.` };
  }

  // FIRST run all the BLOCK rules again against the current state of the store
  const blockFindings = checkBlockRules(ticket.action);
  if (blockFindings.length > 0) {
    // Record audit event: approval blocked by re-check
    recordAuditEvent({
      actor: 'human',
      actorName: approver,
      event: 'approval blocked by re-check',
      action: { ...ticket.action },
      verdict: 'BLOCK',
      executed: false,
      rulesFired: blockFindings.map((f) => f.rule),
      ticketId,
      note: `Approval blocked on re-check: ${blockFindings.map((f) => f.rule).join(', ')}`,
    });

    return {
      success: false,
      blockFindings,
      error: `Approval blocked by safety invariant: ${blockFindings.map((f) => f.detail).join(' ')}`,
    };
  }

  // If none fire, call issueRefund
  const refundResult = issueRefund(
    ticket.action.orderId!,
    ticket.action.amountCents!,
    `Gate OVERRIDE on ticket ${ticketId} approved by ${approver}`,
    'manual_override'
  );

  if (!refundResult.success) {
    return {
      success: false,
      error: refundResult.error,
    };
  }

  // Remove the ticket upon successful approval
  pendingTickets.delete(ticketId);

  // Record audit event: approved
  recordAuditEvent({
    actor: 'human',
    actorName: approver,
    event: 'approved',
    action: { ...ticket.action },
    verdict: 'ALLOW',
    executed: true,
    rulesFired: ticket.findings.map((f) => f.rule),
    ticketId,
    note: `Approved by ${approver}`,
  });

  return {
    success: true,
    refundResult,
  };
}

export interface RejectResult {
  success: boolean;
  error?: string;
}

/**
 * Rejects a pending ticket: removes the ticket and executes nothing.
 */
export function reject(ticketId: string, approver: string = 'Supervisor'): RejectResult {
  const ticket = pendingTickets.get(ticketId);
  if (!ticket) {
    return { success: false, error: `Ticket "${ticketId}" not found.` };
  }

  // Record audit event: rejected
  recordAuditEvent({
    actor: 'human',
    actorName: approver,
    event: 'rejected',
    action: { ...ticket.action },
    verdict: 'BLOCK',
    executed: false,
    rulesFired: ticket.findings.map((f) => f.rule),
    ticketId,
    note: `Rejected by ${approver}`,
  });

  // Reject removes the ticket and executes nothing
  pendingTickets.delete(ticketId);

  return { success: true };
}

// Backwards-compatibility aliases
export const approvePendingTicket = approve;
export const rejectPendingTicket = reject;
