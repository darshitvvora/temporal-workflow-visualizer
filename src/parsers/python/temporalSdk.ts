/**
 * Catalog of the Temporal Python SDK surface relevant to workflow visualization.
 *
 * Sourced from https://python.temporal.io/temporalio.workflow.html and
 * https://python.temporal.io/temporalio.exceptions.html.
 *
 * The catalog is the single source of truth for "what is a Temporal primitive
 * in Python". The recognizer matches AST nodes against entries here using the
 * resolved module path (after walking import aliases).
 *
 * Each entry's `qualifiedName` is the canonical form *after* alias resolution,
 * e.g. `workflow.execute_activity`, `asyncio.gather`, `workflow.unsafe.is_replaying`.
 * It is the form the recognizer compares against — not what literally appears in
 * the source.
 */

/**
 * What the call/decorator means in terms of the diagram model.
 *
 * Each value maps to one or more existing NodeKind values in src/types.ts, but
 * we keep the catalog kind richer because (a) we may want to render subtly
 * different shapes later and (b) some primitives don't map to any node at all
 * (read-only info, replay-aware reads, exceptions).
 */
export type PrimitiveKind =
  // ── Calls that produce flow nodes ────────────────────────────────────────
  | 'activity-call'           // workflow.execute_activity / workflow.start_activity (+ method/class variants)
  | 'local-activity-call'     // workflow.execute_local_activity / workflow.start_local_activity (+ variants)
  | 'child-workflow-call'     // workflow.execute_child_workflow / workflow.start_child_workflow
  | 'external-handle'         // workflow.get_external_workflow_handle{,_for}
  | 'timer'                   // workflow.sleep / asyncio.sleep
  | 'wait-condition'          // workflow.wait_condition
  | 'parallel-wait'           // workflow.wait / asyncio.gather / asyncio.wait / asyncio.as_completed / asyncio.wait_for
  | 'create-task'             // asyncio.create_task / asyncio.shield (fire-and-forget)
  | 'continue-as-new'         // workflow.continue_as_new
  | 'side-effect'             // workflow.uuid4 / random / patched / deprecate_patch / upsert_memo / upsert_search_attributes / set_current_details
  | 'signal-setter'           // workflow.set_signal_handler / set_dynamic_signal_handler
  | 'query-setter'            // workflow.set_query_handler / set_dynamic_query_handler
  | 'update-setter'           // workflow.set_update_handler / set_dynamic_update_handler
  | 'nexus-client'            // workflow.create_nexus_client
  // ── Decorators (no flow node directly; they mark structural roles) ───────
  | 'decorator-workflow-defn'
  | 'decorator-workflow-run'
  | 'decorator-signal-handler'
  | 'decorator-query-handler'
  | 'decorator-update-handler'
  | 'decorator-update-validator'
  | 'decorator-workflow-init'
  | 'decorator-dynamic-config'
  | 'decorator-activity-defn' // not a workflow primitive but useful to flag
  // ── Reads / metadata (no flow node, but legitimate inside @workflow.run) ─
  | 'read-only-info'          // workflow.info / now / time / time_ns / instance / memo / memo_value /
                              // in_workflow / all_handlers_finished / current_update_info / etc.
  | 'replay-aware'            // workflow.unsafe.is_replaying / is_read_only / in_sandbox / etc.
  | 'handle-class'            // ActivityHandle / ChildWorkflowHandle / ExternalWorkflowHandle / NexusOperationHandle
  | 'enum-or-config'          // ActivityCancellationType / ParentClosePolicy / VersioningIntent / etc.
  | 'exception'               // ActivityError / ApplicationError / TimeoutError / CancelledError / etc.
  ;

/**
 * Where each primitive lives in the canonical import tree.
 *
 * The recognizer must be able to spot a call regardless of whether the
 * developer wrote `workflow.X`, `wf.X` (aliased import), or `X` (named
 * import from temporalio.workflow). The catalog therefore declares the
 * canonical module path here, and the import-context layer resolves
 * source identifiers back to it.
 */
export type Module =
  | 'temporalio.workflow'
  | 'temporalio.workflow.unsafe'
  | 'temporalio.activity'
  | 'temporalio.exceptions'
  | 'asyncio';

export interface SdkPrimitive {
  /** Canonical attribute path, e.g. `workflow.execute_activity` or `asyncio.gather`. */
  qualifiedName: string;
  /** The short name (last segment). */
  name: string;
  /** Module the primitive lives in. */
  module: Module;
  /** What this primitive means in the diagram model. */
  kind: PrimitiveKind;
  /**
   * Whether a call to this primitive is normally `await`ed inside a workflow.
   * Used by the recognizer to flag suspicious patterns and to decide whether
   * the call participates in the flow node sequence.
   *
   * 'always'   — must be awaited (e.g. execute_activity)
   * 'never'    — never awaited (e.g. workflow.now())
   * 'optional' — sometimes (e.g. start_activity returns a handle that is *optionally* awaited)
   */
  awaitable: 'always' | 'never' | 'optional';
  /**
   * Whether the call ultimately becomes a node in the diagram. False for
   * read-only / metadata primitives that are valid inside a workflow but
   * don't represent a step.
   */
  flowRelevant: boolean;
  /**
   * Short human description, lifted from the SDK docs. Kept here so the
   * catalog is self-explanatory without cross-referencing python.temporal.io.
   */
  description: string;
  /**
   * For activity/child-workflow calls: the 0-based positional argument index
   * that names the target. Used to extract the activity/child name from
   * `execute_activity("transfer_funds", ...)` etc.
   */
  targetNameArgIndex?: number;
}

// Convenience builders to keep the table below readable.
const wf = (
  name: string,
  kind: PrimitiveKind,
  awaitable: SdkPrimitive['awaitable'],
  flowRelevant: boolean,
  description: string,
  targetNameArgIndex?: number,
): SdkPrimitive => ({
  qualifiedName: `workflow.${name}`,
  name,
  module: 'temporalio.workflow',
  kind,
  awaitable,
  flowRelevant,
  description,
  targetNameArgIndex,
});

const wfUnsafe = (
  name: string,
  kind: PrimitiveKind,
  awaitable: SdkPrimitive['awaitable'],
  description: string,
): SdkPrimitive => ({
  qualifiedName: `workflow.unsafe.${name}`,
  name,
  module: 'temporalio.workflow.unsafe',
  kind,
  awaitable,
  flowRelevant: false,
  description,
});

const aio = (
  name: string,
  kind: PrimitiveKind,
  awaitable: SdkPrimitive['awaitable'],
  flowRelevant: boolean,
  description: string,
): SdkPrimitive => ({
  qualifiedName: `asyncio.${name}`,
  name,
  module: 'asyncio',
  kind,
  awaitable,
  flowRelevant,
  description,
});

const exc = (name: string, description: string): SdkPrimitive => ({
  qualifiedName: `temporalio.exceptions.${name}`,
  name,
  module: 'temporalio.exceptions',
  kind: 'exception',
  awaitable: 'never',
  flowRelevant: false,
  description,
});

// ─────────────────────────────────────────────────────────────────────────────
// Decorators
// ─────────────────────────────────────────────────────────────────────────────

const DECORATORS: SdkPrimitive[] = [
  wf('defn',            'decorator-workflow-defn',     'never', false, 'Register a class as a workflow definition'),
  wf('run',             'decorator-workflow-run',      'never', false, 'Mark the workflow entry-point method'),
  wf('signal',          'decorator-signal-handler',    'never', false, 'Declare a signal handler method'),
  wf('query',           'decorator-query-handler',     'never', false, 'Declare a query handler method'),
  wf('update',          'decorator-update-handler',    'never', false, 'Declare an update handler method'),
  wf('init',            'decorator-workflow-init',     'never', false, 'Mark a method as the workflow initializer'),
  wf('dynamic_config',  'decorator-dynamic-config',    'never', false, 'Provide dynamic workflow configuration'),
  // workflow.update.validator is accessed as an attribute on @workflow.update; recognized via attribute path.
  // @activity.defn is included for cross-module recognition (e.g. detecting locally defined activity targets).
  {
    qualifiedName: 'activity.defn',
    name: 'defn',
    module: 'temporalio.activity',
    kind: 'decorator-activity-defn',
    awaitable: 'never',
    flowRelevant: false,
    description: 'Register a function as an activity (referenced by execute_activity)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Activity execution
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVITY_CALLS: SdkPrimitive[] = [
  wf('execute_activity',         'activity-call', 'always',   true, 'Execute an activity and await its result', 0),
  wf('execute_activity_method',  'activity-call', 'always',   true, 'Execute a method-bound activity',          0),
  wf('execute_activity_class',   'activity-call', 'always',   true, 'Execute a class-based activity',           0),
  wf('start_activity',           'activity-call', 'optional', true, 'Start an activity, returning an ActivityHandle', 0),
  wf('start_activity_method',    'activity-call', 'optional', true, 'Start a method-bound activity',            0),
  wf('start_activity_class',     'activity-call', 'optional', true, 'Start a class-based activity',             0),

  wf('execute_local_activity',         'local-activity-call', 'always',   true, 'Execute a local activity',  0),
  wf('execute_local_activity_method',  'local-activity-call', 'always',   true, 'Execute a method-bound local activity', 0),
  wf('execute_local_activity_class',   'local-activity-call', 'always',   true, 'Execute a class-based local activity',  0),
  wf('start_local_activity',           'local-activity-call', 'optional', true, 'Start a local activity, returning a handle', 0),
  wf('start_local_activity_method',    'local-activity-call', 'optional', true, 'Start a method-bound local activity', 0),
  wf('start_local_activity_class',     'local-activity-call', 'optional', true, 'Start a class-based local activity',  0),
];

// ─────────────────────────────────────────────────────────────────────────────
// Child workflows + external handles
// ─────────────────────────────────────────────────────────────────────────────

const CHILD_WORKFLOWS: SdkPrimitive[] = [
  wf('execute_child_workflow',           'child-workflow-call', 'always',   true, 'Execute a child workflow and await its result', 0),
  wf('start_child_workflow',             'child-workflow-call', 'optional', true, 'Start a child workflow, returning a ChildWorkflowHandle', 0),
  wf('get_external_workflow_handle',     'external-handle',     'never',    true, 'Obtain a handle to an external workflow',     0),
  wf('get_external_workflow_handle_for', 'external-handle',     'never',    true, 'Typed variant of get_external_workflow_handle', 0),
];

// ─────────────────────────────────────────────────────────────────────────────
// Timers, waiting, conditions, parallel waits
// ─────────────────────────────────────────────────────────────────────────────

const TIMERS_AND_WAITS: SdkPrimitive[] = [
  wf('sleep',          'timer',          'always', true, 'Durable sleep for the given duration'),
  wf('wait_condition', 'wait-condition', 'always', true, 'Suspend until the given predicate returns True'),
  wf('wait',           'parallel-wait',  'always', true, 'Wait for one or more futures (workflow.wait)'),
  // workflow.as_completed mirrors asyncio.as_completed semantically
  wf('as_completed',   'parallel-wait',  'never',  true, 'Iterate over futures in completion order'),

  // asyncio interop — these are routinely used inside workflows.
  aio('sleep',         'timer',          'always', true, 'Durable sleep (intercepted by Temporal workflow event loop)'),
  aio('gather',        'parallel-wait',  'always', true, 'Run awaitables concurrently and collect results'),
  aio('wait',          'parallel-wait',  'always', true, 'Wait for futures, returning (done, pending) sets'),
  aio('wait_for',      'parallel-wait',  'always', true, 'Wait for a future with a timeout'),
  aio('as_completed',  'parallel-wait',  'never',  true, 'Iterate over futures in completion order'),
  aio('shield',        'create-task',    'always', true, 'Run an awaitable shielded from cancellation'),
  aio('create_task',   'create-task',    'never',  true, 'Schedule a coroutine as a background task'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Versioning, continue-as-new, side effects
// ─────────────────────────────────────────────────────────────────────────────

const SIDE_EFFECTS: SdkPrimitive[] = [
  wf('continue_as_new',           'continue-as-new', 'never',  true, 'Restart the workflow with new arguments'),
  wf('patched',                   'side-effect',    'never',  true, 'Check whether a versioning patch is active'),
  wf('deprecate_patch',           'side-effect',    'never',  true, 'Mark a versioning patch as safe to remove'),
  wf('uuid4',                     'side-effect',    'never',  true, 'Generate a deterministic UUID v4'),
  wf('random',                    'side-effect',    'never',  true, 'Return the workflow-seeded random.Random instance'),
  wf('new_random',                'side-effect',    'never',  true, 'Construct a new seeded random.Random instance'),
  wf('upsert_memo',               'side-effect',    'never',  true, 'Update or insert memo entries'),
  wf('upsert_search_attributes',  'side-effect',    'never',  true, 'Update or insert (legacy) search attributes'),
  // No public upsert_typed_search_attributes in current SDK index; if added later, add here.
  wf('set_current_details',       'side-effect',    'never',  true, 'Set workflow status details visible in UI/CLI'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Signal / query / update setters (dynamic registration inside @workflow.run)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLER_SETTERS: SdkPrimitive[] = [
  wf('set_signal_handler',         'signal-setter', 'never', true, 'Register or replace a named signal handler'),
  wf('set_dynamic_signal_handler', 'signal-setter', 'never', true, 'Register a catch-all signal handler'),
  wf('set_query_handler',          'query-setter',  'never', true, 'Register or replace a named query handler'),
  wf('set_dynamic_query_handler',  'query-setter',  'never', true, 'Register a catch-all query handler'),
  wf('set_update_handler',         'update-setter', 'never', true, 'Register or replace a named update handler'),
  wf('set_dynamic_update_handler', 'update-setter', 'never', true, 'Register a catch-all update handler'),
  // get_* counterparts are read-only and not flow-relevant.
  wf('get_signal_handler',         'read-only-info', 'never', false, 'Retrieve a named signal handler'),
  wf('get_dynamic_signal_handler', 'read-only-info', 'never', false, 'Retrieve the dynamic signal handler'),
  wf('get_query_handler',          'read-only-info', 'never', false, 'Retrieve a named query handler'),
  wf('get_dynamic_query_handler',  'read-only-info', 'never', false, 'Retrieve the dynamic query handler'),
  wf('get_update_handler',         'read-only-info', 'never', false, 'Retrieve a named update handler'),
  wf('get_dynamic_update_handler', 'read-only-info', 'never', false, 'Retrieve the dynamic update handler'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Nexus
// ─────────────────────────────────────────────────────────────────────────────

const NEXUS: SdkPrimitive[] = [
  wf('create_nexus_client', 'nexus-client', 'never', true, 'Create a Nexus operation client'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Read-only / metadata (valid inside workflows, but not a flow step)
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY: SdkPrimitive[] = [
  wf('info',                        'read-only-info', 'never', false, 'Get current WorkflowInfo'),
  wf('instance',                    'read-only-info', 'never', false, 'Get the current workflow instance'),
  wf('in_workflow',                 'read-only-info', 'never', false, 'True if called inside a workflow'),
  wf('now',                         'read-only-info', 'never', false, 'Current workflow time (datetime)'),
  wf('time',                        'read-only-info', 'never', false, 'Current workflow time (seconds since epoch)'),
  wf('time_ns',                     'read-only-info', 'never', false, 'Current workflow time (nanoseconds)'),
  wf('memo',                        'read-only-info', 'never', false, 'Read the workflow memo dictionary'),
  wf('memo_value',                  'read-only-info', 'never', false, 'Read a specific memo value'),
  wf('get_current_details',         'read-only-info', 'never', false, 'Get the currently-set workflow details'),
  wf('all_handlers_finished',       'read-only-info', 'never', false, 'True when all signal/update handlers are done'),
  wf('current_update_info',         'read-only-info', 'never', false, 'Info about the current update being processed'),
  wf('payload_converter',           'read-only-info', 'never', false, 'Access the current payload converter'),
  wf('metric_meter',                'read-only-info', 'never', false, 'Access the workflow metrics meter'),
  wf('extern_functions',            'read-only-info', 'never', false, 'Access registered external functions'),
  wf('get_last_completion_result',  'read-only-info', 'never', false, 'Result of the previous schedule run'),
  wf('has_last_completion_result',  'read-only-info', 'never', false, 'Whether a previous completion result exists'),
  wf('get_last_failure',            'read-only-info', 'never', false, 'Failure from the previous run, if any'),
  wf('is_failure_exception',        'read-only-info', 'never', false, 'Determine whether an exception is a failure'),
  wf('random_seed',                 'read-only-info', 'never', false, 'Retrieve the deterministic random seed'),
  wf('register_random_seed_callback', 'read-only-info', 'never', false, 'Register a callback for random-seed events'),
  wf('logger',                      'read-only-info', 'never', false, 'Workflow-context logger'),
];

// ─────────────────────────────────────────────────────────────────────────────
// workflow.unsafe — replay-aware introspection
// ─────────────────────────────────────────────────────────────────────────────

const UNSAFE: SdkPrimitive[] = [
  wfUnsafe('is_replaying',                          'replay-aware', 'never', 'True if the workflow is currently replaying history'),
  wfUnsafe('is_replaying_history_events',           'replay-aware', 'never', 'True if currently replaying history events specifically'),
  wfUnsafe('is_read_only',                          'replay-aware', 'never', 'True if currently in a read-only handler context'),
  wfUnsafe('in_sandbox',                            'replay-aware', 'never', 'True if running inside the workflow sandbox'),
  wfUnsafe('is_sandbox_unrestricted',               'replay-aware', 'never', 'True if sandbox restrictions are disabled'),
  wfUnsafe('sandbox_unrestricted',                  'replay-aware', 'never', 'Context manager to disable sandbox restrictions'),
  wfUnsafe('imports_passed_through',                'replay-aware', 'never', 'Context manager to allow passthrough imports'),
  wfUnsafe('is_imports_passed_through',             'replay-aware', 'never', 'True if imports currently bypass the sandbox'),
  wfUnsafe('sandbox_import_notification_policy',    'replay-aware', 'never', 'Get/set the sandbox import notification policy'),
  wfUnsafe('current_import_notification_policy_override', 'replay-aware', 'never', 'Get the current policy override'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Handle classes (recognized so we can attribute method calls on handles)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLES: SdkPrimitive[] = [
  wf('ActivityHandle',         'handle-class', 'never', false, 'Handle returned by start_activity'),
  wf('ChildWorkflowHandle',    'handle-class', 'never', false, 'Handle returned by start_child_workflow'),
  wf('ExternalWorkflowHandle', 'handle-class', 'never', false, 'Handle to an external workflow'),
  wf('NexusOperationHandle',   'handle-class', 'never', false, 'Handle to an in-flight Nexus operation'),
  wf('NexusClient',            'handle-class', 'never', false, 'Client for invoking Nexus operations'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Enums / config classes (no flow node, but referenced in options)
// ─────────────────────────────────────────────────────────────────────────────

const ENUMS_AND_CONFIG: SdkPrimitive[] = [
  wf('ActivityConfig',                'enum-or-config', 'never', false, 'Activity execution configuration'),
  wf('LocalActivityConfig',           'enum-or-config', 'never', false, 'Local activity execution configuration'),
  wf('ChildWorkflowConfig',           'enum-or-config', 'never', false, 'Child workflow execution configuration'),
  wf('DynamicWorkflowConfig',         'enum-or-config', 'never', false, 'Dynamic workflow configuration'),
  wf('ActivityCancellationType',      'enum-or-config', 'never', false, 'Enum: ABANDON | TRY_CANCEL | WAIT_CANCELLATION_COMPLETED'),
  wf('ChildWorkflowCancellationType', 'enum-or-config', 'never', false, 'Cancellation semantics for child workflows'),
  wf('ParentClosePolicy',             'enum-or-config', 'never', false, 'Enum: ABANDON | REQUEST_CANCEL | TERMINATE | UNSPECIFIED'),
  wf('NexusOperationCancellationType','enum-or-config', 'never', false, 'Cancellation semantics for Nexus operations'),
  wf('HandlerUnfinishedPolicy',       'enum-or-config', 'never', false, 'Policy for unfinished signal/update handlers'),
  wf('VersioningIntent',              'enum-or-config', 'never', false, 'Versioning intent for activities/child workflows'),
  wf('ContinueAsNewVersioningBehavior','enum-or-config','never', false, 'Versioning behavior on continue_as_new'),
  wf('Info',                          'enum-or-config', 'never', false, 'WorkflowInfo dataclass'),
  wf('ParentInfo',                    'enum-or-config', 'never', false, 'Parent workflow info'),
  wf('RootInfo',                      'enum-or-config', 'never', false, 'Root workflow info'),
  wf('UpdateInfo',                    'enum-or-config', 'never', false, 'Update-handler invocation info'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Exceptions — used in `except` clauses for labeling error branches
// ─────────────────────────────────────────────────────────────────────────────

const EXCEPTIONS: SdkPrimitive[] = [
  exc('TemporalError',               'Base class for all Temporal SDK exceptions'),
  exc('FailureError',                'Base class for failure-wrapping exceptions'),
  exc('ApplicationError',            'Application-thrown error from workflow/activity code'),
  exc('ActivityError',               'Wraps an error that occurred in an activity'),
  exc('ChildWorkflowError',          'Wraps an error that occurred in a child workflow'),
  exc('NexusOperationError',         'Wraps an error from a Nexus operation'),
  exc('CancelledError',              'Workflow / activity was cancelled'),
  exc('TimeoutError',                'Workflow / activity timed out'),
  exc('TerminatedError',             'Workflow was terminated'),
  exc('ServerError',                 'Error returned by the Temporal server'),
  exc('WorkflowAlreadyStartedError', 'Workflow with the same ID is already running'),
  exc('ActivityAlreadyStartedError', 'Activity execution already started'),
  // Workflow-module exceptions
  wf('ContinueAsNewError',     'exception', 'never', false, 'Sentinel exception that triggers continue-as-new'),
  wf('NondeterminismError',    'exception', 'never', false, 'Replay detected nondeterministic behavior'),
  wf('ReadOnlyContextError',   'exception', 'never', false, 'Attempted state mutation in a read-only context'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete catalog. The recognizer treats this as authoritative.
 */
export const TEMPORAL_SDK_CATALOG: readonly SdkPrimitive[] = Object.freeze([
  ...DECORATORS,
  ...ACTIVITY_CALLS,
  ...CHILD_WORKFLOWS,
  ...TIMERS_AND_WAITS,
  ...SIDE_EFFECTS,
  ...HANDLER_SETTERS,
  ...NEXUS,
  ...READ_ONLY,
  ...UNSAFE,
  ...HANDLES,
  ...ENUMS_AND_CONFIG,
  ...EXCEPTIONS,
]);

/**
 * Indexed by qualifiedName — primary lookup path for the recognizer.
 */
export const TEMPORAL_SDK_BY_QUALIFIED_NAME: ReadonlyMap<string, SdkPrimitive> =
  new Map(TEMPORAL_SDK_CATALOG.map(p => [p.qualifiedName, p]));

/**
 * Indexed by short name for the case where a developer uses a `from temporalio.workflow
 * import sleep` style and writes `sleep(...)` bare. The recognizer only trusts a
 * short-name hit when the import context proves the bare identifier resolves to a
 * cataloged primitive — see primitiveRecognizer.ts.
 *
 * Multiple primitives can share a short name (e.g. `sleep` exists in both `workflow.*`
 * and `asyncio.*`), so the value is an array.
 */
export const TEMPORAL_SDK_BY_SHORT_NAME: ReadonlyMap<string, readonly SdkPrimitive[]> = (() => {
  const m = new Map<string, SdkPrimitive[]>();
  for (const p of TEMPORAL_SDK_CATALOG) {
    const arr = m.get(p.name) ?? [];
    arr.push(p);
    m.set(p.name, arr);
  }
  // Freeze the inner arrays for safety.
  return new Map(Array.from(m.entries()).map(([k, v]) => [k, Object.freeze(v)]));
})();

/**
 * Lookup an SDK primitive by its canonical qualified name.
 * Returns undefined if the name is not in the catalog.
 */
export function lookupPrimitive(qualifiedName: string): SdkPrimitive | undefined {
  return TEMPORAL_SDK_BY_QUALIFIED_NAME.get(qualifiedName);
}

/**
 * Lookup all catalog entries that share a short name (last segment).
 */
export function lookupByShortName(name: string): readonly SdkPrimitive[] {
  return TEMPORAL_SDK_BY_SHORT_NAME.get(name) ?? [];
}

/**
 * The set of Temporal exception class names a workflow `except` clause might mention.
 * Used for labeling error branches in the diagram.
 */
export const TEMPORAL_EXCEPTION_NAMES: ReadonlySet<string> = new Set(
  TEMPORAL_SDK_CATALOG.filter(p => p.kind === 'exception').map(p => p.name),
);
