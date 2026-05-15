/**
 * Smoke test for the Python AST + Temporal primitive recognizer.
 *
 * Runs each fixture through tree-sitter + the recognizer and asserts that the
 * expected primitives are detected, in source order. Designed to be run with
 * `node out/test/python/recognizer.smoke.js` after `npm run compile`.
 *
 * No external test framework is used to keep the project dependency surface
 * unchanged — failures throw and the process exits non-zero.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  initPythonParser,
  parsePython,
  PyNodeType,
  unwrapDecorated,
  namedChildren,
} from '../../src/parsers/python/astHelpers';
import { buildImportContext } from '../../src/parsers/python/importContext';
import {
  recognizeCallsIn,
  recognizeDecorator,
  recognizeWorkflowClass,
  recognizeWorkflowMethods,
  recognizeExceptType,
  RecognizedCall,
} from '../../src/parsers/python/primitiveRecognizer';

interface ExpectedCall {
  qualifiedName: string;
  targetName?: string;
  awaited?: boolean;
}

interface FixtureExpectation {
  file: string;
  workflowClass: string;
  // In source order:
  expectedCalls: ExpectedCall[];
  // Expected method-level decorators on the workflow class:
  expectedMethodDecorators: Array<{ method: string; kind: string; exposedName: string }>;
  // Expected `except <Temporal exception>:` clauses (in source order):
  expectedExceptTypes: string[];
}

const FIXTURES: FixtureExpectation[] = [
  {
    file: 'basic_workflow.py',
    workflowClass: 'BasicWorkflow',
    expectedCalls: [
      { qualifiedName: 'workflow.uuid4' },
      { qualifiedName: 'workflow.patched' },
      { qualifiedName: 'workflow.sleep', awaited: true },
      { qualifiedName: 'workflow.execute_activity', targetName: 'charge_card', awaited: true },
      { qualifiedName: 'workflow.execute_activity', targetName: 'refund_card', awaited: true },
      { qualifiedName: 'workflow.continue_as_new' },
    ],
    expectedMethodDecorators: [
      { method: 'run', kind: 'decorator-workflow-run', exposedName: 'run' },
    ],
    expectedExceptTypes: ['ActivityError'],
  },
  {
    file: 'aliased_imports.py',
    workflowClass: 'AliasedWorkflow',
    expectedCalls: [
      { qualifiedName: 'workflow.unsafe.is_replaying' },
      { qualifiedName: 'workflow.sleep', awaited: true },
      { qualifiedName: 'workflow.execute_activity', targetName: 'step_one', awaited: true },
      { qualifiedName: 'workflow.execute_activity', targetName: 'compensate', awaited: true },
      { qualifiedName: 'asyncio.gather', awaited: true },
      { qualifiedName: 'workflow.execute_activity', targetName: 'step_two' },
      { qualifiedName: 'workflow.execute_activity', targetName: 'step_three' },
    ],
    expectedMethodDecorators: [
      { method: 'run', kind: 'decorator-workflow-run', exposedName: 'run' },
    ],
    expectedExceptTypes: ['ActivityError'],
  },
  {
    file: 'signals_queries_updates.py',
    workflowClass: 'SignalQueryWorkflow',
    expectedCalls: [
      { qualifiedName: 'workflow.set_signal_handler' },
      { qualifiedName: 'workflow.set_dynamic_query_handler' },
      { qualifiedName: 'workflow.wait_condition', awaited: true },
    ],
    expectedMethodDecorators: [
      { method: 'run',         kind: 'decorator-workflow-run',     exposedName: 'run' },
      { method: 'add',         kind: 'decorator-signal-handler',   exposedName: 'add' },
      { method: 'finish',      kind: 'decorator-signal-handler',   exposedName: 'external_finish' },
      { method: 'get_pending', kind: 'decorator-query-handler',    exposedName: 'get_pending' },
      { method: 'bulk_add',    kind: 'decorator-update-handler',   exposedName: 'bulk_add' },
      { method: '_validate_bulk_add', kind: 'decorator-update-validator', exposedName: '_validate_bulk_add' },
    ],
    expectedExceptTypes: [],
  },
  {
    file: 'child_and_external.py',
    workflowClass: 'ChildOrchestratorWorkflow',
    expectedCalls: [
      { qualifiedName: 'workflow.start_child_workflow', targetName: 'GreetingWorkflow', awaited: true },
      { qualifiedName: 'asyncio.gather', awaited: true },
      { qualifiedName: 'workflow.execute_local_activity', targetName: 'audit_log', awaited: true },
      { qualifiedName: 'workflow.get_external_workflow_handle_for', targetName: 'OtherWorkflow' },
      { qualifiedName: 'workflow.create_nexus_client' },
      { qualifiedName: 'workflow.execute_child_workflow', targetName: 'AggregationWorkflow', awaited: true },
    ],
    expectedMethodDecorators: [
      { method: 'run', kind: 'decorator-workflow-run', exposedName: 'run' },
    ],
    expectedExceptTypes: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────

interface Failure { fixture: string; message: string; }

async function main(): Promise<void> {
  // When compiled, __dirname is out/test/python; fixtures stay at test/python/fixtures
  const fixturesDir = path.resolve(__dirname, '..', '..', '..', 'test', 'python', 'fixtures');

  await initPythonParser();

  const failures: Failure[] = [];

  for (const fixture of FIXTURES) {
    const srcPath = path.join(fixturesDir, fixture.file);
    if (!fs.existsSync(srcPath)) {
      failures.push({ fixture: fixture.file, message: `fixture file missing: ${srcPath}` });
      continue;
    }
    const source = fs.readFileSync(srcPath, 'utf-8');

    try {
      runFixture(fixture, source);
      process.stdout.write(`✓ ${fixture.file}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ fixture: fixture.file, message: msg });
      process.stdout.write(`✗ ${fixture.file}\n  ${msg.split('\n').join('\n  ')}\n`);
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} fixture(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${FIXTURES.length} fixtures passed.\n`);
}

function runFixture(fixture: FixtureExpectation, source: string): void {
  const tree = parsePython(source);
  const root = tree.rootNode;
  const ctx = buildImportContext(root);

  // 1. Find the expected workflow class.
  const wfClassNode = findDecoratedClassByName(root, fixture.workflowClass);
  if (!wfClassNode) {
    throw new Error(`workflow class "${fixture.workflowClass}" not found`);
  }
  const wfInfo = recognizeWorkflowClass(wfClassNode, ctx);
  if (!wfInfo) {
    throw new Error(`@workflow.defn class "${fixture.workflowClass}" not recognized`);
  }

  // 2. Method-level decorators.
  const actualMethodDecs = Array.from(recognizeWorkflowMethods(wfInfo.classNode, ctx)).map(m => ({
    method: m.methodName,
    kind: m.decorator.primitive.kind,
    exposedName: m.exposedName,
  }));
  assertDeepEqual(
    actualMethodDecs,
    fixture.expectedMethodDecorators,
    'method-level decorators',
  );

  // 3. Calls in source order across the whole class body.
  const allCalls: RecognizedCall[] = Array.from(recognizeCallsIn(wfInfo.classNode, ctx));
  allCalls.sort((a, b) => a.line - b.line || a.callNode.startIndex - b.callNode.startIndex);
  const actualCalls = allCalls.map(c => ({
    qualifiedName: c.primitive.qualifiedName,
    targetName: c.targetName,
    awaited: c.awaited || undefined,
  })).map(stripUndefined);

  const expectedCalls = fixture.expectedCalls.map(stripUndefined);
  assertDeepEqual(actualCalls, expectedCalls, 'recognized calls');

  // 4. Except clauses.
  const exceptTypes: string[] = [];
  for (const except of allExceptClauses(wfInfo.classNode)) {
    const name = recognizeExceptType(except, ctx);
    if (name) { exceptTypes.push(name); }
  }
  assertDeepEqual(exceptTypes, fixture.expectedExceptTypes, 'temporal except clauses');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny assertion + traversal helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual, null, 2);
  const b = JSON.stringify(expected, null, 2);
  if (a !== b) {
    throw new Error(
      `${label} mismatch\n--- expected\n${b}\n--- actual\n${a}`,
    );
  }
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) { out[k] = v; }
  }
  return out as T;
}

import { Node } from 'web-tree-sitter';

function findDecoratedClassByName(root: Node, className: string): Node | null {
  for (const stmt of namedChildren(root)) {
    if (stmt.type !== PyNodeType.DecoratedDefinition) { continue; }
    const unwrapped = unwrapDecorated(stmt);
    if (!unwrapped) { continue; }
    if (unwrapped.definition.type !== PyNodeType.ClassDefinition) { continue; }
    if (unwrapped.definition.childForFieldName('name')?.text === className) {
      return stmt;
    }
  }
  return null;
}

function* allExceptClauses(node: Node): Generator<Node> {
  // Manual traversal — recognizer doesn't yet expose a structural walker.
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === PyNodeType.ExceptClause) { yield n; }
    for (const c of namedChildren(n)) { stack.push(c); }
  }
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
