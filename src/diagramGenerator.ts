import { WorkflowModel, WorkflowNode, ActivityOptions, ErrorBranch } from './types';

export interface NodeMeta {
  line: number;
  tooltip: string;
}

export function generateMermaid(model: WorkflowModel): string {
  const out: string[] = ['flowchart TD'];

  out.push('  classDef activity    fill:#4A90D9,stroke:#2C5F8A,color:#fff');
  out.push('  classDef signal      fill:#E8A838,stroke:#B07820,color:#fff');
  out.push('  classDef query       fill:#7B68EE,stroke:#5A4BC9,color:#fff');
  out.push('  classDef sideEffect  fill:#F5A623,stroke:#C07D10,color:#fff');
  out.push('  classDef timer       fill:#50C878,stroke:#2E8B57,color:#fff');
  out.push('  classDef childWf     fill:#FF6B6B,stroke:#CC4444,color:#fff');
  out.push('  classDef startEnd    fill:#2C3E50,stroke:#1A252F,color:#fff');
  out.push('  classDef errorEnd    fill:#C0392B,stroke:#922B21,color:#fff');
  out.push('');

  const clickIds: string[] = [];
  const ctx: EmitCtx = { out, clickIds, counter: 0 };

  out.push(`  START(["${esc(model.name)}"]):::startEnd`);
  let prev = 'START';

  for (const node of model.nodes) {
    prev = emitNode(ctx, node, prev);
  }

  out.push(`  END(["End"]):::startEnd`);
  out.push(`  ${prev} --> END`);
  out.push('');

  for (const id of clickIds) {
    out.push(`  click ${id} call temporalNodeClick()`);
  }

  return out.join('\n');
}

interface EmitCtx {
  out: string[];
  clickIds: string[];
  counter: number;
}

/**
 * Emits a single node (and its error branches if any).
 * Returns the ID that the next node should link FROM.
 */
function emitNode(ctx: EmitCtx, node: WorkflowNode, prev: string): string {
  const { out, clickIds } = ctx;
  const id = node.id;

  emitNodeShape(out, node);
  out.push(`  ${prev} --> ${id}`);
  clickIds.push(id);

  if (!node.errorBranches || node.errorBranches.length === 0) {
    return id;
  }

  // ── Error branching ───────────────────────────────────────────────────────
  // Pattern:
  //   [activity] --> {decision}
  //   {decision} --yes--> [ok_pass]        (invisible passthrough, continues happy path)
  //   {decision} --"on error"--> [errNode1] --> [errNode2] --> (ErrorEnd)
  //
  // The happy-path continues from ok_pass.

  const decId = `${id}_dec_${ctx.counter++}`;
  out.push(`  ${decId}{{"ok?"}}:::startEnd`);
  out.push(`  ${id} --> ${decId}`);

  // Each error branch goes off to the side
  for (const branch of node.errorBranches) {
    const branchFirstId = emitErrorBranch(ctx, branch, decId);
    // The edge from decision to first branch node is already emitted inside emitErrorBranch
    // with the label — nothing more needed here
    void branchFirstId;
  }

  // Happy path passthrough node (invisible, just to let the chain continue)
  const okId = `${id}_ok_${ctx.counter++}`;
  out.push(`  ${okId}[ ]:::startEnd`);
  out.push(`  ${decId} -->|yes| ${okId}`);

  return okId;
}

/**
 * Emits all nodes in an error branch, starting with a labelled edge from decisionId.
 * Returns the id of the last node in the branch.
 */
function emitErrorBranch(ctx: EmitCtx, branch: ErrorBranch, decisionId: string): string {
  const { out, clickIds } = ctx;

  const errEndId = `err_end_${ctx.counter++}`;
  out.push(`  ${errEndId}(["✕ Error"]):::errorEnd`);

  if (branch.nodes.length === 0) {
    out.push(`  ${decisionId} -->|"${esc(branch.edgeLabel)}"| ${errEndId}`);
    return errEndId;
  }

  // Emit the first branch node with the labelled edge from decision
  const firstNode = branch.nodes[0];
  emitNodeShape(out, firstNode);
  clickIds.push(firstNode.id);
  out.push(`  ${decisionId} -->|"${esc(branch.edgeLabel)}"| ${firstNode.id}`);

  let prev = firstNode.id;
  for (let i = 1; i < branch.nodes.length; i++) {
    const n = branch.nodes[i];
    emitNodeShape(out, n);
    clickIds.push(n.id);
    out.push(`  ${prev} --> ${n.id}`);
    prev = n.id;
  }

  out.push(`  ${prev} --> ${errEndId}`);
  return errEndId;
}

function emitNodeShape(out: string[], node: WorkflowNode): void {
  const id = node.id;
  const label = esc(node.label);
  switch (node.kind) {
    case 'activity':      out.push(`  ${id}["${label}"]:::activity`);    break;
    case 'signal':        out.push(`  ${id}(["${label}"]):::signal`);     break;
    case 'query':         out.push(`  ${id}["${label}"]:::query`);        break;
    case 'sideEffect':    out.push(`  ${id}["${label}"]:::sideEffect`);   break;
    case 'timer':         out.push(`  ${id}["${label}"]:::timer`);        break;
    case 'childWorkflow': out.push(`  ${id}["${label}"]:::childWf`);      break;
  }
}

export function buildNodeMetadata(model: WorkflowModel): Record<string, NodeMeta> {
  const meta: Record<string, NodeMeta> = {};

  function collect(nodes: WorkflowNode[]): void {
    for (const node of nodes) {
      meta[node.id] = { line: node.line, tooltip: buildTooltip(node) };
      if (node.errorBranches) {
        for (const b of node.errorBranches) { collect(b.nodes); }
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

  return parts.join('\n');
}

function esc(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/</g, 'lt;').replace(/>/g, 'gt;');
}
