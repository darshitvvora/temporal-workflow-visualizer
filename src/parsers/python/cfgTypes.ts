/**
 * Structured control-flow representation for a workflow method body.
 *
 * The CFG mirrors the source's structural shape (a tree, not a flattened
 * basic-block graph). This is deliberately chosen for visualization — we want
 * to render branches and loops *as* branches and loops, not as flattened
 * jumps. The optimizer-style basic-block CFG would lose information that the
 * diagram needs.
 *
 * Two layers of fidelity:
 *
 *  - **Structure** (this file): `FlowRegion` captures every Python control
 *    construct that affects flow — `if/elif/else`, `try/except/finally`,
 *    `for/while/with/match`, `return/raise`. Each branch body is itself a
 *    `FlowRegion`, so nesting works recursively.
 *
 *  - **Content** (FlowPrimitive): each leaf is a recognized Temporal SDK call.
 *    Plain statements (print, x=5) are omitted; only Temporal-relevant work
 *    becomes a leaf. This keeps the CFG focused on what the diagram needs to
 *    show.
 *
 * Diagram generation (a later step) consumes a FlowRegion and emits Mermaid.
 */

import { RecognizedCall } from './primitiveRecognizer';

// ─────────────────────────────────────────────────────────────────────────────
// Tagged union — discriminate on `kind`
// ─────────────────────────────────────────────────────────────────────────────

export type FlowRegion =
  | FlowSequence
  | FlowPrimitive
  | FlowIf
  | FlowTry
  | FlowFor
  | FlowWhile
  | FlowWith
  | FlowMatch
  | FlowReturn
  | FlowRaise;

/**
 * Linear sequence of regions. Empty sequences are legal — they mean a block
 * had no Temporal-relevant content. Diagram code may collapse them.
 */
export interface FlowSequence {
  kind: 'sequence';
  children: FlowRegion[];
  /** 1-based start line of the enclosing block. */
  line: number;
}

/**
 * A recognized Temporal call as a leaf.
 *
 * `parallelChildren` holds nested awaited calls discovered inside this call's
 * arguments — populated for parallel constructs (`asyncio.gather`,
 * `workflow.wait`, `asyncio.wait`). The diagram renders them as a fan-out
 * under this primitive.
 */
export interface FlowPrimitive {
  kind: 'primitive';
  recognized: RecognizedCall;
  line: number;
  parallelChildren?: FlowPrimitive[];
}

/**
 * `if cond: ... elif: ... else: ...`
 *
 * `branches` is in source order. The first entry is the `if`, subsequent are
 * `elif`s, and a final entry without `conditionText` represents `else`.
 */
export interface FlowIf {
  kind: 'if';
  branches: FlowBranch[];
  line: number;
}

export interface FlowBranch {
  /** Source text of the condition; undefined for the `else` branch. */
  conditionText?: string;
  body: FlowRegion;
  line: number;
}

/**
 * `try: ... except <T> [as e]: ... else: ... finally: ...`
 *
 * `excepts` is in source order. Each except clause carries its exception
 * type (resolved to a canonical Temporal name if possible) and bound name.
 */
export interface FlowTry {
  kind: 'try';
  body: FlowRegion;
  excepts: FlowExcept[];
  elseClause?: FlowRegion;
  finallyClause?: FlowRegion;
  line: number;
}

export interface FlowExcept {
  /**
   * Canonical Temporal exception name (e.g. `"ActivityError"`) when the
   * source-level type resolves to one. Undefined for non-Temporal types
   * (e.g. `except ValueError`, `except:`).
   */
  exceptionName?: string;
  /** Raw source text of the type expression — `"ActivityError"`, `"(A, B)"`, `""` for bare except. */
  rawType?: string;
  /** Optional bound name from `as e`. */
  asName?: string;
  body: FlowRegion;
  line: number;
}

/**
 * `for <target> in <iter>: ... else: ...`
 *
 * `isAsync` is true for `async for`. The else clause runs after a normal
 * loop termination (no break); it's rare in workflow code but legal.
 */
export interface FlowFor {
  kind: 'for';
  isAsync: boolean;
  targetText: string;
  iterableText: string;
  body: FlowRegion;
  elseClause?: FlowRegion;
  line: number;
}

/**
 * `while <cond>: ... else: ...`
 *
 * `isInfinite` is true for `while True:` / `while 1:` — these are common in
 * Temporal "agentic loop" patterns where the loop is exited via
 * `continue_as_new` or `return`. The diagram treats them specially.
 */
export interface FlowWhile {
  kind: 'while';
  conditionText: string;
  isInfinite: boolean;
  body: FlowRegion;
  elseClause?: FlowRegion;
  line: number;
}

/**
 * `with <ctx>: ...` / `async with <ctx>: ...`
 *
 * Rare in workflows, but legitimate for `workflow.unsafe.imports_passed_through()`
 * and other context managers.
 */
export interface FlowWith {
  kind: 'with';
  isAsync: boolean;
  contextText: string;
  body: FlowRegion;
  line: number;
}

/**
 * `match <subject>: case <pat>: ...`  (Python 3.10+)
 *
 * Each case is a branch. The CFG flattens pattern matching to a linear list
 * of branches keyed by `patternText`.
 */
export interface FlowMatch {
  kind: 'match';
  subjectText: string;
  cases: FlowMatchCase[];
  line: number;
}

export interface FlowMatchCase {
  patternText: string;
  /** Source text of the `if <guard>` clause, if present. */
  guardText?: string;
  body: FlowRegion;
  line: number;
}

/** Terminator: `return [<value>]`. */
export interface FlowReturn {
  kind: 'return';
  valueText?: string;
  line: number;
}

/**
 * Terminator: `raise [<exc>]`. `exceptionName` is filled in when the raised
 * expression resolves to a known Temporal exception class.
 */
export interface FlowRaise {
  kind: 'raise';
  exceptionName?: string;
  rawText?: string;
  line: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow-level CFG bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CFG of an entire workflow class. Each handler kind gets its own region.
 *
 *   - `run` — the `@workflow.run` method
 *   - `signals` / `queries` / `updates` — keyed by exposed name (the `name=`
 *      kwarg if present, else the Python method name)
 *   - `updateValidators` — keyed by the *paired update's* exposed name
 *
 * `name` is the Python class name. `defnLine` is the line of the
 * `@workflow.defn` decorator for click-to-navigate.
 */
export interface WorkflowCfg {
  name: string;
  defnLine: number;
  classBodyLine: number;
  run?: HandlerCfg;
  signals: Record<string, HandlerCfg>;
  queries: Record<string, HandlerCfg>;
  updates: Record<string, HandlerCfg>;
  updateValidators: Record<string, HandlerCfg>;
}

export interface HandlerCfg {
  /** Python method name. */
  methodName: string;
  /** Externally exposed name (kwarg or method name). */
  exposedName: string;
  /** 1-based line of the `def`/`async def`. */
  line: number;
  body: FlowRegion;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience constructors / introspection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten a FlowRegion into an in-source-order list of FlowPrimitives,
 * descending through all branches and loops. Used by tests and by the
 * eventual diagram-generation step that needs a stable enumeration.
 */
export function* flattenPrimitives(region: FlowRegion): Generator<FlowPrimitive> {
  switch (region.kind) {
    case 'primitive':
      yield region;
      if (region.parallelChildren) {
        for (const child of region.parallelChildren) { yield* flattenPrimitives(child); }
      }
      return;
    case 'sequence':
      for (const c of region.children) { yield* flattenPrimitives(c); }
      return;
    case 'if':
      for (const b of region.branches) { yield* flattenPrimitives(b.body); }
      return;
    case 'try':
      yield* flattenPrimitives(region.body);
      for (const ex of region.excepts) { yield* flattenPrimitives(ex.body); }
      if (region.elseClause) { yield* flattenPrimitives(region.elseClause); }
      if (region.finallyClause) { yield* flattenPrimitives(region.finallyClause); }
      return;
    case 'for':
    case 'while':
    case 'with':
      yield* flattenPrimitives(region.body);
      if (region.kind !== 'with' && region.elseClause) {
        yield* flattenPrimitives(region.elseClause);
      }
      return;
    case 'match':
      for (const c of region.cases) { yield* flattenPrimitives(c.body); }
      return;
    case 'return':
    case 'raise':
      return;
  }
}

/** True if a region carries no Temporal-relevant content. */
export function isEmptyRegion(region: FlowRegion): boolean {
  switch (region.kind) {
    case 'sequence':
      return region.children.every(isEmptyRegion);
    case 'return':
    case 'raise':
    case 'primitive':
      return false;
    default:
      return false;
  }
}
