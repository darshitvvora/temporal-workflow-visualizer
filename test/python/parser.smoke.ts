/**
 * End-to-end smoke test for the new AST-based PythonParser.
 *
 * Runs each fixture through `new PythonParser(source, filePath).parse()` and
 * asserts the produced WorkflowModel has the expected structural properties.
 * This is the final stage check — if these pass, the rest of the extension
 * (diagramGenerator, webviewPanel) sees a model it knows how to render.
 *
 * Run with `npm run test:python` (composed into the existing script).
 */

import * as fs from 'fs';
import * as path from 'path';

import { initPythonParser } from '../../src/parsers/python/astHelpers';
import { PythonParser } from '../../src/parsers/pythonParser';
import { WorkflowModel, WorkflowNode } from '../../src/types';

interface FixtureCheck {
  file: string;
  expectedName: string;
  assertion: (model: WorkflowModel) => void;
}

const CHECKS: FixtureCheck[] = [
  {
    file: 'basic_workflow.py',
    expectedName: 'BasicWorkflow',
    assertion: (model) => {
      assertEq(model.language, 'python', 'language');
      const flow = flowNodes(model);
      // There should be: uuid4, a condition for the patched-if, sleep, charge_card,
      // a condition for the CAN-if, and inside it CAN.
      const kinds = flow.map(n => n.kind);
      assertIncludes(kinds, 'condition', 'has if-decision nodes');
      assertIncludes(kinds, 'sideEffect', 'has continue_as_new');
      assertIncludes(kinds, 'activity', 'has charge_card');
      // The charge_card primitive inside the try must carry errorBranches.
      const charge = flow.find(n => n.label.startsWith('charge_card'));
      if (!charge) { throw new Error('no charge_card node'); }
      assertNonEmpty(charge.errorBranches, 'charge_card has errorBranches');
      assertEq(charge.errorBranches![0].edgeLabel, 'except ActivityError', 'except label');
    },
  },
  {
    file: 'aliased_imports.py',
    expectedName: 'AliasedWorkflow',
    assertion: (model) => {
      const flow = flowNodes(model);
      // Top-level: sleep, step_one (try body), gather. The gather's parallel
      // arms (step_two, step_three) now live inside `gather.branches[].nodes`
      // — not as top-level flat siblings — so the renderer can fan-out.
      const topLabels = flow.map(n => n.label).join(' | ');
      assertIncludes(topLabels, 'sleep', 'has sleep at top level');
      assertIncludes(topLabels, 'step_one', 'has step_one at top level');
      assertIncludes(topLabels, 'gather', 'has gather at top level');

      const gather = flow.find(n => n.label.includes('gather'));
      if (!gather) { throw new Error('no gather node'); }
      assertNonEmpty(gather.branches, 'gather has parallel branches');
      assertEq(gather.branches!.length, 2, 'gather has 2 parallel arms');
      const armLabels = gather.branches!.flatMap(b => b.nodes.map(n => n.label)).join(' | ');
      assertIncludes(armLabels, 'step_two', 'step_two is a parallel arm');
      assertIncludes(armLabels, 'step_three', 'step_three is a parallel arm');
      // Parallel arms use empty edge labels so the renderer omits them.
      assertEq(gather.branches!.every(b => b.edgeLabel === ''), true, 'parallel arms have empty edge label');
    },
  },
  {
    file: 'signals_queries_updates.py',
    expectedName: 'SignalQueryWorkflow',
    assertion: (model) => {
      // Run body has set_signal_handler, set_dynamic_query_handler, wait_condition.
      const flow = flowNodes(model);
      assertIncludes(flow.map(n => n.kind).join(','), 'signal', 'has dynamic signal node');
      assertIncludes(flow.map(n => n.kind).join(','), 'query', 'has dynamic query node');
      assertIncludes(flow.map(n => n.kind).join(','), 'condition', 'has wait_condition node');

      // Side handlers from decorators.
      const handlers = model.nodes.filter(n => n.role === 'signal-handler' || n.role === 'query-handler');
      // 2 signals (add, finish), 1 query (get_pending), 1 update (bulk_add).
      assertEq(handlers.length, 4, 'handler side-node count');

      // wait_condition predicate is surfaced in the label (lambda body text).
      const wait = flow.find(n => n.kind === 'condition' && n.label.startsWith('wait: '));
      if (!wait) { throw new Error('wait_condition label should show predicate'); }
      assertIncludes(wait.label, 'self._done', 'wait label includes predicate var');

      // No `while True:` here, but signals must still anchor at the wait —
      // signalTargetId carries the routing hint so the renderer points
      // handler arrows at the wait instead of START.
      assertEq(model.signalTargetId, wait.id, 'signalTargetId points at wait_condition');
      // …without triggering the loop-rendering path.
      assertEq(model.loopAnchorId, undefined, 'no loopAnchorId (no while True)');
    },
  },
  {
    file: 'child_and_external.py',
    expectedName: 'ChildOrchestratorWorkflow',
    assertion: (model) => {
      const flow = flowNodes(model);
      const kinds = flow.map(n => n.kind);
      assertIncludes(kinds, 'childWorkflow', 'has child workflow node');
      assertIncludes(kinds, 'localActivity', 'has local activity node');
      assertIncludes(kinds, 'nexus', 'has nexus node');
      const labels = flow.map(n => n.label).join(' | ');
      assertIncludes(labels, 'GreetingWorkflow', 'has GreetingWorkflow label');
      assertIncludes(labels, 'audit_log', 'has audit_log label');
      assertIncludes(labels, 'AggregationWorkflow', 'has AggregationWorkflow label');
    },
  },
  {
    file: 'saga_workflow.py',
    expectedName: 'TransferSagaWorkflow',
    assertion: (model) => {
      const flow = flowNodes(model);
      const kinds = flow.map(n => n.kind);

      // The for-loop produces a loop node + loopRegions entry.
      assertIncludes(kinds, 'loop', 'has loop node');
      assertNonEmpty(model.loopRegions, 'loopRegions populated');

      // The debit & credit activities live inside the try and must carry
      // errorBranches resolving to ActivityError compensation.
      const debit = flow.find(n => n.label.startsWith('debit_account'));
      const credit = flow.find(n => n.label.startsWith('credit_account'));
      if (!debit) { throw new Error('no debit_account node'); }
      if (!credit) { throw new Error('no credit_account node'); }
      assertNonEmpty(debit.errorBranches, 'debit has errorBranches');
      assertEq(debit.errorBranches![0].edgeLabel, 'except ActivityError', 'debit except label');

      // The except body contains refund + sleep, plus a nested raise (rendered
      // as a sideEffect "raise" marker at the tail).
      const refundInBranch = debit.errorBranches![0].nodes.find(n => n.label.startsWith('refund_account'));
      if (!refundInBranch) { throw new Error('no refund inside except'); }

      // Gather inside the try should fan out to notify_source + notify_dest
      // as parallel arms (NOT flat siblings of debit/credit).
      const gather = flow.find(n => n.label.includes('gather'));
      if (!gather) { throw new Error('no gather node in saga'); }
      assertNonEmpty(gather.branches, 'saga gather has parallel branches');
      const armLabels = gather.branches!.flatMap(b => b.nodes.map(n => n.label)).join(' | ');
      assertIncludes(armLabels, 'notify_source', 'notify_source is a parallel arm');
      assertIncludes(armLabels, 'notify_dest', 'notify_dest is a parallel arm');
      // Parallel arms inside a try inherit the try's errorBranches.
      const firstArm = gather.branches![0].nodes[0];
      assertNonEmpty(firstArm.errorBranches, 'parallel arm inherits try errorBranches');

      // continue_as_new exists at top level.
      assertIncludes(flow.map(n => n.label).join(' | '), 'continue_as_new', 'has CAN');
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixturesDir = path.resolve(__dirname, '..', '..', '..', 'test', 'python', 'fixtures');
  await initPythonParser();

  let failures = 0;
  for (const check of CHECKS) {
    const srcPath = path.join(fixturesDir, check.file);
    const src = fs.readFileSync(srcPath, 'utf-8');
    try {
      const parser = new PythonParser(src, srcPath);
      const result = parser.parse();
      // `parse()` is sync here (init is already done), but the BaseParser
      // signature allows Promise — await regardless to mirror real usage.
      const model = await result;
      if (!model) { throw new Error('parser returned null'); }
      assertEq(model.name, check.expectedName, 'workflow name');
      check.assertion(model);
      process.stdout.write(`✓ ${check.file}\n`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`✗ ${check.file}\n  ${msg.split('\n').join('\n  ')}\n`);
    }
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} parser snapshot(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${CHECKS.length} parser snapshots passed.\n`);
}

// ─────────────────────────────────────────────────────────────────────────────

function flowNodes(model: WorkflowModel): WorkflowNode[] {
  return model.nodes.filter(n => !n.role || n.role === 'flow');
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertIncludes(haystack: string | string[], needle: string, label: string): void {
  const ok = typeof haystack === 'string' ? haystack.includes(needle) : haystack.includes(needle);
  if (!ok) {
    const shown = typeof haystack === 'string' ? haystack : `[${haystack.join(', ')}]`;
    throw new Error(`${label}: expected to include "${needle}", got ${shown}`);
  }
}
function assertNonEmpty<T>(arr: T[] | undefined, label: string): void {
  if (!arr || arr.length === 0) { throw new Error(`${label}: expected non-empty, got ${arr ? '[]' : 'undefined'}`); }
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
