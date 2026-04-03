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

/**
 * NodeKind maps to a specific flowchart symbol + color in the diagram.
 *
 *   activity       – standard activity              → rectangle         (soft blue)
 *   localActivity  – local activity (in-process)    → double rectangle  (steel blue)
 *   signal         – signal / update handler        → parallelogram     (amber)
 *   query          – query handler (read-only)      → inv. parallelogram (lavender)
 *   condition      – wait_condition / Await / cond  → diamond           (teal)
 *   timer          – sleep / NewTimer               → stadium/pill      (mint)
 *   childWorkflow  – child / external workflow      → subroutine        (coral)
 *   nexus          – Nexus client call              → subroutine        (rose)
 *   sideEffect     – SideEffect / versioning / CAN  → document shape    (peach)
 *   loop           – for/while loop construct       → diamond           (violet)
 *   functionCall   – non-Temporal function call     → rounded rect      (yellow)
 */
export type NodeKind =
  | 'activity'
  | 'localActivity'
  | 'signal'
  | 'query'
  | 'condition'
  | 'timer'
  | 'childWorkflow'
  | 'nexus'
  | 'sideEffect'
  | 'loop'
  | 'functionCall';

/**
 * NodeRole controls WHERE in the diagram a node is rendered:
 *   'flow'           – inside the main execution path (sequential)
 *   'signal-handler' – @workflow.signal / @WorkflowSignal handler (side input)
 *   'query-handler'  – @workflow.query / @WorkflowQuery handler (outside flow)
 */
export type NodeRole = 'flow' | 'signal-handler' | 'query-handler';

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
  role?: NodeRole;      // where in the diagram this node belongs (defaults to 'flow')
  line: number;         // 1-based line in source
  options?: ActivityOptions;  // activity-specific options (inherited or per-call)
  /** If this node is inside a try block, error branches from it */
  errorBranches?: ErrorBranch[];
  /** General control-flow branches (e.g. if-else): each branch is a list of nodes */
  branches?: ErrorBranch[];
}

/**
 * Describes a for/while loop region within the workflow, so the diagram
 * generator can render body nodes inside the loop with a back-edge.
 */
export interface LoopRegion {
  /** ID of the WorkflowNode that represents the loop header */
  nodeId: string;
  /** 1-based first line of the loop body */
  bodyStart: number;
  /** 1-based last line of the loop body (inclusive) */
  bodyEnd: number;
}

export interface WorkflowModel {
  name: string;
  language: SupportedLanguage;
  filePath: string;
  nodes: WorkflowNode[];
  /** ID of the node that acts as the loop anchor (e.g. wait_condition) */
  loopAnchorId?: string;
  defaultOptions?: ActivityOptions;
  /**
   * When loopAnchorId is set, true means the loop body contains an explicit exit
   * (continue_as_new). The diagram generator uses this to decide whether to connect END.
   * If false/absent the loop is conceptually infinite and END is emitted but not connected.
   */
  hasLoopExit?: boolean;
  /**
   * Regions for for/while loop constructs. Each entry links a loop node to
   * the line range of its body so the diagram generator can render the back-edge.
   */
  loopRegions?: LoopRegion[];
}
