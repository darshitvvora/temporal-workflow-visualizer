/**
 * Primitive recognizer — the bridge between the raw tree-sitter AST and the
 * Temporal SDK catalog.
 *
 * Given an AST node + an import context, the recognizer answers:
 *   - "Is this Call a Temporal primitive, and if so, which one?"
 *   - "Is this Decorator a Temporal decorator, and if so, what kind?"
 *   - "Is this except-clause type a Temporal exception?"
 *
 * It also exposes a higher-level scan over a function body that yields every
 * recognized primitive occurrence — the foundation the CFG builder (next
 * phase) will walk.
 *
 * IMPORTANT: this module is *only* responsible for recognition. It does NOT
 * emit WorkflowModel nodes. The recognizer's output is intentionally close to
 * the AST so the parser can decide how to render each occurrence (different
 * shape inside a loop, attach to error branch, etc.).
 */

import { Node } from 'web-tree-sitter';
import {
  PyNodeType,
  callTargetPath,
  callArgs,
  isAwaited,
  decoratorName,
  decoratorKwarg,
  lineOf,
  namedChildren,
  walk,
  stringLiteralValue,
  unwrapDecorated,
} from './astHelpers';
import {
  ImportContext,
  resolveAttributePath,
  isTemporalException,
} from './importContext';
import {
  SdkPrimitive,
  lookupPrimitive,
  PrimitiveKind,
} from './temporalSdk';

// ─────────────────────────────────────────────────────────────────────────────
// Recognition results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A recognized Temporal primitive call.
 *
 * `callNode` is the underlying `call` AST node (NOT the surrounding `await`).
 * `awaited` reflects whether the call appears as `await <call>(…)`.
 *
 * `targetName` is filled in when the primitive's catalog entry declares a
 * `targetNameArgIndex` and the recognizer can extract a meaningful name —
 * e.g. `"transfer_funds"` from `execute_activity(transfer_funds, …)`, or
 * `"GreetingWorkflow"` from `execute_child_workflow(GreetingWorkflow, …)`.
 *
 * `sourcePath` is the literal dotted path as it appeared in source — useful
 * for diagnostics ("we mapped `wf.sleep` to `workflow.sleep`").
 */
export interface RecognizedCall {
  primitive: SdkPrimitive;
  callNode: Node;
  sourcePath: string;
  awaited: boolean;
  /** 1-based line of the call. */
  line: number;
  /** Optional activity / child-workflow / signal name extracted from args. */
  targetName?: string;
  /** Raw keyword-argument map (preserves AST nodes for later option parsing). */
  kwargs: Map<string, Node>;
}

/**
 * A recognized Temporal decorator on a class or method.
 *
 * `name` is the decorator's external/exposed name. For `@workflow.signal(name="cancel")`
 * this is "cancel"; for `@workflow.signal` (bare) it falls back to the method name.
 * `kind` distinguishes signal / query / update / defn / run.
 */
export interface RecognizedDecorator {
  primitive: SdkPrimitive;
  decoratorNode: Node;
  /** 1-based line of the `@decorator` line. */
  line: number;
  /** Optional explicit `name=` kwarg value (without quotes). */
  explicitName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-node classifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to recognize a `call` AST node as a Temporal SDK primitive.
 * Returns null for non-Calls or for calls that don't resolve to a cataloged
 * primitive through the import context.
 */
export function recognizeCall(callNode: Node, ctx: ImportContext): RecognizedCall | null {
  if (callNode.type !== PyNodeType.Call) { return null; }
  const sourcePath = callTargetPath(callNode);
  if (!sourcePath) { return null; }

  const canonical = resolveAttributePath(ctx, sourcePath);
  if (!canonical) { return null; }

  const primitive = lookupPrimitive(canonical);
  if (!primitive) { return null; }

  const args = callArgs(callNode);
  const targetName = extractTargetName(primitive, args.positional);

  return {
    primitive,
    callNode,
    sourcePath,
    awaited: isAwaited(callNode),
    line: lineOf(callNode),
    targetName,
    kwargs: args.keyword,
  };
}

/**
 * Try to recognize a `decorator` AST node as a Temporal decorator.
 *
 * Returns null if the decorator's target is not in the catalog (e.g. an
 * unrelated `@dataclass` decorator).
 */
export function recognizeDecorator(decoratorNode: Node, ctx: ImportContext): RecognizedDecorator | null {
  if (decoratorNode.type !== PyNodeType.Decorator) { return null; }
  const sourcePath = decoratorName(decoratorNode);
  if (!sourcePath) { return null; }

  // `@workflow.update.validator` is a special compound name. Catalog entry is
  // synthesized here rather than expanded in the catalog to keep the catalog
  // table focused on primary primitives.
  if (sourcePath.endsWith('.validator')) {
    const head = sourcePath.slice(0, -'.validator'.length);
    const canonicalHead = resolveAttributePath(ctx, head);
    if (canonicalHead === 'workflow.update') {
      const updateValidator = lookupPrimitive('workflow.update'); // closest catalog match
      if (updateValidator) {
        return {
          primitive: {
            ...updateValidator,
            qualifiedName: 'workflow.update.validator',
            name: 'update.validator',
            kind: 'decorator-update-validator' as PrimitiveKind,
            description: 'Declare a validator for the paired @workflow.update handler',
          },
          decoratorNode,
          line: lineOf(decoratorNode),
        };
      }
    }
  }

  const canonical = resolveAttributePath(ctx, sourcePath);
  if (!canonical) { return null; }
  const primitive = lookupPrimitive(canonical);
  if (!primitive) { return null; }
  // Only return for primitives whose kind is actually a decorator.
  if (!isDecoratorKind(primitive.kind)) { return null; }

  return {
    primitive,
    decoratorNode,
    line: lineOf(decoratorNode),
    explicitName: readDecoratorNameKwarg(decoratorNode),
  };
}

/**
 * For an `except <type> [as <var>]:` clause, returns the canonical exception
 * type name if it's a Temporal exception, otherwise undefined.
 *
 * The grammar represents except like:
 *   except_clause → "except" (expression ("as" identifier)?)? ":" block
 *
 * For `except ActivityError as e`, this returns "ActivityError".
 * For `except (ActivityError, TimeoutError) as e`, this returns "ActivityError"
 * (the first; the parser is free to inspect further if needed).
 * For a bare `except:` or non-Temporal types, returns undefined.
 */
export function recognizeExceptType(exceptClauseNode: Node, ctx: ImportContext): string | undefined {
  if (exceptClauseNode.type !== PyNodeType.ExceptClause) { return undefined; }

  // The first named child is the type expression (an identifier, attribute,
  // tuple, or `as` pattern). Anything else (block, identifier of bound name)
  // comes later.
  const children = namedChildren(exceptClauseNode);
  if (children.length === 0) { return undefined; }
  const typeExpr = children[0];

  // Simple cases: identifier or attribute.
  const typeName = textOfDotted(typeExpr);
  if (typeName) {
    const canonical = canonicalExceptionName(ctx, typeName);
    if (canonical) { return canonical; }
  }

  // Tuple: `except (A, B, C):` — inspect the first element.
  if (typeExpr.type === 'tuple' || typeExpr.type === 'parenthesized_expression') {
    for (const sub of namedChildren(typeExpr)) {
      const subName = textOfDotted(sub);
      if (!subName) { continue; }
      const canonical = canonicalExceptionName(ctx, subName);
      if (canonical) { return canonical; }
    }
  }

  return undefined;
}

/**
 * Resolve an `except` clause's source-level type name to the canonical
 * Temporal exception class name, if any. Returns undefined for non-Temporal
 * types.
 *
 * Handles:
 *   except ActivityError:          → "ActivityError" (bare import or direct)
 *   except AE:                     → "ActivityError" (after `import ... as AE`)
 *   except exceptions.ActivityError → "ActivityError" (qualified via aliased module)
 */
function canonicalExceptionName(ctx: ImportContext, source: string): string | undefined {
  // Case A: bare alias from `from temporalio.exceptions import X as Y`
  const aliased = ctx.exceptionAliases.get(source);
  if (aliased) { return aliased; }

  // Case B: bare name that happens to match a catalog exception
  if (isTemporalException(ctx, source)) {
    const last = source.split('.').pop();
    return last;
  }

  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk scanners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk an AST subtree and yield every recognized Temporal call. Use this when
 * you want a flat enumeration of primitives inside a function/method body.
 *
 * The yield order is pre-order (matches source order). The caller is
 * responsible for any control-flow grouping (loops, branches, error paths) —
 * the recognizer intentionally does not impose structure on the results.
 */
export function* recognizeCallsIn(root: Node, ctx: ImportContext): Generator<RecognizedCall> {
  for (const n of walk(root)) {
    if (n.type !== PyNodeType.Call) { continue; }
    // Skip the call that constitutes the decorator expression itself —
    // `@workflow.signal(name="x")` parses to a Call whose parent is the
    // Decorator node. That's structural metadata, not a flow step.
    if (n.parent && n.parent.type === PyNodeType.Decorator) { continue; }
    const recognized = recognizeCall(n, ctx);
    if (recognized) { yield recognized; }
  }
}

/**
 * For a class node, return its workflow decorators if any. Useful for finding
 * the `@workflow.defn` class and inspecting its method decorators.
 *
 * Returns null if the class is not a `decorated_definition` wrapping a class,
 * or if no Temporal decorator is found.
 */
export interface WorkflowClassInfo {
  classNode: Node;
  defnDecorator: RecognizedDecorator;
  /** All other Temporal decorators that appeared on the class. */
  otherDecorators: RecognizedDecorator[];
}

export function recognizeWorkflowClass(
  decoratedOrClassNode: Node,
  ctx: ImportContext,
): WorkflowClassInfo | null {
  const unwrapped = unwrapDecorated(decoratedOrClassNode);
  if (!unwrapped) { return null; }
  if (unwrapped.definition.type !== PyNodeType.ClassDefinition) { return null; }

  let defnDecorator: RecognizedDecorator | null = null;
  const others: RecognizedDecorator[] = [];

  for (const decNode of decoratorsOf(decoratedOrClassNode)) {
    const r = recognizeDecorator(decNode, ctx);
    if (!r) { continue; }
    if (r.primitive.kind === 'decorator-workflow-defn') {
      defnDecorator = r;
    } else {
      others.push(r);
    }
  }
  if (!defnDecorator) { return null; }

  return {
    classNode: unwrapped.definition,
    defnDecorator,
    otherDecorators: others,
  };
}

/**
 * For each method on a workflow class, return its recognized handler/run/init
 * decorator (if any) plus the underlying function-definition node. Methods
 * with no Temporal decorator are skipped.
 */
export interface WorkflowMethodInfo {
  methodNode: Node;                // the function_definition
  methodName: string;
  decorator: RecognizedDecorator;  // workflow.run | signal | query | update | init | dynamic_config
  /** External signal/query/update name (the kwarg value or the method name). */
  exposedName: string;
}

export function* recognizeWorkflowMethods(
  classNode: Node,
  ctx: ImportContext,
): Generator<WorkflowMethodInfo> {
  const body = classNode.childForFieldName('body');
  if (!body) { return; }

  // First pass: collect @workflow.update method names. Validator decorators
  // are written as `@<update_method_name>.validator`, which has no Temporal-
  // module prefix to anchor against — we can only recognize them by knowing
  // the update method exists.
  const updateMethodNames = new Set<string>();
  for (const stmt of namedChildren(body)) {
    if (stmt.type !== PyNodeType.DecoratedDefinition) { continue; }
    const unwrapped = unwrapDecorated(stmt);
    if (!unwrapped || unwrapped.definition.type !== PyNodeType.FunctionDefinition) { continue; }
    const methodName = unwrapped.definition.childForFieldName('name')?.text;
    if (!methodName) { continue; }
    for (const decNode of decoratorsOf(stmt)) {
      const r = recognizeDecorator(decNode, ctx);
      if (r?.primitive.kind === 'decorator-update-handler') {
        updateMethodNames.add(methodName);
      }
    }
  }

  // Second pass: emit method infos, including validators recognized by the
  // method name table built above.
  for (const stmt of namedChildren(body)) {
    if (stmt.type !== PyNodeType.DecoratedDefinition) { continue; }
    const unwrapped = unwrapDecorated(stmt);
    if (!unwrapped) { continue; }
    if (unwrapped.definition.type !== PyNodeType.FunctionDefinition) { continue; }

    const methodName = unwrapped.definition.childForFieldName('name')?.text;
    if (!methodName) { continue; }

    for (const decNode of decoratorsOf(stmt)) {
      const r =
        recognizeDecorator(decNode, ctx) ??
        recognizeUpdateValidator(decNode, updateMethodNames);
      if (!r) { continue; }
      if (!isMethodLevelDecoratorKind(r.primitive.kind)) { continue; }
      yield {
        methodNode: unwrapped.definition,
        methodName,
        decorator: r,
        exposedName: r.explicitName ?? methodName,
      };
    }
  }
}

/**
 * Recognize `@<update_method>.validator` where `<update_method>` is a method
 * previously decorated with `@workflow.update` on the same class.
 *
 * The decorator has no Temporal-module prefix (the prefix is a method name on
 * the same class), so this can only be recognized contextually.
 */
function recognizeUpdateValidator(
  decoratorNode: Node,
  updateMethodNames: Set<string>,
): RecognizedDecorator | null {
  if (decoratorNode.type !== PyNodeType.Decorator) { return null; }
  const sourcePath = decoratorName(decoratorNode);
  if (!sourcePath || !sourcePath.endsWith('.validator')) { return null; }
  const head = sourcePath.slice(0, -'.validator'.length);
  if (!updateMethodNames.has(head)) { return null; }

  // Synthesize a catalog entry for the validator. It mirrors the update
  // decorator but carries the validator kind.
  const updatePrim = lookupPrimitive('workflow.update')!;
  return {
    primitive: {
      ...updatePrim,
      qualifiedName: 'workflow.update.validator',
      name: 'update.validator',
      kind: 'decorator-update-validator',
      description: 'Declare a validator for the paired @workflow.update handler',
    },
    decoratorNode,
    line: lineOf(decoratorNode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function isDecoratorKind(kind: PrimitiveKind): boolean {
  return (
    kind === 'decorator-workflow-defn' ||
    kind === 'decorator-workflow-run' ||
    kind === 'decorator-signal-handler' ||
    kind === 'decorator-query-handler' ||
    kind === 'decorator-update-handler' ||
    kind === 'decorator-update-validator' ||
    kind === 'decorator-workflow-init' ||
    kind === 'decorator-dynamic-config' ||
    kind === 'decorator-activity-defn'
  );
}

function isMethodLevelDecoratorKind(kind: PrimitiveKind): boolean {
  return (
    kind === 'decorator-workflow-run' ||
    kind === 'decorator-signal-handler' ||
    kind === 'decorator-query-handler' ||
    kind === 'decorator-update-handler' ||
    kind === 'decorator-update-validator' ||
    kind === 'decorator-workflow-init' ||
    kind === 'decorator-dynamic-config'
  );
}

/**
 * Yield each `decorator` AST node from a `decorated_definition`.
 * Returns empty if the node is not a decorated definition.
 */
function* decoratorsOf(node: Node): Generator<Node> {
  if (node.type !== PyNodeType.DecoratedDefinition) { return; }
  for (const child of namedChildren(node)) {
    if (child.type === PyNodeType.Decorator) { yield child; }
  }
}

/**
 * Pull the `name="..."` kwarg from a decorator call, if present, as a clean string.
 */
function readDecoratorNameKwarg(decoratorNode: Node): string | undefined {
  const raw = decoratorKwarg(decoratorNode, 'name');
  if (!raw) { return undefined; }
  // raw includes the quotes; strip them if it's a simple literal.
  if (raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Render an attribute path node back to its dotted text iff it's pure
 * identifier/attribute (no calls, no subscripts). Different from
 * `attributePath` only in that it accepts ad-hoc node types we might find
 * inside `except` (the type expression there might be a `dotted_name` rather
 * than an attribute chain).
 */
function textOfDotted(node: Node): string | null {
  if (node.type === PyNodeType.Identifier || node.type === PyNodeType.DottedName) {
    return node.text;
  }
  if (node.type === PyNodeType.Attribute) {
    // Reuse callTargetPath's recursive helper indirectly by calling text — it
    // happens to produce the right thing for pure attribute chains.
    return node.text;
  }
  return null;
}

/**
 * Extract the target name (activity / child workflow) for primitives that
 * declare `targetNameArgIndex`. Handles:
 *   - String literal: execute_activity("transfer_funds", …)
 *   - Identifier reference: execute_activity(transfer_funds, …)
 *   - Attribute: execute_activity(my_module.transfer_funds, …)
 *   - Class reference: execute_child_workflow(GreetingWorkflow, …)
 *     (the class name shows up as an Identifier, identical handling)
 *
 * Returns undefined when the primitive doesn't declare a target arg or the
 * argument is too complex to summarize.
 */
function extractTargetName(primitive: SdkPrimitive, positional: Node[]): string | undefined {
  const idx = primitive.targetNameArgIndex;
  if (idx === undefined) { return undefined; }
  if (idx >= positional.length) { return undefined; }
  const arg = positional[idx];

  if (arg.type === PyNodeType.String) {
    return stringLiteralValue(arg);
  }
  if (arg.type === PyNodeType.Identifier) {
    return arg.text;
  }
  if (arg.type === PyNodeType.Attribute) {
    // `MyClass.method` form for `execute_activity_method`. Use the last segment.
    return arg.text.split('.').pop();
  }
  return undefined;
}
