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

export interface ErrorBranch {
  /** Nodes that run in the error/catch/compensation branch */
  nodes: WorkflowNode[];
  /** Label shown on the error edge, e.g. "on error" or "except DepositFailed" */
  edgeLabel: string;
  /** Line where the try/catch/if-err starts */
  line: number;
}

export interface WorkflowNode {
  id: string;           // unique Mermaid node ID
  label: string;        // display name in diagram
  kind: NodeKind;
  line: number;         // 1-based line in source
  options?: ActivityOptions;  // activity-specific options (inherited or per-call)
  /** If this node is inside a try block, error branches from it */
  errorBranches?: ErrorBranch[];
}

export interface WorkflowModel {
  name: string;
  language: SupportedLanguage;
  filePath: string;
  nodes: WorkflowNode[];
  defaultOptions?: ActivityOptions;
}
