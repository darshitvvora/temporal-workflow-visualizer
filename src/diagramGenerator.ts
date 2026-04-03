import { WorkflowModel, WorkflowNode, ErrorBranch } from './types';

export interface NodeMeta {
  line: number;
  tooltip: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pastel color palette — one entry per NodeKind
// Shape syntax reference: https://mermaid.js.org/syntax/flowchart.html#node-shapes
// ─────────────────────────────────────────────────────────────────────────────
//
//  activity       rectangle           ["label"]          soft blue   #A8C8E8
//  localActivity  double rectangle    [["label"]]        steel blue  #7BAFD4
//  signal         parallelogram       [/"label"\]        amber       #FFD580
//  query          inv-parallelogram   [\"label"/]        lavender    #C9BBEE
//  condition      diamond             {"label"}          teal        #98D4C8
//  timer          stadium             (["label"])        mint        #B8EBC8
//  childWorkflow  subroutine dbl-rect [["label"]]        coral       #FFB3A8
//  nexus          subroutine dbl-rect [["label"]]        rose        #FFB3CC
//  sideEffect     parallelogram       [/"label"\]        peach       #FFD8A8
//  startEnd       stadium             (["label"])        slate       #6B7A8D
//  errorEnd       stadium             (["label"])        red-pastel  #D4756A

const CLASS_DEFS = [
  'classDef activity      fill:#A8C8E8,stroke:#5A8CB0,color:#1a2a3a',
  'classDef localActivity fill:#7BAFD4,stroke:#4A7EA8,color:#fff',
  'classDef signal        fill:#FFD580,stroke:#C8A030,color:#3a2a00',
  'classDef query         fill:#C9BBEE,stroke:#8A76CC,color:#1a1030',
  'classDef condition     fill:#98D4C8,stroke:#4AA090,color:#002820',
  'classDef timer         fill:#B8EBC8,stroke:#5AAA78,color:#002810',
  'classDef childWorkflow fill:#FFB3A8,stroke:#CC6655,color:#2a0800',
  'classDef nexus         fill:#FFB3CC,stroke:#CC6688,color:#2a0010',
  'classDef sideEffect    fill:#FFD8A8,stroke:#C89040,color:#2a1800',
  'classDef startEnd      fill:#6B7A8D,stroke:#3D4D5E,color:#fff',
  'classDef errorEnd      fill:#D4756A,stroke:#A04030,color:#fff',
  'classDef loop          fill:#D4C5F9,stroke:#8A76CC,color:#1a1030',
  'classDef functionCall  fill:#FFF3B0,stroke:#C8A830,color:#3a2a00',
  'classDef signalGroup   fill:none,stroke:#C8A030,stroke-width:2px,stroke-dasharray:6 3,color:#C8A030',
  'classDef queryGroup    fill:none,stroke:#8A76CC,stroke-width:2px,stroke-dasharray:6 3,color:#8A76CC',
];

export function generateMermaid(model: WorkflowModel): string {
  const lines: string[] = ['flowchart TD'];

  for (const def of CLASS_DEFS) {
    lines.push(`  ${def}`);
  }
  lines.push('');

  const clickIds: string[] = [];

  // Build a map from loop node ID → body node IDs (for/while loop bodies).
  // Body nodes are rendered inside the loop emitter and skipped in the main flow.
  const loopBodyMap = new Map<string, WorkflowNode[]>();
  const loopBodyNodeIds = new Set<string>();

  if (model.loopRegions) {
    const allFlowNodes = model.nodes.filter(n => !n.role || n.role === 'flow');
    for (const region of model.loopRegions) {
      const bodyNodes = allFlowNodes.filter(
        n => n.kind !== 'loop' && n.line >= region.bodyStart && n.line <= region.bodyEnd
      );
      loopBodyMap.set(region.nodeId, bodyNodes);
      for (const bn of bodyNodes) { loopBodyNodeIds.add(bn.id); }
    }
  }

  const ctx: EmitCtx = { lines, clickIds, counter: 0, loopBodyMap, loopBodyNodeIds };

  // Split nodes by role (undefined → 'flow')
  // Exclude nodes that are inside a loop body — they're rendered by emitNode for the loop.
  const flowNodes   = model.nodes.filter(n => (!n.role || n.role === 'flow') && !loopBodyNodeIds.has(n.id));
  const signalNodes = model.nodes.filter(n => n.role === 'signal-handler');
  const queryNodes  = model.nodes.filter(n => n.role === 'query-handler');

  // ── START node ────────────────────────────────────────────────────────────
  lines.push(`  START(["▶ ${esc(model.name)}"]):::startEnd`);
  let prev = 'START';

  const anchorIdx = model.loopAnchorId
    ? flowNodes.findIndex(n => n.id === model.loopAnchorId)
    : -1;

  if (anchorIdx < 0) {
    // ── No loop: emit all nodes linearly, then connect to END ───────────────
    for (const node of flowNodes) {
      prev = emitNode(ctx, node, prev);
    }
    lines.push(`  END(["⏹ End"]):::startEnd`);
    lines.push(`  ${prev} --> END`);

  } else {
    // ── Loop pattern: init → anchor (loop gate) → body → ↺ back to anchor ──

    // Phase 1: initialization nodes (before the loop anchor, run once)
    for (let i = 0; i < anchorIdx; i++) {
      prev = emitNode(ctx, flowNodes[i], prev);
    }

    // Phase 2: loop anchor node itself (the wait_condition / Await gate)
    prev = emitNode(ctx, flowNodes[anchorIdx], prev);
    const anchorId = flowNodes[anchorIdx].id;

    // Phase 3: loop body nodes (after the anchor, repeat each iteration)
    // If the parser provided explicit loop regions, prefer those; otherwise
    // fall back to the simple "slice after anchor" heuristic.
    const loopBodyNodes = ctx.loopBodyMap.has(anchorId)
      ? ctx.loopBodyMap.get(anchorId) || []
      : flowNodes.slice(anchorIdx + 1);
    for (const node of loopBodyNodes) {
      prev = emitNode(ctx, node, prev);
    }

    // Loop-back: dashed edge from last body node (or anchor itself if body is empty)
    // back to the loop gate — represents the while-True / event loop
    if (loopBodyNodes.length > 0) {
      lines.push('');
      lines.push(`  ${prev} -.->|"↺ loop"| ${anchorId}`);
    }

    // END node: emitted but only connected when there is an explicit loop exit
    // (continue_as_new). If no exit, the loop is conceptually infinite and END
    // is shown as an unreachable orphan — communicating the agentic loop pattern.
    lines.push(`  END(["⏹ End"]):::startEnd`);
    if (model.hasLoopExit) {
      lines.push(`  ${prev} -. "exits" .-> END`);
    }
  }

  lines.push('');

  // ── Signal handlers ───────────────────────────────────────────────────────
  // Rendered in a dashed subgraph to the side; each connects into the loop
  // anchor (or START) with a dashed "triggers" edge.
  if (signalNodes.length > 0) {
    lines.push('  subgraph SIG["⚡ Signals / Updates"]');
    lines.push('    direction TB');
    for (const sn of signalNodes) {
      emitNodeShape(lines, sn, '    ');
      clickIds.push(sn.id);
    }
    lines.push('  end');
    lines.push('  class SIG signalGroup');
    lines.push('');
    const sigTarget = model.loopAnchorId ?? 'START';
    for (const sn of signalNodes) {
      lines.push(`  ${sn.id} -.->|"triggers"| ${sigTarget}`);
    }
    lines.push('');
  }

  // ── Query handlers ────────────────────────────────────────────────────────
  // Rendered in a dashed subgraph; a single dashed arrow from START shows
  // they can be called at any point but never affect the flow direction.
  if (queryNodes.length > 0) {
    lines.push('  subgraph QRY["🔍 Queries"]');
    lines.push('    direction TB');
    for (const qn of queryNodes) {
      emitNodeShape(lines, qn, '    ');
      clickIds.push(qn.id);
    }
    lines.push('  end');
    lines.push('  class QRY queryGroup');
    lines.push('');
    lines.push(`  START -.->|"queryable"| QRY`);
    lines.push('');
  }

  // ── Click handlers ────────────────────────────────────────────────────────
  for (const id of clickIds) {
    lines.push(`  click ${id} temporalNodeClick`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

interface EmitCtx {
  lines: string[];
  clickIds: string[];
  counter: number;
  /** Maps loop node ID → the flow nodes that belong inside that loop body */
  loopBodyMap: Map<string, WorkflowNode[]>;
  /** Set of node IDs that are inside a loop body (skipped in main flow iteration) */
  loopBodyNodeIds: Set<string>;
}

/**
 * Emits a single flow node (plus error branches if any).
 * For loop nodes, also emits body nodes with a back-edge.
 * Returns the node ID the next node should link FROM.
 */
function emitNode(ctx: EmitCtx, node: WorkflowNode, prev: string, skipLink = false): string {
  const { lines, clickIds } = ctx;
  const id = node.id;

  // ── Loop construct (for/while) ──────────────────────────────────────────
  if (node.kind === 'loop') {
    emitNodeShape(lines, node);
    if (!skipLink) { lines.push(`  ${prev} --> ${id}`); }
    clickIds.push(id);

    const bodyNodes = ctx.loopBodyMap.get(id) ?? [];
    let bodyPrev = id;
    for (const bn of bodyNodes) {
      bodyPrev = emitNode(ctx, bn, bodyPrev);
    }
    if (bodyNodes.length > 0) {
      lines.push(`  ${bodyPrev} -.->|"↺"| ${id}`);
    }
    // Return the loop gate itself so the next node connects from the loop exit
    return id;
  }

  emitNodeShape(lines, node);
  if (!skipLink) { lines.push(`  ${prev} --> ${id}`); }
  clickIds.push(id);

  // ── Branching (if/else style) ───────────────────────────────────────────
  if (node.branches && node.branches.length > 0) {
    const joinId = `${id}_join_${ctx.counter++}`;
    lines.push(`  ${joinId}[ ]:::startEnd`);

    for (const branch of node.branches) {
      if (!branch.nodes || branch.nodes.length === 0) {
        lines.push(`  ${id} -->|"${esc(branch.edgeLabel)}"| ${joinId}`);
        continue;
      }

      // Labeled edge to the first node, then emit the branch nodes
      const first = branch.nodes[0];
      lines.push(`  ${id} -->|"${esc(branch.edgeLabel)}"| ${first.id}`);
      // Emit the first node but suppress duplicate prev->first link
      let branchPrev = emitNode(ctx, first, id, true);
      for (let i = 1; i < branch.nodes.length; i++) {
        branchPrev = emitNode(ctx, branch.nodes[i], branchPrev);
      }
      lines.push(`  ${branchPrev} --> ${joinId}`);
    }

    return joinId;
  }

  if (!node.errorBranches || node.errorBranches.length === 0) {
    return id;
  }

  // ── Error / compensation branching ────────────────────────────────────────
  //   [activity]
  //       ↓
  //   {ok?}  ──yes──→  [ invisible pass ]  ──→  (next node)
  //       └──"on error"──→  [comp1] → [comp2] → (✕ Error)

  const decId = `${id}_dec_${ctx.counter++}`;
  lines.push(`  ${decId}{"ok?"}:::condition`);
  lines.push(`  ${id} --> ${decId}`);

  for (const branch of node.errorBranches) {
    emitErrorBranch(ctx, branch, decId);
  }

  const okId = `${id}_ok_${ctx.counter++}`;
  lines.push(`  ${okId}[ ]:::startEnd`);
  lines.push(`  ${decId} -->|yes| ${okId}`);

  return okId;
}

function emitErrorBranch(ctx: EmitCtx, branch: ErrorBranch, decisionId: string): string {
  const { lines, clickIds } = ctx;

  const errEndId = `err_end_${ctx.counter++}`;
  lines.push(`  ${errEndId}(["✕ ${esc(branch.edgeLabel)}"]):::errorEnd`);

  if (branch.nodes.length === 0) {
    lines.push(`  ${decisionId} -->|"${esc(branch.edgeLabel)}"| ${errEndId}`);
    return errEndId;
  }

  const firstNode = branch.nodes[0];
  emitNodeShape(lines, firstNode);
  clickIds.push(firstNode.id);
  lines.push(`  ${decisionId} -->|"${esc(branch.edgeLabel)}"| ${firstNode.id}`);

  let prev = firstNode.id;
  for (let i = 1; i < branch.nodes.length; i++) {
    const n = branch.nodes[i];
    emitNodeShape(lines, n);
    clickIds.push(n.id);
    lines.push(`  ${prev} --> ${n.id}`);
    prev = n.id;
  }

  lines.push(`  ${prev} --> ${errEndId}`);
  return errEndId;
}

// ── Shape per NodeKind ────────────────────────────────────────────────────────
//
//  Mermaid shape cheatsheet:
//    rectangle          id["label"]
//    double-rectangle   id[["label"]]    subroutine / child workflow
//    diamond            id{"label"}      decision / condition / wait
//    stadium/pill       id(["label"])    start/end/timer
//    parallelogram      id[/"label"\]    data I/O — signal / side-effect
//    inv-parallelogram  id[\"label"/]    data output — query
//
function emitNodeShape(lines: string[], node: WorkflowNode, indent = '  '): void {
  const id = node.id;
  const lbl = esc(node.label);
  switch (node.kind) {
    case 'activity':
      lines.push(`${indent}${id}["${lbl}"]:::activity`);
      break;
    case 'localActivity':
      lines.push(`${indent}${id}[["${lbl}"]]:::localActivity`);
      break;
    case 'signal':
      lines.push(`${indent}${id}[/"${lbl}"\\]:::signal`);
      break;
    case 'query':
      lines.push(`${indent}${id}[\\"${lbl}"/]:::query`);
      break;
    case 'condition':
      lines.push(`${indent}${id}{"${lbl}"}:::condition`);
      break;
    case 'timer':
      lines.push(`${indent}${id}(["${lbl}"]):::timer`);
      break;
    case 'childWorkflow':
      lines.push(`${indent}${id}[["${lbl}"]]:::childWorkflow`);
      break;
    case 'nexus':
      lines.push(`${indent}${id}[["${lbl}"]]:::nexus`);
      break;
    case 'sideEffect':
      lines.push(`${indent}${id}[/"${lbl}"\\]:::sideEffect`);
      break;
    case 'loop':
      lines.push(`${indent}${id}{"${lbl}"}:::loop`);
      break;
    case 'functionCall':
      lines.push(`${indent}${id}("${lbl}"):::functionCall`);
      break;
  }
}

// ── Node metadata (for side-panel) ───────────────────────────────────────────

export function buildNodeMetadata(model: WorkflowModel): Record<string, NodeMeta> {
  const meta: Record<string, NodeMeta> = {};

  function collect(nodes: WorkflowNode[]): void {
    for (const node of nodes) {
      meta[node.id] = { line: node.line, tooltip: buildTooltip(node) };
      if (node.errorBranches) {
        for (const b of node.errorBranches) { collect(b.nodes); }
      }
      if (node.branches) {
        for (const b of node.branches) { collect(b.nodes); }
      }
    }
  }

  collect(model.nodes);
  return meta;
}

function buildTooltip(node: WorkflowNode): string {
  const parts: string[] = [];
  parts.push(`${node.kind.toUpperCase()}: ${node.label}`);
  parts.push(`Line: ${node.line}`);

  if (node.options) {
    const o = node.options;
    parts.push('');
    parts.push('Activity Options:');
    if (o.startToCloseTimeout)    { parts.push(`  StartToCloseTimeout:    ${o.startToCloseTimeout}`); }
    if (o.scheduleToCloseTimeout) { parts.push(`  ScheduleToCloseTimeout: ${o.scheduleToCloseTimeout}`); }
    if (o.scheduleToStartTimeout) { parts.push(`  ScheduleToStartTimeout: ${o.scheduleToStartTimeout}`); }
    if (o.heartbeatTimeout)       { parts.push(`  HeartbeatTimeout:       ${o.heartbeatTimeout}`); }
    if (o.retryPolicy) {
      parts.push('  RetryPolicy:');
      const rp = o.retryPolicy;
      if (rp.initialInterval)                { parts.push(`    InitialInterval:    ${rp.initialInterval}`); }
      if (rp.backoffCoefficient !== undefined){ parts.push(`    BackoffCoefficient: ${rp.backoffCoefficient}`); }
      if (rp.maximumInterval)                { parts.push(`    MaximumInterval:    ${rp.maximumInterval}`); }
      if (rp.maximumAttempts !== undefined)   { parts.push(`    MaximumAttempts:    ${rp.maximumAttempts}`); }
      if (rp.nonRetryableErrorTypes?.length) { parts.push(`    NonRetryable: ${rp.nonRetryableErrorTypes.join(', ')}`); }
    }
  }

  if (node.errorBranches?.length) {
    parts.push('');
    parts.push('Error Branches:');
    for (const b of node.errorBranches) {
      parts.push(`  ${b.edgeLabel} (line ${b.line})`);
      for (const en of b.nodes) {
        parts.push(`    → ${en.label} (line ${en.line})`);
      }
    }
  }

  if (node.branches?.length) {
    parts.push('');
    parts.push('Branches:');
    for (const b of node.branches) {
      parts.push(`  ${b.edgeLabel} (line ${b.line})`);
      for (const en of b.nodes) {
        parts.push(`    → ${en.label} (line ${en.line})`);
      }
    }
  }

  return parts.join('\n');
}

function esc(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/</g, 'lt;').replace(/>/g, 'gt;');
}
