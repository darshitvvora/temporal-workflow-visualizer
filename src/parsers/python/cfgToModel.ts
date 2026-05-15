/**
 * Translator: WorkflowCfg → WorkflowModel.
 *
 * The CFG (cfgTypes.ts) is the rich, structured representation we *want*. The
 * WorkflowModel (../../types.ts) is the flat representation the existing
 * diagramGenerator + webviewPanel know how to render. This module is the
 * bridge — it walks the CFG and emits a WorkflowModel that preserves as much
 * structure as the existing renderer can express.
 *
 * What the renderer can express today:
 *
 *   - Linear sequence of `WorkflowNode`s sorted by `line`
 *   - `branches` on a node → renders as fan-out → fan-in (if/elif/else)
 *   - `errorBranches` on a node → renders as `{ok?}` decision with catch path
 *   - `kind: 'loop'` + `loopRegions[]` mapping → renders body inside loop with back-edge
 *   - `role: 'signal-handler' | 'query-handler'` → renders in side subgraph
 *   - `loopAnchorId` + `hasLoopExit` → agentic-loop pattern (`while True:`
 *     around `wait_condition`, exited via `continue_as_new`)
 *
 * What we deliberately drop (renderer can't show it yet, scoped for later):
 *
 *   - `return` / `raise` terminators — implicit in flow
 *   - `with` / `async with` body decoration
 *   - `match` / `case` (treated as a generic if-ladder for now)
 *   - Parallel children of gather/wait beyond a flat sibling expansion
 *
 * The translator is intentionally not "clever" about diagram quality — it
 * produces a faithful, conservative model. Polishing the diagram (collapsing
 * single-branch ifs, rendering parallel fan-outs as subgraphs, etc.) is the
 * renderer's responsibility in a later step.
 */

import { Node } from 'web-tree-sitter';
import {
  ActivityOptions,
  ErrorBranch,
  LoopRegion,
  NodeKind,
  NodeRole,
  RetryPolicy,
  WorkflowModel,
  WorkflowNode,
} from '../../types';

import {
  FlowBranch,
  FlowExcept,
  FlowPrimitive,
  FlowRegion,
  HandlerCfg,
  WorkflowCfg,
} from './cfgTypes';
import { PrimitiveKind, SdkPrimitive } from './temporalSdk';
import { RecognizedCall } from './primitiveRecognizer';

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

export interface TranslateOpts {
  filePath: string;
  /** Full source text — used to resolve `retry_policy=NAME` references back to RetryPolicy(…) literals. */
  source: string;
}

export function cfgToWorkflowModel(cfg: WorkflowCfg, opts: TranslateOpts): WorkflowModel {
  const ctx = new TranslateCtx(opts.source);

  // ── Run handler — the main flow ─────────────────────────────────────────
  if (cfg.run) {
    visitRegion(cfg.run.body, ctx, /* tryStack */ []);
  }

  // ── Signal/Query/Update handlers — emitted as side nodes ────────────────
  for (const [name, handler] of Object.entries(cfg.signals)) {
    emitHandlerSideNode(ctx, handler, name, 'signal', 'signal-handler');
  }
  for (const [name, handler] of Object.entries(cfg.updates)) {
    // Updates are visually grouped with signals in the current renderer.
    emitHandlerSideNode(ctx, handler, name, 'signal', 'signal-handler', /* suffix */ ' (update)');
  }
  for (const [name, handler] of Object.entries(cfg.queries)) {
    emitHandlerSideNode(ctx, handler, name, 'query', 'query-handler');
  }
  // Update validators don't render today (no UI surface for them); we still
  // include them in tooltips on the paired update by post-processing below.
  // For Stage 3 we just skip emission — paired with the update node is a
  // future enhancement.

  // ── Sort by line so the renderer reads left-to-right top-to-bottom ──────
  ctx.nodes.sort((a, b) => a.line - b.line);

  // ── Agentic-loop detection ──────────────────────────────────────────────
  // `loopAnchorId` triggers the renderer's loop layout (back-edge + optional
  // "exits" arrow). We set it only when there's a real `while True:` wrapping
  // a `wait_condition` — the agentic-loop pattern. The CFG visitor logs
  // that primitive's id in ctx.loopAnchorPrimitiveId.
  const loopAnchorId = ctx.loopAnchorPrimitiveId;
  const hasLoopExit = loopAnchorId
    ? ctx.nodes.some(
        n => n.role !== 'signal-handler' && n.role !== 'query-handler' &&
             n.line > (ctx.nodes.find(x => x.id === loopAnchorId)?.line ?? -1) &&
             n.id.startsWith('can_'),
      )
    : false;

  // Signal-target heuristic (independent of loop rendering):
  // If the workflow has signal/update handlers AND a wait_condition primitive
  // somewhere in the run body, the handlers' "triggers" arrows should point
  // at that wait — that's where the workflow is suspended waiting for the
  // signal-mutated state to satisfy the predicate. Without this, the renderer
  // points handler arrows at START, which suggests signals arrive before the
  // workflow starts (semantically misleading).
  //
  // This is distinct from `loopAnchorId`: it does NOT change the flow layout.
  const hasSignalLikeHandlers =
    Object.keys(cfg.signals).length > 0 || Object.keys(cfg.updates).length > 0;
  let signalTargetId: string | undefined;
  if (loopAnchorId) {
    signalTargetId = loopAnchorId; // loop anchor wins
  } else if (hasSignalLikeHandlers) {
    const firstWait = ctx.nodes.find(
      n => (n.role === 'flow' || !n.role) && n.id.startsWith('wait_cond_'),
    );
    if (firstWait) { signalTargetId = firstWait.id; }
  }

  return {
    name: cfg.name,
    language: 'python',
    filePath: opts.filePath,
    nodes: ctx.nodes,
    loopRegions: ctx.loopRegions.length > 0 ? ctx.loopRegions : undefined,
    loopAnchorId,
    hasLoopExit,
    signalTargetId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Translation context — accumulators threaded through the walk
// ─────────────────────────────────────────────────────────────────────────────

class TranslateCtx {
  nodes: WorkflowNode[] = [];
  loopRegions: LoopRegion[] = [];
  /** ID counter for synthetic decision / loop nodes (which need stable IDs). */
  syntheticCounter = 0;
  /** When set, the WorkflowModel emits the agentic-loop pattern around this primitive ID. */
  loopAnchorPrimitiveId?: string;

  constructor(public source: string) {}

  newSyntheticId(prefix: string, line: number): string {
    return `${prefix}_${line}_${this.syntheticCounter++}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Region visitor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visit a FlowRegion and append all derived WorkflowNodes to ctx.nodes.
 *
 * `tryStack` carries the currently enclosing try's compensation handlers —
 * each primitive inside the try gets those errorBranches attached. The stack
 * is a list (not a single block) so nested tries layer their compensations
 * outer→inner with the innermost first.
 */
function visitRegion(region: FlowRegion, ctx: TranslateCtx, tryStack: ErrorBranch[][]): void {
  switch (region.kind) {
    case 'sequence':
      for (const child of region.children) { visitRegion(child, ctx, tryStack); }
      return;

    case 'primitive':
      emitPrimitive(region, ctx, tryStack);
      return;

    case 'if': {
      // A FlowIf with a single branch and no `else` and trivial body is hard
      // to render meaningfully; for simplicity we always emit a decision node
      // and let the renderer fan-out / join.
      const decId = ctx.newSyntheticId('cond', region.line);
      const decNode: WorkflowNode = {
        id: decId,
        label: summarizeIfLabel(region.branches),
        kind: 'condition',
        role: 'flow',
        line: region.line,
        branches: region.branches.map(b => branchToErrorBranch(b, ctx, tryStack)),
      };
      ctx.nodes.push(decNode);
      return;
    }

    case 'try': {
      // Build the compensation error-branches once, push them onto the stack,
      // visit the body so each primitive inside picks them up, then visit the
      // else / finally separately (those run on success and unconditionally).
      const branches: ErrorBranch[] = region.excepts.map(ex => exceptToErrorBranch(ex, ctx));
      const innerStack = branches.length > 0 ? [branches, ...tryStack] : tryStack;
      visitRegion(region.body, ctx, innerStack);
      if (region.elseClause)    { visitRegion(region.elseClause,    ctx, tryStack); }
      if (region.finallyClause) { visitRegion(region.finallyClause, ctx, tryStack); }
      return;
    }

    case 'for':
    case 'while': {
      const loopId = ctx.newSyntheticId('loop', region.line);
      const label = region.kind === 'for'
        ? truncate(`for ${region.targetText} in ${region.iterableText}`)
        : truncate(`while ${region.conditionText}`);
      const loopNode: WorkflowNode = {
        id: loopId,
        label,
        kind: 'loop',
        role: 'flow',
        line: region.line,
      };
      ctx.nodes.push(loopNode);

      // Capture body line range BEFORE visiting so we can set the loop region.
      const bodyStart = region.body.line;
      const bodyEnd = bodyEndLine(region.body) ?? region.line + 1;

      // Track body-node range by tagging body nodes' lines. The diagram
      // generator filters by `n.line >= bodyStart && n.line <= bodyEnd`.
      ctx.loopRegions.push({ nodeId: loopId, bodyStart, bodyEnd });

      visitRegion(region.body, ctx, tryStack);

      // Agentic-loop detection: `while True:` containing a wait_condition
      // becomes the loopAnchor. We pick the first wait_condition primitive
      // emitted while visiting the body.
      if (region.kind === 'while' && region.isInfinite && !ctx.loopAnchorPrimitiveId) {
        const anchor = ctx.nodes.find(
          n => n.line >= bodyStart && n.line <= bodyEnd && n.id.startsWith('wait_cond_'),
        );
        if (anchor) { ctx.loopAnchorPrimitiveId = anchor.id; }
      }
      return;
    }

    case 'with':
      visitRegion(region.body, ctx, tryStack);
      return;

    case 'match': {
      // Treat match/case as an if-ladder: one decision node, one branch per case.
      const decId = ctx.newSyntheticId('match', region.line);
      ctx.nodes.push({
        id: decId,
        label: truncate(`match ${region.subjectText}`),
        kind: 'condition',
        role: 'flow',
        line: region.line,
        branches: region.cases.map(c => ({
          line: c.line,
          edgeLabel: truncate(`case ${c.patternText}`),
          nodes: regionToBranchNodes(c.body, ctx, []),
        })),
      });
      return;
    }

    case 'return':
    case 'raise':
      // No model node — the renderer terminates implicitly at END.
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive emission
// ─────────────────────────────────────────────────────────────────────────────

function emitPrimitive(prim: FlowPrimitive, ctx: TranslateCtx, tryStack: ErrorBranch[][]): void {
  const node = buildPrimitiveNode(prim.recognized, ctx);
  if (!node) { return; }

  // Attach try-stack compensations (innermost first; outer compensations are
  // unioned into a single errorBranches list — same node can have multiple
  // catch arms, which the renderer iterates).
  if (tryStack.length > 0) {
    node.errorBranches = tryStack.flat();
  }

  // Parallel children: render as fan-out → fan-in via the renderer's
  // existing `branches` mechanism. Each child is its own single-node branch
  // off the parent (gather/wait). We do NOT push children to ctx.nodes
  // (they'd render sequentially); they live only inside `node.branches`.
  //
  // The renderer reads an empty edgeLabel as "no label" so arms render with
  // clean arrows (see diagramGenerator.ts emitNode branches code path).
  if (prim.parallelChildren && prim.parallelChildren.length > 0) {
    const parallelBranches: ErrorBranch[] = [];
    for (const child of prim.parallelChildren) {
      const childNode = buildPrimitiveNode(child.recognized, ctx);
      if (!childNode) { continue; }
      if (tryStack.length > 0) {
        childNode.errorBranches = tryStack.flat();
      }
      parallelBranches.push({
        nodes: [childNode],
        edgeLabel: '',
        line: childNode.line,
      });
    }
    if (parallelBranches.length > 0) {
      node.branches = parallelBranches;
    }
  }

  ctx.nodes.push(node);
}

/**
 * Build a WorkflowNode from a RecognizedCall, or null for primitives that
 * don't render as a flow node (e.g. read-only `workflow.info()`).
 */
function buildPrimitiveNode(rc: RecognizedCall, ctx: TranslateCtx): WorkflowNode | null {
  if (!rc.primitive.flowRelevant) { return null; }

  const kind = nodeKindForPrimitive(rc.primitive);
  if (!kind) { return null; }

  const { id, label } = idAndLabelFor(rc);
  const options = parseActivityOptions(rc, ctx);

  const node: WorkflowNode = {
    id,
    label,
    kind,
    role: 'flow',
    line: rc.line,
  };
  if (options) { node.options = options; }
  return node;
}

/**
 * Map an SDK PrimitiveKind to a renderer NodeKind. Returns null for kinds
 * we explicitly don't render as flow nodes (read-only info, replay-aware,
 * handle classes, enums, exceptions, decorators).
 */
function nodeKindForPrimitive(p: SdkPrimitive): NodeKind | null {
  switch (p.kind) {
    case 'activity-call':       return 'activity';
    case 'local-activity-call': return 'localActivity';
    case 'child-workflow-call': return 'childWorkflow';
    case 'external-handle':     return 'childWorkflow';
    case 'timer':               return 'timer';
    case 'wait-condition':      return 'condition';
    case 'parallel-wait':       return 'condition';
    case 'create-task':         return 'sideEffect';
    case 'continue-as-new':     return 'sideEffect';
    case 'side-effect':         return 'sideEffect';
    case 'signal-setter':       return 'signal';
    case 'query-setter':        return 'query';
    case 'update-setter':       return 'signal';
    case 'nexus-client':        return 'nexus';
    default:                    return null;
  }
}

/**
 * Compute (id, label) for a primitive node. The label is what the user sees;
 * the id is a stable Mermaid-safe slug derived from the primitive + line.
 */
function idAndLabelFor(rc: RecognizedCall): { id: string; label: string } {
  const p = rc.primitive;
  const line = Math.floor(rc.line);
  const target = rc.targetName ?? '';

  switch (p.kind) {
    case 'activity-call': {
      const started = p.name.startsWith('start_') ? ' (started)' : '';
      const label = (target || p.name) + started;
      const id = slugify(`${target || p.name}${started ? '_started' : ''}_${line}`);
      return { id, label };
    }
    case 'local-activity-call': {
      const started = p.name.startsWith('start_') ? ' (started)' : '';
      const label = (target || p.name) + ' (local)' + started;
      const id = slugify(`${target || p.name}_local${started ? '_started' : ''}_${line}`);
      return { id, label };
    }
    case 'child-workflow-call': {
      const started = p.name.startsWith('start_') ? ' (child, started)' : ' (child)';
      const label = (target || p.name) + started;
      const id = slugify(`child_${target || p.name}${started.includes('started') ? '_started' : ''}_${line}`);
      return { id, label };
    }
    case 'external-handle':
      return { id: `ext_wf_${line}`, label: target ? `${target} (external)` : 'get_external_workflow_handle' };
    case 'timer':
      return { id: `sleep_${line}`, label: 'sleep' };
    case 'wait-condition': {
      // Surface the predicate so the user can see *what* the workflow is
      // waiting for. The first positional arg is typically a `lambda: <expr>`
      // bound to handler-mutated state. Show "wait: <expr>" for lambdas;
      // fall back to the raw text for other expressions (callable refs).
      const firstArg = rc.callNode.childForFieldName('arguments')?.namedChildren[0];
      let predicate = '';
      if (firstArg?.type === 'lambda') {
        const body = firstArg.childForFieldName('body');
        if (body) { predicate = body.text; }
      } else if (firstArg) {
        predicate = firstArg.text;
      }
      const label = predicate ? `wait: ${truncate(predicate)}` : 'wait_condition';
      return { id: `wait_cond_${line}`, label };
    }
    case 'parallel-wait':
      return { id: `wait_parallel_${line}`, label: p.qualifiedName === 'asyncio.gather' ? 'gather (parallel)' : 'wait (parallel)' };
    case 'create-task':
      return { id: `task_${line}`, label: p.name };
    case 'continue-as-new':
      return { id: `can_${line}`, label: 'continue_as_new' };
    case 'side-effect':
      return { id: `${slugify(p.name)}_${line}`, label: prettySideEffectLabel(p, rc) };
    case 'signal-setter':
      return { id: `signal_dyn_${line}`, label: dynamicHandlerLabel(rc, 'signal') };
    case 'query-setter':
      return { id: `query_dyn_${line}`, label: dynamicHandlerLabel(rc, 'query') };
    case 'update-setter':
      return { id: `update_dyn_${line}`, label: dynamicHandlerLabel(rc, 'update') };
    case 'nexus-client':
      return { id: `nexus_${line}`, label: 'create_nexus_client' };
    default:
      return { id: `${slugify(p.name)}_${line}`, label: p.name };
  }
}

function prettySideEffectLabel(p: SdkPrimitive, rc: RecognizedCall): string {
  // For patched / deprecate_patch, the first positional arg is the patch id.
  if (p.name === 'patched' || p.name === 'deprecate_patch') {
    const first = rc.callNode.childForFieldName('arguments')?.namedChildren[0];
    if (first?.type === 'string') {
      const inner = first.text.slice(1, -1);
      return `${p.name}: ${inner}`;
    }
  }
  if (p.name === 'uuid4') { return 'uuid4 (idempotencyKey)'; }
  if (p.name === 'random' || p.name === 'new_random') { return 'random (deterministic)'; }
  return p.name;
}

function dynamicHandlerLabel(rc: RecognizedCall, kind: 'signal' | 'query' | 'update'): string {
  // set_{signal,query,update}_handler("name", fn) — first arg is the external name.
  const first = rc.callNode.childForFieldName('arguments')?.namedChildren[0];
  if (first?.type === 'string') {
    const inner = first.text.slice(1, -1);
    return `${inner} (${kind}, dynamic)`;
  }
  return `dynamic ${kind} handler`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity option extraction — pulled from kwargs of the recognized call.
// ─────────────────────────────────────────────────────────────────────────────

function parseActivityOptions(rc: RecognizedCall, ctx: TranslateCtx): ActivityOptions | undefined {
  if (rc.primitive.kind !== 'activity-call' && rc.primitive.kind !== 'local-activity-call') {
    return undefined;
  }
  const opts: ActivityOptions = {};

  const stc = rc.kwargs.get('start_to_close_timeout');
  if (stc) { opts.startToCloseTimeout = parseTimedelta(stc); }

  const sc = rc.kwargs.get('schedule_to_close_timeout');
  if (sc) { opts.scheduleToCloseTimeout = parseTimedelta(sc); }

  const ss = rc.kwargs.get('schedule_to_start_timeout');
  if (ss) { opts.scheduleToStartTimeout = parseTimedelta(ss); }

  const hb = rc.kwargs.get('heartbeat_timeout');
  if (hb) { opts.heartbeatTimeout = parseTimedelta(hb); }

  const rp = rc.kwargs.get('retry_policy');
  if (rp) {
    const resolved = resolveRetryPolicy(rp, ctx.source);
    if (resolved) { opts.retryPolicy = resolved; }
  }

  return Object.keys(opts).length > 0 ? opts : undefined;
}

function parseTimedelta(node: Node): string {
  // Two shapes: `timedelta(seconds=30)` or just a name. We only beautify the
  // explicit timedelta(...) form; otherwise return the raw text.
  const text = node.text;
  const m = text.match(/^timedelta\s*\(([^)]+)\)$/);
  if (!m) { return text; }
  const args = m[1];
  const parts: string[] = [];
  const h = args.match(/hours\s*=\s*([\d.]+)/);
  const mi = args.match(/minutes\s*=\s*([\d.]+)/);
  const s = args.match(/seconds\s*=\s*([\d.]+)/);
  if (h)  { parts.push(`${h[1]}h`); }
  if (mi) { parts.push(`${mi[1]}m`); }
  if (s)  { parts.push(`${s[1]}s`); }
  return parts.length > 0 ? parts.join(' ') : args.trim();
}

function resolveRetryPolicy(node: Node, source: string): RetryPolicy | undefined {
  // Inline case: `retry_policy=RetryPolicy(...)`. The node IS the call.
  let block: string | undefined;
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.text === 'RetryPolicy') {
      block = node.childForFieldName('arguments')?.text;
    }
  }
  // Reference case: `retry_policy=MY_POLICY` — scan source for `MY_POLICY = RetryPolicy(...)`.
  if (!block) {
    const ref = node.text;
    const refEscaped = ref.replace(/[.[\]]/g, m => `\\${m}`);
    const pattern = new RegExp(`${refEscaped}\\s*=\\s*RetryPolicy\\s*\\(([\\s\\S]*?)\\)`, 'm');
    const m = source.match(pattern);
    if (m) { block = m[1]; }
  }
  if (!block) { return undefined; }

  const rp: RetryPolicy = {};
  const ii = block.match(/initial_interval\s*=\s*timedelta\s*\(([^)]+)\)/);
  if (ii) { rp.initialInterval = parseTimedelta({ text: `timedelta(${ii[1]})` } as Node); }
  const bc = block.match(/backoff_coefficient\s*=\s*([\d.]+)/);
  if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
  const mxi = block.match(/maximum_interval\s*=\s*timedelta\s*\(([^)]+)\)/);
  if (mxi) { rp.maximumInterval = parseTimedelta({ text: `timedelta(${mxi[1]})` } as Node); }
  const ma = block.match(/maximum_attempts\s*=\s*(\d+)/);
  if (ma) { rp.maximumAttempts = parseInt(ma[1], 10); }
  return Object.keys(rp).length > 0 ? rp : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch / except conversion
// ─────────────────────────────────────────────────────────────────────────────

function branchToErrorBranch(branch: FlowBranch, ctx: TranslateCtx, tryStack: ErrorBranch[][]): ErrorBranch {
  return {
    line: branch.line,
    edgeLabel: branch.conditionText ? truncate(`if ${branch.conditionText}`) : 'else',
    nodes: regionToBranchNodes(branch.body, ctx, tryStack),
  };
}

function exceptToErrorBranch(ex: FlowExcept, ctx: TranslateCtx): ErrorBranch {
  const label = ex.exceptionName
    ? `except ${ex.exceptionName}`
    : (ex.rawType ? `except ${ex.rawType}` : 'on error');
  return {
    line: ex.line,
    edgeLabel: label,
    nodes: regionToBranchNodes(ex.body, ctx, []),
  };
}

/**
 * Render a subtree as a flat node list for inclusion in an ErrorBranch.
 *
 * Because ErrorBranch only carries an array of `WorkflowNode`s, nested
 * control flow inside a branch is lossy — we extract every primitive (and
 * any raised exceptions to label terminal nodes) in source order. Diagram
 * polish (rendering nested control flow inside a branch) is a renderer-side
 * improvement scheduled separately.
 */
function regionToBranchNodes(
  region: FlowRegion,
  ctx: TranslateCtx,
  tryStack: ErrorBranch[][],
): WorkflowNode[] {
  // Capture node count before visiting so we can return only the new nodes.
  const baseline = ctx.nodes.length;
  visitRegion(region, ctx, tryStack);
  const emitted = ctx.nodes.splice(baseline);

  // Append a `raise` marker if the region terminates with one — useful for
  // showing rethrow at the end of a compensation chain.
  const raiseNode = findTerminalRaise(region, ctx);
  if (raiseNode) { emitted.push(raiseNode); }

  return emitted;
}

function findTerminalRaise(region: FlowRegion, ctx: TranslateCtx): WorkflowNode | null {
  function findIn(r: FlowRegion): { line: number; exc?: string } | null {
    switch (r.kind) {
      case 'raise':
        return { line: r.line, exc: r.exceptionName };
      case 'sequence':
        for (let i = r.children.length - 1; i >= 0; i--) {
          const got = findIn(r.children[i]);
          if (got) { return got; }
        }
        return null;
      case 'if':
        // Every branch raises? Too strict to enforce; just look at the last branch.
        if (r.branches.length === 0) { return null; }
        return findIn(r.branches[r.branches.length - 1].body);
      default:
        return null;
    }
  }
  const found = findIn(region);
  if (!found) { return null; }
  return {
    id: `raise_${found.line}_${ctx.syntheticCounter++}`,
    label: found.exc ?? 'raise',
    kind: 'sideEffect',
    role: 'flow',
    line: found.line,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler side-nodes (signal / query / update decorators)
// ─────────────────────────────────────────────────────────────────────────────

function emitHandlerSideNode(
  ctx: TranslateCtx,
  handler: HandlerCfg,
  name: string,
  kind: NodeKind,
  role: NodeRole,
  suffix: string = '',
): void {
  ctx.nodes.push({
    id: slugify(`${role.replace('-handler', '')}_${name}`),
    label: `${name}${suffix} (${role === 'signal-handler' ? 'signal' : 'query'})`.replace(' (update) (signal)', ' (update)'),
    kind,
    role,
    line: handler.line,
  });
  // Body of the handler is not currently rendered separately by the diagram
  // generator. The handler appears as a single node in the side subgraph.
  // Future work: render handler body as a sub-flow.
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function truncate(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function summarizeIfLabel(branches: FlowBranch[]): string {
  const cond = branches[0]?.conditionText;
  return cond ? truncate(`if ${cond}`) : 'if';
}

/**
 * Recursively determine the largest line number occupied by a region (used
 * to set `loopRegion.bodyEnd`).
 */
function bodyEndLine(region: FlowRegion): number | null {
  let max: number | null = null;
  function visit(r: FlowRegion): void {
    if (r.line > (max ?? -1)) { max = r.line; }
    switch (r.kind) {
      case 'sequence':    r.children.forEach(visit); return;
      case 'primitive':   r.parallelChildren?.forEach(visit); return;
      case 'if':          r.branches.forEach(b => visit(b.body)); return;
      case 'try':
        visit(r.body);
        r.excepts.forEach(ex => visit(ex.body));
        if (r.elseClause) { visit(r.elseClause); }
        if (r.finallyClause) { visit(r.finallyClause); }
        return;
      case 'for':
      case 'while':
        visit(r.body);
        if (r.elseClause) { visit(r.elseClause); }
        return;
      case 'with':        visit(r.body); return;
      case 'match':       r.cases.forEach(c => visit(c.body)); return;
      case 'return':
      case 'raise':       return;
    }
  }
  visit(region);
  return max;
}

// Silence a TS noUnusedLocals warning — PrimitiveKind is referenced in JSDoc only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PrimitiveKindReferenced = PrimitiveKind;
