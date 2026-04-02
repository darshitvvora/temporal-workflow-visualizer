import { WorkflowModel, WorkflowNode, ActivityOptions } from './types';

export interface NodeMeta {
  line: number;
  tooltip: string;
}

export function generateMermaid(model: WorkflowModel): string {
  const lines: string[] = ['flowchart TD'];

  // Style definitions
  lines.push('  classDef activity fill:#4A90D9,stroke:#2C5F8A,color:#fff,rx:4');
  lines.push('  classDef signal fill:#E8A838,stroke:#B07820,color:#fff');
  lines.push('  classDef query fill:#7B68EE,stroke:#5A4BC9,color:#fff');
  lines.push('  classDef sideEffect fill:#F5A623,stroke:#C07D10,color:#fff');
  lines.push('  classDef timer fill:#50C878,stroke:#2E8B57,color:#fff');
  lines.push('  classDef childWorkflow fill:#FF6B6B,stroke:#CC4444,color:#fff');
  lines.push('  classDef startEnd fill:#2C3E50,stroke:#1A252F,color:#fff,rx:20');
  lines.push('');

  // Start node
  const startId = 'START';
  lines.push(`  ${startId}(["▶ ${escapeMermaid(model.name)}"]):::startEnd`);

  let prev = startId;

  for (const node of model.nodes) {
    const id = node.id;
    const label = escapeMermaid(node.label);

    switch (node.kind) {
      case 'activity':
        lines.push(`  ${id}["⚡ ${label}"]:::activity`);
        break;
      case 'signal':
        lines.push(`  ${id}(["📡 ${label}"]):::signal`);
        break;
      case 'query':
        lines.push(`  ${id}["🔍 ${label}"]:::query`);
        break;
      case 'sideEffect':
        lines.push(`  ${id}["🎲 ${label}"]:::sideEffect`);
        break;
      case 'timer':
        lines.push(`  ${id}["⏱ ${label}"]:::timer`);
        break;
      case 'childWorkflow':
        lines.push(`  ${id}["🔀 ${label}"]:::childWorkflow`);
        break;
    }

    lines.push(`  ${prev} --> ${id}`);
    // click directive: line number encoded in the href
    lines.push(`  click ${id} "line:${node.line}"`);
    prev = id;
  }

  // End node
  lines.push(`  END(["⏹ End"]):::startEnd`);
  lines.push(`  ${prev} --> END`);

  return lines.join('\n');
}

export function buildNodeMetadata(model: WorkflowModel): Record<string, NodeMeta> {
  const meta: Record<string, NodeMeta> = {};
  for (const node of model.nodes) {
    meta[node.id] = {
      line: node.line,
      tooltip: buildTooltip(node),
    };
  }
  return meta;
}

function buildTooltip(node: WorkflowNode): string {
  const parts: string[] = [];
  parts.push(`${node.kind.toUpperCase()}: ${node.label}`);
  parts.push(`Line: ${node.line}`);

  if (node.options) {
    parts.push('');
    parts.push('Activity Options:');
    if (node.options.startToCloseTimeout) {
      parts.push(`  StartToCloseTimeout: ${node.options.startToCloseTimeout}`);
    }
    if (node.options.scheduleToCloseTimeout) {
      parts.push(`  ScheduleToCloseTimeout: ${node.options.scheduleToCloseTimeout}`);
    }
    if (node.options.scheduleToStartTimeout) {
      parts.push(`  ScheduleToStartTimeout: ${node.options.scheduleToStartTimeout}`);
    }
    if (node.options.heartbeatTimeout) {
      parts.push(`  HeartbeatTimeout: ${node.options.heartbeatTimeout}`);
    }
    if (node.options.retryPolicy) {
      parts.push('  RetryPolicy:');
      const rp = node.options.retryPolicy;
      if (rp.initialInterval)     { parts.push(`    InitialInterval: ${rp.initialInterval}`); }
      if (rp.backoffCoefficient !== undefined) { parts.push(`    BackoffCoefficient: ${rp.backoffCoefficient}`); }
      if (rp.maximumInterval)     { parts.push(`    MaximumInterval: ${rp.maximumInterval}`); }
      if (rp.maximumAttempts !== undefined)    { parts.push(`    MaximumAttempts: ${rp.maximumAttempts}`); }
      if (rp.nonRetryableErrorTypes?.length) {
        parts.push(`    NonRetryable: ${rp.nonRetryableErrorTypes.join(', ')}`);
      }
    }
  }

  return parts.join('\n');
}

function escapeMermaid(text: string): string {
  // Mermaid node labels can't contain quotes or special chars unescaped
  return text.replace(/"/g, '&quot;').replace(/[<>]/g, ' ');
}
