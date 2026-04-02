export type SupportedLanguage = 'go' | 'java' | 'python' | 'typescript' | 'php' | 'csharp';

export interface RetryPolicy {
  initialInterval?: string;
  backoffCoefficient?: number;
  maximumInterval?: string;
  maximumAttempts?: number;
  nonRetryableErrorTypes?: string[];
}

export interface ActivityOptions {
  startToCloseTimeout?: string;
  scheduleToCloseTimeout?: string;
  scheduleToStartTimeout?: string;
  heartbeatTimeout?: string;
  retryPolicy?: RetryPolicy;
}

export type NodeKind = 'activity' | 'signal' | 'query' | 'sideEffect' | 'timer' | 'childWorkflow';

export interface WorkflowNode {
  id: string;           // unique Mermaid node ID
  label: string;        // display name in diagram
  kind: NodeKind;
  line: number;         // 1-based line in source
  options?: ActivityOptions;  // activity-specific options (inherited or per-call)
}

export interface WorkflowModel {
  name: string;
  language: SupportedLanguage;
  filePath: string;
  nodes: WorkflowNode[];
  defaultOptions?: ActivityOptions;
}
