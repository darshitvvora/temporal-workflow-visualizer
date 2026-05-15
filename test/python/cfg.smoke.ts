/**
 * CFG-level smoke test.
 *
 * Builds a WorkflowCfg from each fixture and asserts structural shape:
 *  - which control-flow constructs appear
 *  - how primitives are nested under them
 *  - parallel children of gather/wait
 *
 * Complements `recognizer.smoke.ts`, which only checks flat recognition.
 *
 * Run with: `npm run test:cfg`
 */

import * as fs from 'fs';
import * as path from 'path';

import { initPythonParser, parsePython, PyNodeType, namedChildren, unwrapDecorated } from '../../src/parsers/python/astHelpers';
import { buildImportContext } from '../../src/parsers/python/importContext';
import { buildWorkflowCfg } from '../../src/parsers/python/cfgBuilder';
import {
  FlowRegion,
  flattenPrimitives,
} from '../../src/parsers/python/cfgTypes';
import { Node } from 'web-tree-sitter';

interface FixtureCheck {
  file: string;
  workflowClass: string;
  /** A predicate that asserts on the built CFG; throw to fail. */
  assertion: (root: FlowRegion, lookup: CfgLookup) => void;
}

interface CfgLookup {
  /** All FlowPrimitives in source order. */
  primitives: ReturnType<typeof primitivesArray>;
  /** Find the first region matching `kind`, depth-first. */
  firstOfKind: (kind: FlowRegion['kind']) => FlowRegion | undefined;
  /** Find all regions matching `kind`, depth-first. */
  allOfKind: (kind: FlowRegion['kind']) => FlowRegion[];
}

const CHECKS: FixtureCheck[] = [
  // ── basic_workflow.py ─────────────────────────────────────────────────────
  {
    file: 'basic_workflow.py',
    workflowClass: 'BasicWorkflow',
    assertion: (root, lookup) => {
      // We expect: one top-level if, one try, plus a workflow.continue_as_new
      // outside the try.
      const ifNodes = lookup.allOfKind('if');
      assertEq(ifNodes.length, 2, 'if-statement count'); // one gating the sleep, one gating CAN
      const tryNodes = lookup.allOfKind('try');
      assertEq(tryNodes.length, 1, 'try count');

      // Try body contains charge_card; the except contains refund_card + raise.
      const tryNode = tryNodes[0];
      if (tryNode.kind !== 'try') { throw new Error('expected try'); }
      const tryBodyPrims = collectPrimitiveNames(tryNode.body);
      assertIncludes(tryBodyPrims, 'workflow.execute_activity', 'try body');

      assertEq(tryNode.excepts.length, 1, 'except count');
      const except = tryNode.excepts[0];
      assertEq(except.exceptionName, 'ActivityError', 'except resolves to ActivityError');
      const excPrims = collectPrimitiveNames(except.body);
      assertIncludes(excPrims, 'workflow.execute_activity', 'except body has refund call');

      // Continue-as-new sits inside the second if (the `if result == "RETRY":`).
      const canIf = ifNodes[1];
      if (canIf.kind !== 'if') { throw new Error('expected if'); }
      const canPrims = collectPrimitiveNames(canIf.branches[0].body);
      assertIncludes(canPrims, 'workflow.continue_as_new', 'CAN inside guard');
    },
  },

  // ── aliased_imports.py ────────────────────────────────────────────────────
  {
    file: 'aliased_imports.py',
    workflowClass: 'AliasedWorkflow',
    assertion: (_root, lookup) => {
      // asyncio.gather must appear as a primitive with two parallel children.
      const gathers = lookup.primitives.filter(p => p.recognized.primitive.qualifiedName === 'asyncio.gather');
      assertEq(gathers.length, 1, 'one asyncio.gather');
      const gather = gathers[0];
      assertEq(gather.parallelChildren?.length, 2, 'gather has 2 parallel children');
      const childNames = (gather.parallelChildren ?? []).map(c => c.recognized.targetName);
      assertDeepEq(childNames, ['step_two', 'step_three'], 'parallel children are step_two/step_three');
    },
  },

  // ── signals_queries_updates.py ────────────────────────────────────────────
  {
    file: 'signals_queries_updates.py',
    workflowClass: 'SignalQueryWorkflow',
    assertion: (_root, lookup) => {
      // The run body should contain two set_*_handler calls followed by a
      // wait_condition. No control-flow constructs.
      const primNames = lookup.primitives.map(p => p.recognized.primitive.qualifiedName);
      assertDeepEq(primNames, [
        'workflow.set_signal_handler',
        'workflow.set_dynamic_query_handler',
        'workflow.wait_condition',
      ], 'signal/query workflow run primitives');
    },
  },

  // ── child_and_external.py ─────────────────────────────────────────────────
  {
    file: 'child_and_external.py',
    workflowClass: 'ChildOrchestratorWorkflow',
    assertion: (_root, lookup) => {
      // start_child_workflow appears inside a list comprehension — verify it
      // still surfaces as a primitive.
      const primNames = lookup.primitives.map(p => p.recognized.primitive.qualifiedName);
      assertIncludes(primNames, 'workflow.start_child_workflow', 'child start');
      assertIncludes(primNames, 'workflow.execute_child_workflow', 'child execute');
      assertIncludes(primNames, 'workflow.execute_local_activity', 'local activity');
      assertIncludes(primNames, 'workflow.create_nexus_client', 'nexus');
      assertIncludes(primNames, 'workflow.get_external_workflow_handle_for', 'external handle');
    },
  },

  // ── saga_workflow.py — the nested control-flow stressor ───────────────────
  {
    file: 'saga_workflow.py',
    workflowClass: 'TransferSagaWorkflow',
    assertion: (root, lookup) => {
      // Expected shape: sequence[ if -> raise, for { try { ... } except { ... } }, continue_as_new, return ]
      if (root.kind !== 'sequence') { throw new Error(`expected sequence root, got ${root.kind}`); }
      const topKinds = root.children.map(c => c.kind);
      assertDeepEq(
        topKinds,
        ['if', 'for', 'primitive', 'return'],
        'top-level shape of run()',
      );

      // The first child is `if amount <= 0: raise`. Its branch body must contain a Raise.
      const firstIf = root.children[0];
      if (firstIf.kind !== 'if') { throw new Error('expected if'); }
      assertEq(firstIf.branches.length, 1, 'no else on amount check');
      const raises = lookupAll(firstIf.branches[0].body, 'raise');
      assertEq(raises.length, 1, 'one raise in amount check');

      // The for loop wraps a try/except.
      const forLoop = root.children[1];
      if (forLoop.kind !== 'for') { throw new Error('expected for'); }
      assertEq(forLoop.targetText, 'attempt', 'for target');
      const trys = lookupAll(forLoop.body, 'try');
      assertEq(trys.length, 1, 'try inside for');

      const tryNode = trys[0];
      if (tryNode.kind !== 'try') { throw new Error('expected try'); }

      // Try body: debit, credit, gather of 2 notifies (its parallel children
      // are flattened into the enumeration), then return.
      const tryPrimNames = collectPrimitiveNames(tryNode.body);
      assertDeepEq(tryPrimNames, [
        'workflow.execute_activity',  // debit_account
        'workflow.execute_activity',  // credit_account
        'asyncio.gather',
        'workflow.execute_activity',  // notify_source (parallel child)
        'workflow.execute_activity',  // notify_dest   (parallel child)
      ], 'try body primitives');

      // Gather has 2 parallel children.
      const gathersInTry = primitivesIn(tryNode.body).filter(p => p.recognized.primitive.qualifiedName === 'asyncio.gather');
      assertEq(gathersInTry.length, 1, 'one gather in try body');
      assertEq(gathersInTry[0].parallelChildren?.length, 2, 'gather fan-out is 2');

      // Try body must end with a return.
      const returnsInTryBody = lookupAll(tryNode.body, 'return');
      assertEq(returnsInTryBody.length, 1, 'return inside try success path');

      // Except: refund + nested if (last attempt → raise) + sleep.
      assertEq(tryNode.excepts.length, 1, 'one except');
      const except = tryNode.excepts[0];
      assertEq(except.exceptionName, 'ActivityError', 'except type resolved');
      const excPrimNames = collectPrimitiveNames(except.body);
      // Refund executes, then there's an if-guarded raise, then a sleep.
      assertIncludes(excPrimNames, 'workflow.execute_activity', 'refund in except');
      assertIncludes(excPrimNames, 'workflow.sleep', 'backoff sleep in except');
      const exceptIfs = lookupAll(except.body, 'if');
      assertEq(exceptIfs.length, 1, 'one if guarding the rethrow');
      const exceptRaises = lookupAll(except.body, 'raise');
      assertEq(exceptRaises.length, 1, 'one raise in except');

      // The continue_as_new sits at top level after the loop.
      const can = root.children[2];
      if (can.kind !== 'primitive') { throw new Error('expected primitive (CAN)'); }
      assertEq(can.recognized.primitive.qualifiedName, 'workflow.continue_as_new', 'CAN at top');

      // Quick sanity on overall primitive count.
      assertEq(lookup.primitives.length, 8, 'total primitive count');
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixturesDir = path.resolve(__dirname, '..', '..', '..', 'test', 'python', 'fixtures');
  await initPythonParser();

  let failures = 0;
  for (const check of CHECKS) {
    const src = fs.readFileSync(path.join(fixturesDir, check.file), 'utf-8');
    const tree = parsePython(src);
    const ctx = buildImportContext(tree.rootNode);

    const classNode = findDecoratedClassByName(tree.rootNode, check.workflowClass);
    if (!classNode) {
      failures++;
      process.stdout.write(`✗ ${check.file}\n  class not found: ${check.workflowClass}\n`);
      continue;
    }

    const wfCfg = buildWorkflowCfg(classNode, ctx);
    if (!wfCfg?.run) {
      failures++;
      process.stdout.write(`✗ ${check.file}\n  @workflow.run not found\n`);
      continue;
    }

    try {
      const lookup = makeLookup(wfCfg.run.body);
      check.assertion(wfCfg.run.body, lookup);
      process.stdout.write(`✓ ${check.file}\n`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`✗ ${check.file}\n  ${msg.split('\n').join('\n  ')}\n`);
    }
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} CFG check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${CHECKS.length} CFG checks passed.\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeLookup(root: FlowRegion): CfgLookup {
  return {
    primitives: primitivesArray(root),
    firstOfKind: (kind) => lookupFirst(root, kind),
    allOfKind: (kind) => lookupAll(root, kind),
  };
}

function primitivesArray(root: FlowRegion) {
  return Array.from(flattenPrimitives(root));
}

function primitivesIn(root: FlowRegion) {
  return Array.from(flattenPrimitives(root));
}

function collectPrimitiveNames(root: FlowRegion): string[] {
  return primitivesIn(root).map(p => p.recognized.primitive.qualifiedName);
}

function lookupFirst(root: FlowRegion, kind: FlowRegion['kind']): FlowRegion | undefined {
  for (const r of walkRegions(root)) {
    if (r.kind === kind) { return r; }
  }
  return undefined;
}

function lookupAll(root: FlowRegion, kind: FlowRegion['kind']): FlowRegion[] {
  const out: FlowRegion[] = [];
  for (const r of walkRegions(root)) {
    if (r.kind === kind) { out.push(r); }
  }
  return out;
}

function* walkRegions(root: FlowRegion): Generator<FlowRegion> {
  yield root;
  switch (root.kind) {
    case 'sequence':
      for (const c of root.children) { yield* walkRegions(c); }
      return;
    case 'primitive':
      if (root.parallelChildren) {
        for (const c of root.parallelChildren) { yield* walkRegions(c); }
      }
      return;
    case 'if':
      for (const b of root.branches) { yield* walkRegions(b.body); }
      return;
    case 'try':
      yield* walkRegions(root.body);
      for (const ex of root.excepts) { yield* walkRegions(ex.body); }
      if (root.elseClause) { yield* walkRegions(root.elseClause); }
      if (root.finallyClause) { yield* walkRegions(root.finallyClause); }
      return;
    case 'for':
    case 'while':
      yield* walkRegions(root.body);
      if (root.elseClause) { yield* walkRegions(root.elseClause); }
      return;
    case 'with':
      yield* walkRegions(root.body);
      return;
    case 'match':
      for (const c of root.cases) { yield* walkRegions(c.body); }
      return;
    case 'return':
    case 'raise':
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertDeepEq<T>(actual: T, expected: T, label: string): void {
  assertEq(actual, expected, label);
}
function assertIncludes(haystack: string[], needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected to include "${needle}", got [${haystack.join(', ')}]`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AST traversal helper
// ─────────────────────────────────────────────────────────────────────────────

function findDecoratedClassByName(root: Node, className: string): Node | null {
  for (const stmt of namedChildren(root)) {
    if (stmt.type !== PyNodeType.DecoratedDefinition) { continue; }
    const u = unwrapDecorated(stmt);
    if (!u || u.definition.type !== PyNodeType.ClassDefinition) { continue; }
    if (u.definition.childForFieldName('name')?.text === className) { return stmt; }
  }
  return null;
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
