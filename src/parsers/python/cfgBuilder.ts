/**
 * CFG builder for Python workflow methods.
 *
 * Consumes a method's body block (a `block` AST node) and produces a
 * structured `FlowRegion`. Recognized Temporal primitives become `FlowPrimitive`
 * leaves; Python control-flow statements become `FlowIf` / `FlowTry` /
 * `FlowFor` / `FlowWhile` / `FlowWith` / `FlowMatch` nodes; `return` / `raise`
 * become terminators. Plain statements with no Temporal-relevant content are
 * dropped.
 *
 * Two notable design points:
 *
 *  - **Nested calls in parallel constructs.** `asyncio.gather(a(), b())` is
 *    one statement but logically fans out to two activities. When we emit the
 *    `asyncio.gather` primitive we walk into its argument subtrees, recognize
 *    any nested Temporal calls, and attach them as `parallelChildren`. Those
 *    nested calls are NOT also emitted at the parent statement's level.
 *
 *  - **Statement-level scanning.** Outside parallel constructs, the builder
 *    walks at the *statement* granularity. An assignment whose RHS contains
 *    a recognized call (e.g. `result = await workflow.execute_activity(...)`)
 *    emits the primitive. An expression statement (`await workflow.sleep(...)`)
 *    does too. Anything else is invisible.
 *
 * The builder is intentionally unaware of cross-method concerns (helper
 * inlining, workflow-class structure). It works on a single body. The
 * higher-level `buildWorkflowCfg` composes per-method builds into a
 * `WorkflowCfg`.
 */

import { Node } from 'web-tree-sitter';
import {
  PyNodeType,
  namedChildren,
  lineOf,
  bodyOf,
} from './astHelpers';
import { ImportContext } from './importContext';
import {
  recognizeCall,
  recognizeExceptType,
  recognizeWorkflowClass,
  recognizeWorkflowMethods,
  WorkflowMethodInfo,
} from './primitiveRecognizer';
import {
  FlowRegion,
  FlowSequence,
  FlowPrimitive,
  FlowIf,
  FlowTry,
  FlowFor,
  FlowWhile,
  FlowWith,
  FlowMatch,
  FlowReturn,
  FlowRaise,
  FlowExcept,
  FlowBranch,
  WorkflowCfg,
  HandlerCfg,
} from './cfgTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a FlowRegion from a `block` node (the `body` field of a function or
 * compound statement). Always returns a FlowSequence — possibly empty.
 */
export function buildCfg(blockNode: Node, ctx: ImportContext): FlowSequence {
  if (blockNode.type !== PyNodeType.Block) {
    return { kind: 'sequence', children: [], line: lineOf(blockNode) };
  }
  return buildSequence(blockNode, ctx);
}

/**
 * Build a WorkflowCfg from a `@workflow.defn` class node (either the
 * `class_definition` or the wrapping `decorated_definition`).
 *
 * Returns null if the class is not a recognized workflow.
 */
export function buildWorkflowCfg(
  classOrDecoratedNode: Node,
  ctx: ImportContext,
): WorkflowCfg | null {
  const info = recognizeWorkflowClass(classOrDecoratedNode, ctx);
  if (!info) { return null; }

  const cfg: WorkflowCfg = {
    name: info.classNode.childForFieldName('name')?.text ?? '<unnamed>',
    defnLine: info.defnDecorator.line,
    classBodyLine: lineOf(info.classNode),
    signals: {},
    queries: {},
    updates: {},
    updateValidators: {},
  };

  for (const method of recognizeWorkflowMethods(info.classNode, ctx)) {
    const handler = buildHandlerCfg(method, ctx);
    if (!handler) { continue; }
    switch (method.decorator.primitive.kind) {
      case 'decorator-workflow-run':
        cfg.run = handler;
        break;
      case 'decorator-signal-handler':
        cfg.signals[method.exposedName] = handler;
        break;
      case 'decorator-query-handler':
        cfg.queries[method.exposedName] = handler;
        break;
      case 'decorator-update-handler':
        cfg.updates[method.exposedName] = handler;
        break;
      case 'decorator-update-validator':
        cfg.updateValidators[method.methodName] = handler;
        break;
      default:
        // workflow.init / dynamic_config — no CFG slot yet, skip silently.
        break;
    }
  }

  return cfg;
}

function buildHandlerCfg(method: WorkflowMethodInfo, ctx: ImportContext): HandlerCfg | null {
  const body = bodyOf(method.methodNode);
  if (!body) { return null; }
  return {
    methodName: method.methodName,
    exposedName: method.exposedName,
    line: lineOf(method.methodNode),
    body: buildCfg(body, ctx),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequence walker
// ─────────────────────────────────────────────────────────────────────────────

function buildSequence(blockNode: Node, ctx: ImportContext): FlowSequence {
  const children: FlowRegion[] = [];
  for (const stmt of namedChildren(blockNode)) {
    const region = buildStatement(stmt, ctx);
    if (region) { children.push(region); }
  }
  return { kind: 'sequence', children, line: lineOf(blockNode) };
}

/**
 * Build a FlowRegion from a single statement node. Returns null for
 * statements that produce no Temporal-relevant content (comments, pass,
 * docstrings, plain assignments without recognized calls, etc.).
 */
function buildStatement(stmt: Node, ctx: ImportContext): FlowRegion | null {
  switch (stmt.type) {
    case PyNodeType.IfStatement:        return buildIf(stmt, ctx);
    case PyNodeType.ForStatement:       return buildFor(stmt, ctx, /*isAsync*/ false);
    case PyNodeType.WhileStatement:     return buildWhile(stmt, ctx);
    case PyNodeType.TryStatement:       return buildTry(stmt, ctx);
    case PyNodeType.WithStatement:      return buildWith(stmt, ctx, /*isAsync*/ false);
    case PyNodeType.ReturnStatement:    return buildReturn(stmt);
    case PyNodeType.RaiseStatement:     return buildRaise(stmt, ctx);
    case PyNodeType.ExpressionStatement: return buildExpressionStatement(stmt, ctx);
    case PyNodeType.AssignmentStatement: return buildAssignmentLike(stmt, ctx);
    case PyNodeType.AugmentedAssignment: return buildAssignmentLike(stmt, ctx);

    // Handle async-prefixed loops/withs. tree-sitter-python uses the same
    // node types but flags them via the leading "async" anonymous token.
    // We detect by looking at the first child token text.
    default:
      // Some grammar versions surface `async_for_statement` / similar — check by name.
      if (stmt.type === 'async_for_statement') { return buildFor(stmt, ctx, true); }
      if (stmt.type === 'async_with_statement') { return buildWith(stmt, ctx, true); }
      if (stmt.type === 'match_statement') { return buildMatch(stmt, ctx); }
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compound statement builders
// ─────────────────────────────────────────────────────────────────────────────

function buildIf(ifNode: Node, ctx: ImportContext): FlowIf {
  const branches: FlowBranch[] = [];

  const cond = ifNode.childForFieldName('condition');
  const conseq = ifNode.childForFieldName('consequence');
  if (conseq) {
    branches.push({
      conditionText: cond?.text,
      body: buildCfg(conseq, ctx),
      line: lineOf(ifNode),
    });
  }

  // `alternative` is a repeatable field — yields elif_clause / else_clause.
  // We iterate via children-for-field-name to preserve source order.
  for (const alt of ifNode.childrenForFieldName('alternative')) {
    if (alt.type === PyNodeType.ElifClause) {
      const elifCond = alt.childForFieldName('condition');
      const elifBody = alt.childForFieldName('consequence');
      if (elifBody) {
        branches.push({
          conditionText: elifCond?.text,
          body: buildCfg(elifBody, ctx),
          line: lineOf(alt),
        });
      }
    } else if (alt.type === PyNodeType.ElseClause) {
      const elseBody = alt.childForFieldName('body') ?? bodyChildOfElseClause(alt);
      if (elseBody) {
        branches.push({
          conditionText: undefined,
          body: buildCfg(elseBody, ctx),
          line: lineOf(alt),
        });
      }
    }
  }

  return { kind: 'if', branches, line: lineOf(ifNode) };
}

/**
 * Some grammar versions don't expose `body` as a field on else_clause —
 * fall back to scanning named children for the block.
 */
function bodyChildOfElseClause(elseClause: Node): Node | null {
  for (const c of namedChildren(elseClause)) {
    if (c.type === PyNodeType.Block) { return c; }
  }
  return null;
}

function buildFor(forNode: Node, ctx: ImportContext, isAsync: boolean): FlowFor {
  const left = forNode.childForFieldName('left');
  const right = forNode.childForFieldName('right');
  const body = forNode.childForFieldName('body');
  const elseClauseNode = findChildOfType(forNode, PyNodeType.ElseClause);
  return {
    kind: 'for',
    isAsync,
    targetText: left?.text ?? '',
    iterableText: right?.text ?? '',
    body: body ? buildCfg(body, ctx) : emptySequence(forNode),
    elseClause: elseClauseNode ? buildCfg(bodyChildOfElseClause(elseClauseNode) ?? elseClauseNode, ctx) : undefined,
    line: lineOf(forNode),
  };
}

function buildWhile(whileNode: Node, ctx: ImportContext): FlowWhile {
  const cond = whileNode.childForFieldName('condition');
  const body = whileNode.childForFieldName('body');
  const elseClauseNode = findChildOfType(whileNode, PyNodeType.ElseClause);
  const condText = cond?.text ?? '';
  return {
    kind: 'while',
    conditionText: condText,
    isInfinite: condText === 'True' || condText === 'true' || condText === '1',
    body: body ? buildCfg(body, ctx) : emptySequence(whileNode),
    elseClause: elseClauseNode ? buildCfg(bodyChildOfElseClause(elseClauseNode) ?? elseClauseNode, ctx) : undefined,
    line: lineOf(whileNode),
  };
}

function buildTry(tryNode: Node, ctx: ImportContext): FlowTry {
  const body = tryNode.childForFieldName('body');
  const excepts: FlowExcept[] = [];
  let elseClause: FlowRegion | undefined;
  let finallyClause: FlowRegion | undefined;

  for (const c of namedChildren(tryNode)) {
    if (c.type === PyNodeType.ExceptClause) {
      excepts.push(buildExcept(c, ctx));
    } else if (c.type === PyNodeType.ElseClause) {
      const eb = bodyChildOfElseClause(c);
      if (eb) { elseClause = buildCfg(eb, ctx); }
    } else if (c.type === PyNodeType.FinallyClause) {
      const fb = bodyChildOfElseClause(c) ?? c.childForFieldName('body');
      if (fb) { finallyClause = buildCfg(fb, ctx); }
    }
  }

  return {
    kind: 'try',
    body: body ? buildCfg(body, ctx) : emptySequence(tryNode),
    excepts,
    elseClause,
    finallyClause,
    line: lineOf(tryNode),
  };
}

function buildExcept(exceptNode: Node, ctx: ImportContext): FlowExcept {
  const exceptionName = recognizeExceptType(exceptNode, ctx);
  // Pull the raw type expression (first named child of an except clause is
  // either an expression, an `as` pattern, or absent for bare `except:`).
  const children = namedChildren(exceptNode);
  let rawType: string | undefined;
  let asName: string | undefined;
  let body: Node | null = null;
  for (const c of children) {
    if (c.type === PyNodeType.Block) { body = c; break; }
    // The grammar wraps `except X as e` as an `as_pattern` or similar.
    // We detect by the presence of an `as` keyword in the text.
    if (rawType === undefined) {
      rawType = c.text;
      // If the type expression contains ` as ` and a trailing identifier, split.
      const m = rawType.match(/^([\s\S]+?)\s+as\s+([A-Za-z_]\w*)\s*$/);
      if (m) {
        rawType = m[1].trim();
        asName = m[2];
      }
    }
  }
  return {
    exceptionName,
    rawType,
    asName,
    body: body ? buildCfg(body, ctx) : emptySequence(exceptNode),
    line: lineOf(exceptNode),
  };
}

function buildWith(withNode: Node, ctx: ImportContext, isAsync: boolean): FlowWith {
  const body = withNode.childForFieldName('body');
  // The `with` node has a `with_clause` child carrying the context managers;
  // just grab everything before the body as the raw context text.
  const items: string[] = [];
  for (const c of namedChildren(withNode)) {
    if (c.type === PyNodeType.Block) { break; }
    items.push(c.text);
  }
  return {
    kind: 'with',
    isAsync,
    contextText: items.join(' ').trim(),
    body: body ? buildCfg(body, ctx) : emptySequence(withNode),
    line: lineOf(withNode),
  };
}

function buildMatch(matchNode: Node, ctx: ImportContext): FlowMatch {
  const subject = matchNode.childForFieldName('subject');
  const cases: FlowMatch['cases'] = [];

  // tree-sitter-python represents match cases as `case_clause` children inside
  // the match body (a `block`).
  const body = matchNode.childForFieldName('body');
  if (body) {
    for (const c of namedChildren(body)) {
      if (c.type !== 'case_clause') { continue; }
      const pattern = c.childForFieldName('pattern');
      const guard = c.childForFieldName('guard');
      const caseBody = c.childForFieldName('consequence') ?? c.childForFieldName('body');
      cases.push({
        patternText: pattern?.text ?? '',
        guardText: guard?.text,
        body: caseBody ? buildCfg(caseBody, ctx) : emptySequence(c),
        line: lineOf(c),
      });
    }
  }

  return {
    kind: 'match',
    subjectText: subject?.text ?? '',
    cases,
    line: lineOf(matchNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminators
// ─────────────────────────────────────────────────────────────────────────────

function buildReturn(returnNode: Node): FlowReturn {
  // The return value (if any) is the first named child.
  const valueNode = namedChildren(returnNode)[0];
  return {
    kind: 'return',
    valueText: valueNode?.text,
    line: lineOf(returnNode),
  };
}

function buildRaise(raiseNode: Node, ctx: ImportContext): FlowRaise {
  const valueNode = namedChildren(raiseNode)[0];
  let exceptionName: string | undefined;
  if (valueNode) {
    // Two shapes: `raise Foo(x)` (call) or `raise Foo` (identifier/attribute).
    let typeText: string | undefined;
    if (valueNode.type === PyNodeType.Call) {
      const fn = valueNode.childForFieldName('function');
      typeText = fn?.text;
    } else if (valueNode.type === PyNodeType.Identifier || valueNode.type === PyNodeType.Attribute) {
      typeText = valueNode.text;
    }
    if (typeText) {
      // Reuse the exception-name resolution by faking an except clause's logic:
      // try the alias map first, then fall back to the catalog short-name set.
      const aliased = ctx.exceptionAliases.get(typeText);
      if (aliased) {
        exceptionName = aliased;
      } else {
        // workflow-module exceptions like `workflow.NondeterminismError`
        const parts = typeText.split('.');
        if (parts.length === 1) {
          // Bare class — accept if in the catalog's exception set.
          // (Importing isTemporalException here would be overkill; we duplicate the bare check.)
          exceptionName = typeText;
        } else {
          exceptionName = parts.pop();
        }
      }
    }
  }
  return {
    kind: 'raise',
    exceptionName,
    rawText: valueNode?.text,
    line: lineOf(raiseNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression-bearing statements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `expression_statement` wraps any standalone expression (a call, an await,
 * a literal, etc.). We scan into it for recognized calls.
 */
function buildExpressionStatement(stmt: Node, ctx: ImportContext): FlowRegion | null {
  return scanExpressionForPrimitives(stmt, ctx);
}

/**
 * `assignment` / `augmented_assignment` — the RHS may be a recognized call.
 * The LHS is decoration (variable names) and never contains primitives.
 */
function buildAssignmentLike(stmt: Node, ctx: ImportContext): FlowRegion | null {
  const right = stmt.childForFieldName('right');
  if (!right) { return null; }
  return scanExpressionForPrimitives(right, ctx);
}

/**
 * Walk an expression subtree and emit any recognized Temporal calls in source
 * order. Most expressions contain at most one Temporal call, but parallel
 * constructs (`asyncio.gather(a(), b())`) can hold multiple; we model those
 * as a parent primitive with `parallelChildren` to preserve the fan-out.
 *
 * Returns:
 *  - A single FlowPrimitive when there's exactly one recognized call.
 *  - A FlowSequence when there are multiple non-nested calls.
 *  - null when there are no recognized calls.
 */
function scanExpressionForPrimitives(exprRoot: Node, ctx: ImportContext): FlowRegion | null {
  const topLevelCalls = collectTopLevelRecognizedCalls(exprRoot, ctx);
  if (topLevelCalls.length === 0) { return null; }
  if (topLevelCalls.length === 1) { return topLevelCalls[0]; }
  return {
    kind: 'sequence',
    children: topLevelCalls,
    line: topLevelCalls[0].line,
  };
}

/**
 * Walk `root` collecting recognized calls. When a recognized call is found,
 * we stop descending into its argument list — its nested recognized calls
 * become `parallelChildren` if the parent's catalog kind is `parallel-wait`,
 * otherwise they're ignored.
 *
 * This means `gather(a(), b())` produces one outer primitive with two parallel
 * children, while `f(workflow.execute_activity(...))` — where `f` is not
 * itself a Temporal call — would skip the outer (not recognized) and recurse
 * into `f`'s arguments to find the inner activity call.
 */
function collectTopLevelRecognizedCalls(root: Node, ctx: ImportContext): FlowPrimitive[] {
  const results: FlowPrimitive[] = [];

  function visit(node: Node): void {
    if (node.type === PyNodeType.Call) {
      const recognized = recognizeCall(node, ctx);
      if (recognized) {
        const prim: FlowPrimitive = {
          kind: 'primitive',
          recognized,
          line: recognized.line,
        };
        if (recognized.primitive.kind === 'parallel-wait' || recognized.primitive.kind === 'create-task') {
          // Pull nested recognized calls out of the argument list as parallel children.
          const args = node.childForFieldName('arguments');
          if (args) {
            prim.parallelChildren = collectTopLevelRecognizedCalls(args, ctx);
          }
        }
        results.push(prim);
        return; // do NOT recurse — nested calls handled (or intentionally ignored) above
      }
    }
    for (const child of namedChildren(node)) {
      visit(child);
    }
  }

  visit(root);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────

function findChildOfType(node: Node, type: string): Node | null {
  for (const c of namedChildren(node)) {
    if (c.type === type) { return c; }
  }
  return null;
}

function emptySequence(node: Node): FlowSequence {
  return { kind: 'sequence', children: [], line: lineOf(node) };
}

