/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  propose,
  approve,
  reject,
  clearPendingTickets,
  getPendingTickets,
  resetPolicy,
} from './gate.ts';
import { getOrder, issueRefund, resetStore } from './store.ts';

interface TestCase {
  name: string;
  action: {
    type: string;
    orderId?: string;
    amountCents?: number;
    destination?: string;
  };
  expectedVerdict: 'ALLOW' | 'REVIEW' | 'BLOCK';
  expectedRule?: string;
  validate?: (res: ReturnType<typeof propose>) => void;
}

const testCases: TestCase[] = [
  // 1. A100 for $20 gives ALLOW.
  {
    name: 'A100 for $20 gives ALLOW',
    action: {
      type: 'refund',
      orderId: 'A100',
      amountCents: 2000, // $20.00
    },
    expectedVerdict: 'ALLOW',
    validate: (res) => {
      if (res.ticketId) {
        throw new Error(`Expected ALLOW not to create a ticket, but got ticketId ${res.ticketId}`);
      }
      const order = getOrder('A100');
      if (!order || order.refundedAmountCents !== 2000) {
        throw new Error(`Expected order A100 refundedAmountCents to be 2000, got ${order?.refundedAmountCents}`);
      }
      if (!res.refundResult?.success) {
        throw new Error('Expected refundResult.success to be true for ALLOW');
      }
    },
  },

  // 2. A101 for $250 gives REVIEW.
  {
    name: 'A101 for $250 gives REVIEW',
    action: {
      type: 'refund',
      orderId: 'A101',
      amountCents: 25000, // $250.00
    },
    expectedVerdict: 'REVIEW',
    expectedRule: 'over_auto_limit',
    validate: (res) => {
      if (!res.ticketId) {
        throw new Error('Expected REVIEW to create a pending ticket, but ticketId was missing');
      }
      const order = getOrder('A101');
      if (order && order.refundedAmountCents !== 0) {
        throw new Error('Expected REVIEW not to call issueRefund on order A101');
      }
    },
  },

  // 3. A102 for $30 gives REVIEW.
  {
    name: 'A102 for $30 gives REVIEW',
    action: {
      type: 'refund',
      orderId: 'A102',
      amountCents: 3000, // $30.00
    },
    expectedVerdict: 'REVIEW',
    expectedRule: 'outside_window',
    validate: (res) => {
      if (!res.ticketId) {
        throw new Error('Expected REVIEW to create a pending ticket, but ticketId was missing');
      }
      const order = getOrder('A102');
      if (order && order.refundedAmountCents !== 0) {
        throw new Error('Expected REVIEW not to call issueRefund on order A102');
      }
    },
  },

  // 4. A103 for $10 gives REVIEW.
  {
    name: 'A103 for $10 gives REVIEW',
    action: {
      type: 'refund',
      orderId: 'A103',
      amountCents: 1000, // $10.00
    },
    expectedVerdict: 'REVIEW',
    expectedRule: 'risky_customer',
    validate: (res) => {
      if (!res.ticketId) {
        throw new Error('Expected REVIEW to create a pending ticket, but ticketId was missing');
      }
      const order = getOrder('A103');
      if (order && order.refundedAmountCents !== 0) {
        throw new Error('Expected REVIEW not to call issueRefund on order A103');
      }
    },
  },

  // 5. A104 gives BLOCK.
  {
    name: 'A104 gives BLOCK',
    action: {
      type: 'refund',
      orderId: 'A104',
      amountCents: 5000, // $50.00 (or any amount)
    },
    expectedVerdict: 'BLOCK',
    expectedRule: 'not_delivered',
    validate: (res) => {
      if (res.ticketId) {
        throw new Error('Expected BLOCK not to create a ticket');
      }
      const order = getOrder('A104');
      if (order && order.refundedAmountCents !== 0) {
        throw new Error('Expected BLOCK not to call issueRefund on order A104');
      }
    },
  },

  // 6. A105 gives BLOCK.
  {
    name: 'A105 gives BLOCK',
    action: {
      type: 'refund',
      orderId: 'A105',
      amountCents: 1000, // already fully refunded ($80 of $80)
    },
    expectedVerdict: 'BLOCK',
    expectedRule: 'exceeds_refundable',
    validate: (res) => {
      if (res.ticketId) {
        throw new Error('Expected BLOCK not to create a ticket');
      }
    },
  },

  // 7. Order A999 gives BLOCK.
  {
    name: 'Order A999 gives BLOCK',
    action: {
      type: 'refund',
      orderId: 'A999',
      amountCents: 1000,
    },
    expectedVerdict: 'BLOCK',
    expectedRule: 'order_not_found',
  },

  // 8. Amount -500 gives BLOCK.
  {
    name: 'Amount -500 gives BLOCK',
    action: {
      type: 'refund',
      orderId: 'A100',
      amountCents: -500,
    },
    expectedVerdict: 'BLOCK',
    expectedRule: 'bad_amount',
  },

  // 9. Type "delete_customer" gives BLOCK.
  {
    name: 'Type "delete_customer" gives BLOCK',
    action: {
      type: 'delete_customer',
      orderId: 'A100',
      amountCents: 1000,
    },
    expectedVerdict: 'BLOCK',
    expectedRule: 'unknown_action',
  },
];

export function runTests(): boolean {
  console.log('====================================================');
  console.log('   NexAegora Deterministic Gate Test Suite          ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    resetStore();
    resetPolicy();
    clearPendingTickets();

    try {
      const result = propose(tc.action);

      if (result.verdict !== tc.expectedVerdict) {
        throw new Error(
          `Verdict mismatch: expected "${tc.expectedVerdict}", got "${result.verdict}"`
        );
      }

      if (tc.expectedRule) {
        const found = result.findings.some((f) => f.rule === tc.expectedRule);
        if (!found) {
          const rules = result.findings.map((f) => f.rule).join(', ');
          throw new Error(
            `Expected finding rule "${tc.expectedRule}", but findings contained: [${rules}]`
          );
        }
      }

      if (tc.validate) {
        tc.validate(result);
      }

      console.log(`  ✓ PASS: ${tc.name}`);
      console.log(`    ↳ Verdict: ${result.verdict}`);
      if (result.findings.length > 0) {
        console.log(
          `    ↳ Findings: ${result.findings.map((f) => `[${f.level}] ${f.rule}`).join(' | ')}`
        );
      }
      if (result.ticketId) {
        console.log(`    ↳ Created Ticket: ${result.ticketId}`);
      }
      passed++;
    } catch (err: unknown) {
      console.error(`  ✗ FAIL: ${tc.name}`);
      console.error(`    ↳ Error: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log('\n--- Additional Guardrail Rule Verification ---');

  // Bonus 1: wrong_destination rule
  resetStore();
  clearPendingTickets();
  const wrongDestRes = propose({
    type: 'refund',
    orderId: 'A100',
    amountCents: 1000,
    destination: 'crypto_wallet_anonymous',
  });
  if (wrongDestRes.verdict === 'BLOCK' && wrongDestRes.findings.some((f) => f.rule === 'wrong_destination')) {
    console.log('  ✓ PASS: wrong_destination triggers BLOCK for non-original destination');
    passed++;
  } else {
    console.error('  ✗ FAIL: wrong_destination did not trigger BLOCK');
    failed++;
  }

  // Bonus 2: duplicate rule
  resetStore();
  clearPendingTickets();
  propose({ type: 'refund', orderId: 'A100', amountCents: 1000 });
  const dupRes = propose({ type: 'refund', orderId: 'A100', amountCents: 1000 });
  if (dupRes.verdict === 'BLOCK' && dupRes.findings.some((f) => f.rule === 'duplicate')) {
    console.log('  ✓ PASS: duplicate triggers BLOCK for same order & amount within 24h');
    passed++;
  } else {
    console.error('  ✗ FAIL: duplicate did not trigger BLOCK');
    failed++;
  }

  // Test approve() and reject()
  console.log('\n--- Approval & Race Condition Protection Verification ---');

  // Test 3: Normal approval executes issueRefund
  resetStore();
  clearPendingTickets();
  const reviewRes = propose({ type: 'refund', orderId: 'A101', amountCents: 25000 });
  const ticketId = reviewRes.ticketId!;
  const approveRes = approve(ticketId, 'Aisha');
  if (approveRes.success && getOrder('A101')?.refundedAmountCents === 25000 && getPendingTickets().length === 0) {
    console.log('  ✓ PASS: approve() successfully executed refund and removed ticket');
    passed++;
  } else {
    console.error('  ✗ FAIL: approve() failed to execute refund');
    failed++;
  }

  // Test 4: Approval BLOCKS if store changed while ticket was waiting (exceeds_refundable race condition)
  resetStore();
  clearPendingTickets();
  const t2Res = propose({ type: 'refund', orderId: 'A101', amountCents: 25000 });
  const t2Id = t2Res.ticketId!;
  // Store changes while waiting: order is partially refunded by another operation
  issueRefund('A101', 5000, 'Concurrent refund');
  // Now A101 only has $200 remaining, but ticket requests $250!
  const staleApproveRes = approve(t2Id, 'Aisha');
  if (
    !staleApproveRes.success &&
    staleApproveRes.blockFindings?.some((f) => f.rule === 'exceeds_refundable') &&
    getOrder('A101')?.refundedAmountCents === 5000
  ) {
    console.log('  ✓ PASS: approve() caught race condition and blocked over-refund');
    passed++;
  } else {
    console.error('  ✗ FAIL: approve() did not block stale over-refund');
    failed++;
  }

  // Test 5: reject() removes ticket and executes nothing
  resetStore();
  clearPendingTickets();
  const t3Res = propose({ type: 'refund', orderId: 'A102', amountCents: 3000 });
  const t3Id = t3Res.ticketId!;
  const rejectRes = reject(t3Id, 'Aisha');
  if (rejectRes.success && getOrder('A102')?.refundedAmountCents === 0 && getPendingTickets().length === 0) {
    console.log('  ✓ PASS: reject() removed ticket without issuing refund');
    passed++;
  } else {
    console.error('  ✗ FAIL: reject() did not remove ticket properly');
    failed++;
  }

  console.log(`\n====================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log(`====================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
  return true;
}

runTests();
