import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy, ErrorBranch, LoopRegion } from '../types';

export class PythonParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Find ALL @workflow.defn classes, parse each, return the one with the most nodes.
    const classEntries = this.findAllWorkflowClasses();
    if (classEntries.length === 0) { return null; }

    let bestModel: WorkflowModel | null = null;
    for (const entry of classEntries) {
      const model = this.parseWorkflowClass(entry.name, entry.classBounds);
      if (model && (!bestModel || model.nodes.length > bestModel.nodes.length)) {
        bestModel = model;
      }
    }
    return bestModel;
  }

  /**
   * Finds all @workflow.defn classes and their body bounds (1-based, inclusive).
   */
  private findAllWorkflowClasses(): Array<{ name: string; classBounds: { start: number; end: number } }> {
    const results: Array<{ name: string; classBounds: { start: number; end: number } }> = [];
    const pattern = /@workflow\.defn(?:\([^)]*\))?/;

    for (let i = 0; i < this.lines.length; i++) {
      if (!pattern.test(this.lines[i])) { continue; }

      // Find the class line within the next 3 lines
      let className: string | undefined;
      let classIdx = -1;
      let classIndent = 0;
      for (let j = i + 1; j < Math.min(this.lines.length, i + 4); j++) {
        const cm = this.lines[j].match(/^(\s*)class\s+(\w+)\s*[:(]/);
        if (cm) {
          classIndent = cm[1].length;
          className = cm[2];
          classIdx = j;
          break;
        }
      }
      if (!className || classIdx < 0) { continue; }

      // Find the end of the class body using indentation
      const bodyStart = classIdx + 2; // 1-based
      let bodyEnd = this.lines.length;
      for (let j = classIdx + 1; j < this.lines.length; j++) {
        const l = this.lines[j];
        if (l.trim() === '') { continue; }
        const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent <= classIndent) {
          bodyEnd = j; // 1-based: j is the first line outside the class
          break;
        }
      }

      results.push({ name: className, classBounds: { start: bodyStart, end: bodyEnd } });
      // Skip past this class
      i = bodyEnd - 1;
    }

    return results;
  }

  /**
   * Parse a single workflow class within the given class bounds.
   */
  private parseWorkflowClass(
    name: string,
    classBounds: { start: number; end: number }
  ): WorkflowModel | null {
    const nodes: WorkflowNode[] = [];
    const loopRegions: LoopRegion[] = [];

    // Determine the bounds of the @workflow.run method body within this class.
    const runBounds = this.findRunMethodBounds(classBounds);

    // Collect helper method regions called from the run body (up to depth 3).
    const helperRegions = runBounds
      ? this.collectHelperRegions(runBounds, 0, new Set<string>())
      : [];

    // ── Function call nodes ──────────────────────────────────────────────
    for (const hr of helperRegions) {
      nodes.push({
        id: this.toId('fn_' + hr.methodName, hr.callSiteLine),
        label: hr.methodName + '()',
        kind: 'functionCall',
        role: 'flow',
        line: hr.callSiteLine,
      });
    }

    // ── Activity calls ────────────────────────────────────────────────────
    const activityNodes = this.parseActivityCalls(runBounds);
    nodes.push(...activityNodes);

    // ── Helper region content ─────────────────────────────────────────────
    for (const hr of helperRegions) {
      const helperNodes: WorkflowNode[] = [];

      helperNodes.push(...this.parseActivityCalls(hr.bounds));

      this.findAllLinesInBounds(/await\s+workflow\.wait_condition\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `wait_cond_${line}`, label: 'wait_condition', kind: 'condition', role: 'flow', line });
      });
      this.findAllLinesInBounds(/await\s+asyncio\.gather\s*\(|await\s+workflow\.wait\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `wait_gather_${line}`, label: 'wait (parallel)', kind: 'condition', role: 'flow', line });
      });
      this.findAllLinesInBounds(/await\s+asyncio\.sleep\s*\(|await\s+workflow\.sleep\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', role: 'flow', line });
      });
      this.findAllLinesInBounds(/await\s+workflow\.execute_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', role: 'flow', line });
      });
      this.findAllLinesInBounds(/await\s+workflow\.start_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push({ id: this.toId('child_started_' + match[1], line), label: match[1] + ' (child, started)', kind: 'childWorkflow', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.continue_as_new\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `can_${line}`, label: 'continue_as_new', kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.uuid4\s*\(\s*\)/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.random\s*\(\s*\)/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `random_${line}`, label: 'random (deterministic)', kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.patched\s*\(\s*["']([^'"]+)["']/, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push({ id: this.toId('patch_' + match[1], line), label: 'patched: ' + match[1], kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.deprecate_patch\s*\(\s*["']([^'"]+)["']/, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'deprecate_patch: ' + match[1], kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.upsert_memo\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `upsert_memo_${line}`, label: 'upsert_memo', kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.upsert_search_attributes\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `upsert_sa_${line}`, label: 'upsert_search_attributes', kind: 'sideEffect', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.get_external_workflow_handle\s*\(|workflow\.get_external_workflow_handle_for\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `ext_wf_${line}`, label: 'get_external_workflow_handle', kind: 'childWorkflow', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.create_nexus_client\s*\(/, hr.bounds).forEach(({ line }) => {
        helperNodes.push({ id: `nexus_${line}`, label: 'create_nexus_client', kind: 'nexus', role: 'flow', line });
      });
      this.findAllLinesInBounds(/workflow\.set_signal_handler\s*\(\s*["'](\w+)["']/, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push({ id: this.toId('signal_dyn_' + match[1], line), label: match[1] + ' (signal, dynamic)', kind: 'signal', role: 'signal-handler', line });
      });
      this.findAllLinesInBounds(/workflow\.set_query_handler\s*\(\s*["'](\w+)["']/, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push({ id: this.toId('query_dyn_' + match[1], line), label: match[1] + ' (query, dynamic)', kind: 'query', role: 'query-handler', line });
      });

      // Loop constructs inside this helper — detect using original-line nodes,
      // then add the loop node to the same batch so virtual lines stay consistent.
      const helperActOriginal = helperNodes.filter(n => n.role === 'flow');
      const loops = this.findLoopConstructs(hr.bounds, helperActOriginal);
      for (const lc of loops) {
        helperNodes.push(lc.node);
        loopRegions.push(lc.region);
      }

      this.applyVirtualLines(helperNodes, hr.callSiteLine);
      nodes.push(...helperNodes);
    }

    // ── Signal handlers (scoped to this class) ────────────────────────────

    this.findAllLinesInBounds(/@workflow\.signal(?:\([^)]*\))?/, classBounds).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const sName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', role: 'signal-handler', line });
      }
    });

    // ── Query handlers (scoped to this class) ─────────────────────────────

    this.findAllLinesInBounds(/@workflow\.query(?:\([^)]*\))?/, classBounds).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const qName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', role: 'query-handler', line });
      }
    });

    // ── Update handlers (scoped to this class) ────────────────────────────

    this.findAllLinesInBounds(/@workflow\.update(?:\([^)]*\))?/, classBounds).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const uName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (uName) {
        nodes.push({ id: this.toId('update_' + uName), label: uName + ' (update)', kind: 'signal', role: 'signal-handler', line });
      }
    });

    // ── Run-body-only primitives ──────────────────────────────────────────

    this.findAllLinesInBounds(/await\s+workflow\.wait_condition\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `wait_cond_${line}`, label: 'wait_condition', kind: 'condition', role: 'flow', line });
    });
    this.findAllLinesInBounds(/await\s+asyncio\.gather\s*\(|await\s+workflow\.wait\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `wait_gather_${line}`, label: 'wait (parallel)', kind: 'condition', role: 'flow', line });
    });
    this.findAllLinesInBounds(/await\s+asyncio\.sleep\s*\(|await\s+workflow\.sleep\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.patched\s*\(\s*["']([^'"]+)["']/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('patch_' + match[1], line), label: 'patched: ' + match[1], kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.deprecate_patch\s*\(\s*["']([^'"]+)["']/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'deprecate_patch: ' + match[1], kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.uuid4\s*\(\s*\)/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.random\s*\(\s*\)/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `random_${line}`, label: 'random (deterministic)', kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.upsert_memo\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsert_memo', kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.upsert_search_attributes\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsert_search_attributes', kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.continue_as_new\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `can_${line}`, label: 'continue_as_new', kind: 'sideEffect', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.get_external_workflow_handle\s*\(|workflow\.get_external_workflow_handle_for\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `ext_wf_${line}`, label: 'get_external_workflow_handle', kind: 'childWorkflow', role: 'flow', line });
    });
    this.findAllLinesInBounds(/await\s+workflow\.execute_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', role: 'flow', line });
    });
    this.findAllLinesInBounds(/await\s+workflow\.start_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_started_' + match[1], line), label: match[1] + ' (child, started)', kind: 'childWorkflow', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.create_nexus_client\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `nexus_${line}`, label: 'create_nexus_client', kind: 'nexus', role: 'flow', line });
    });
    this.findAllLinesInBounds(/workflow\.set_signal_handler\s*\(\s*["'](\w+)["']/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_dyn_' + match[1], line), label: match[1] + ' (signal, dynamic)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLinesInBounds(/workflow\.set_dynamic_signal_handler\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `signal_dynamic_${line}`, label: 'dynamic signal handler', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLinesInBounds(/workflow\.set_query_handler\s*\(\s*["'](\w+)["']/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_dyn_' + match[1], line), label: match[1] + ' (query, dynamic)', kind: 'query', role: 'query-handler', line });
    });
    this.findAllLinesInBounds(/workflow\.set_update_handler\s*\(\s*["'](\w+)["']/, runBounds).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('update_dyn_' + match[1], line), label: match[1] + ' (update, dynamic)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLinesInBounds(/workflow\.set_dynamic_update_handler\s*\(/, runBounds).forEach(({ line }) => {
      nodes.push({ id: `update_dynamic_${line}`, label: 'dynamic update handler', kind: 'signal', role: 'signal-handler', line });
    });

    // ── Loop constructs (for/while) ────────────────────────────────────────

    if (runBounds) {
      const loops = this.findLoopConstructs(runBounds, nodes);
      for (const lc of loops) {
        nodes.push(lc.node);
        loopRegions.push(lc.region);
      }
    }

    nodes.sort((a, b) => a.line - b.line);

    const loopAnchorId = this.detectInfiniteLoopAnchor(runBounds, nodes);
    const loopAnchorNode = loopAnchorId ? nodes.find(n => n.id === loopAnchorId) : undefined;

    const loopBodyFlowNodes = loopAnchorNode
      ? nodes.filter(n => (!n.role || n.role === 'flow') && n.line > loopAnchorNode.line)
      : [];
    const hasLoopExit = loopBodyFlowNodes.some(n => n.id.startsWith('can_'));

    return {
      name,
      language: 'python',
      filePath: this.filePath,
      nodes,
      loopAnchorId,
      hasLoopExit,
      loopRegions: loopRegions.length > 0 ? loopRegions : undefined,
    };
  }

  // ── Helper region collection ─────────────────────────────────────────────

  /**
   * Max recursion depth for inlining helper method calls.
   * Prevents infinite recursion on self-referential or deeply nested helpers.
   */
  private static readonly MAX_INLINE_DEPTH = 3;

  /**
   * A region representing a helper method called from the run body (or from another helper).
   */
  private collectHelperRegions(
    bounds: { start: number; end: number },
    depth: number,
    visited: Set<string>
  ): Array<{ methodName: string; callSiteLine: number; bounds: { start: number; end: number } }> {
    if (depth >= PythonParser.MAX_INLINE_DEPTH) { return []; }

    const results: Array<{ methodName: string; callSiteLine: number; bounds: { start: number; end: number } }> = [];

    const helperCalls = this.findHelperCallsInBounds(bounds);
    for (const { line, methodName } of helperCalls) {
      if (visited.has(methodName)) { continue; }
      const helperBounds = this.findMethodBounds(methodName);
      if (!helperBounds) { continue; }

      const nextVisited = new Set(visited);
      nextVisited.add(methodName);

      results.push({ methodName, callSiteLine: line, bounds: helperBounds });

      // Recurse into the helper's own helper calls
      const nested = this.collectHelperRegions(helperBounds, depth + 1, nextVisited);
      results.push(...nested);
    }

    return results;
  }

  /**
   * Find all `self.method()` / `await self.method()` calls within bounds.
   * Excludes calls to known Temporal SDK methods and built-ins.
   */
  private findHelperCallsInBounds(
    bounds: { start: number; end: number }
  ): Array<{ line: number; methodName: string }> {
    // Known Temporal/Python built-in prefixes to exclude
    const TEMPORAL_METHODS = new Set([
      'execute_activity', 'execute_local_activity', 'start_activity', 'start_local_activity',
      'execute_activity_method', 'execute_local_activity_method',
      'execute_activity_class', 'execute_local_activity_class',
      'wait_condition', 'sleep', 'uuid4', 'random', 'patched', 'deprecate_patch',
      'upsert_memo', 'upsert_search_attributes', 'continue_as_new',
      'get_external_workflow_handle', 'get_external_workflow_handle_for',
      'execute_child_workflow', 'start_child_workflow', 'create_nexus_client',
      'set_signal_handler', 'set_query_handler', 'set_update_handler',
      'set_dynamic_signal_handler', 'set_dynamic_update_handler',
      // common Python built-in method names to ignore
      'append', 'pop', 'get', 'set', 'add', 'remove', 'clear',
      'items', 'keys', 'values', 'update', 'extend', 'insert',
      'format', 'encode', 'decode', 'strip', 'split', 'join',
      'lower', 'upper', 'replace', 'startswith', 'endswith',
    ]);

    const results: Array<{ line: number; methodName: string }> = [];
    const selfPattern = /(?:await\s+)?self\.(\w+)\s*\(/g;

    // Also collect module-level / standalone function names defined in the file
    // so we can detect calls like `booking_workflow_impl(self, ...)`.
    const standaloneDefNames = new Set<string>();
    for (let i = 0; i < this.lines.length; i++) {
      const defMatch = this.lines[i].match(/^(async\s+)?def\s+(\w+)\s*\(/);
      if (defMatch) {
        standaloneDefNames.add(defMatch[2]);
      }
    }

    for (let i = bounds.start - 1; i < Math.min(this.lines.length, bounds.end); i++) {
      const l = this.lines[i];
      // Skip comment lines
      if (l.trimStart().startsWith('#')) { continue; }
      let m: RegExpExecArray | null;
      // Reset lastIndex for global pattern
      selfPattern.lastIndex = 0;
      while ((m = selfPattern.exec(l)) !== null) {
        const methodName = m[1];
        if (!TEMPORAL_METHODS.has(methodName)) {
          results.push({ line: i + 1, methodName });
        }
      }

      // Detect standalone function calls (not self.method, not workflow.method)
      // Match any identifier followed by `(` — then filter to known file-level defs.
      const standalonePattern = /\b(\w+)\s*\(/g;
      standalonePattern.lastIndex = 0;
      while ((m = standalonePattern.exec(l)) !== null) {
        const funcName = m[1];
        if (
          standaloneDefNames.has(funcName) &&
          !TEMPORAL_METHODS.has(funcName) &&
          !results.some(r => r.line === i + 1 && r.methodName === funcName)
        ) {
          results.push({ line: i + 1, methodName: funcName });
        }
      }
    }

    return results;
  }

  /**
   * Find the body bounds of a method by name (searches the entire file).
   * Returns null if the method is not found.
   */
  private findMethodBounds(methodName: string): { start: number; end: number } | null {
    const methodPattern = new RegExp(`^(\\s*)(async\\s+)?def\\s+${methodName}\\s*\\(`);

    let defIdx = -1;
    let defIndent = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const m = this.lines[i].match(methodPattern);
      if (m) {
        defIdx = i;
        defIndent = m[1].length;
        break;
      }
    }
    if (defIdx < 0) { return null; }

    // Find the colon that ends the signature (handles multi-line signatures)
    let sigEndIdx = defIdx;
    for (let i = defIdx; i < Math.min(this.lines.length, defIdx + 10); i++) {
      if (this.lines[i].trimEnd().endsWith(':')) {
        sigEndIdx = i;
        break;
      }
    }

    const bodyStart = sigEndIdx + 2; // 0-based sigEndIdx+1 → 1-based sigEndIdx+2

    let bodyEnd = this.lines.length;
    for (let i = sigEndIdx + 1; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.trim() === '') { continue; }
      const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
      if (indent <= defIndent) {
        bodyEnd = i + 1;
        break;
      }
    }

    return { start: bodyStart, end: bodyEnd - 1 };
  }

  /**
   * Scan a pattern in both the run body bounds AND all helper regions,
   * applying virtual line numbers for helper results.
   * nodeFactory receives (actualLine, match) and returns a WorkflowNode.
   */
  private scanWithHelpers(
    pattern: RegExp,
    runBounds: { start: number; end: number } | null,
    helperRegions: Array<{ callSiteLine: number; bounds: { start: number; end: number } }>,
    nodeFactory: (line: number, match: RegExpMatchArray) => WorkflowNode
  ): WorkflowNode[] {
    const results: WorkflowNode[] = [];

    // Scan run body
    this.findAllLinesInBounds(pattern, runBounds).forEach(({ line, match }) => {
      results.push(nodeFactory(line, match));
    });

    // Scan each helper region
    for (const hr of helperRegions) {
      const helperNodes: WorkflowNode[] = [];
      this.findAllLinesInBounds(pattern, hr.bounds).forEach(({ line, match }) => {
        helperNodes.push(nodeFactory(line, match));
      });
      this.applyVirtualLines(helperNodes, hr.callSiteLine);
      results.push(...helperNodes);
    }

    return results;
  }

  // ── Loop construct detection ─────────────────────────────────────────────

  /**
   * Finds for/while loop constructs in the given bounds.
   * Skips `while True:` patterns that wrap a `wait_condition` (Temporal agentic loop).
   * Returns loop nodes and their associated LoopRegion metadata.
   */
  private findLoopConstructs(
    bounds: { start: number; end: number },
    existingNodes: WorkflowNode[]
  ): Array<{ node: WorkflowNode; region: LoopRegion }> {
    const results: Array<{ node: WorkflowNode; region: LoopRegion }> = [];

    for (let i = bounds.start - 1; i < Math.min(this.lines.length, bounds.end); i++) {
      const l = this.lines[i];
      const lineNum = i + 1; // 1-based

      // Skip comment lines
      if (l.trimStart().startsWith('#')) { continue; }

      const loopIndentMatch = l.match(/^(\s*)/);
      const loopIndent = loopIndentMatch ? loopIndentMatch[1].length : 0;

      // Detect `for <vars> in <iterable>:`
      const forMatch = l.match(/^\s*for\s+(.+?)\s+in\s+(.+?)\s*:/);
      // Detect `while <condition>:` (but not `while True:` wrapping wait_condition — handled below)
      const whileMatch = l.match(/^\s*while\s+(.+?)\s*:/);

      if (!forMatch && !whileMatch) { continue; }

      // Compute body bounds for this loop
      const loopBodyBounds = this.computeLoopBodyBounds(i, loopIndent);
      if (!loopBodyBounds) { continue; }

      // Skip `while True:` / `while true:` if body contains wait_condition
      // (that pattern is handled by the Temporal agentic loop logic)
      if (whileMatch) {
        const cond = whileMatch[1].trim();
        if (cond === 'True' || cond === 'true' || cond === '1') {
          const hasWaitCond = this.findAllLinesInBounds(
            /await\s+workflow\.wait_condition\s*\(/, loopBodyBounds
          ).length > 0;
          if (hasWaitCond) { continue; }
        }
      }

      // Build the label
      let label: string;
      if (forMatch) {
        label = `for ${forMatch[1]} in ${forMatch[2]}`;
        // Truncate long labels
        if (label.length > 40) { label = label.substring(0, 37) + '...'; }
      } else {
        label = `while ${whileMatch![1].trim()}`;
        if (label.length > 40) { label = label.substring(0, 37) + '...'; }
      }

      const nodeId = `loop_${lineNum}`;

      // Check if there are any flow nodes inside this loop body
      // (skip emitting a loop node if body is empty to avoid noise)
      const bodyHasNodes = existingNodes.some(
        n => n.role === 'flow' && n.line >= loopBodyBounds.start && n.line <= loopBodyBounds.end
      );
      if (!bodyHasNodes) { continue; }

      results.push({
        node: {
          id: nodeId,
          label,
          kind: 'loop',
          role: 'flow',
          line: lineNum,
        },
        region: {
          nodeId,
          bodyStart: loopBodyBounds.start,
          bodyEnd: loopBodyBounds.end,
        },
      });
    }

    return results;
  }

  /**
   * Given the 0-based index of a loop header line and its indentation,
   * compute the 1-based body bounds.
   */
  private computeLoopBodyBounds(
    headerIdx: number,
    headerIndent: number
  ): { start: number; end: number } | null {
    // Body starts on the line after the header
    const bodyStart = headerIdx + 2; // 1-based

    let bodyEnd = bodyStart;
    let found = false;
    for (let i = headerIdx + 1; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.trim() === '') { continue; } // skip blank lines
      const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
      if (indent <= headerIndent) {
        // This line is at or less indented than the loop header — body ended
        bodyEnd = i; // 1-based: i is the line AFTER the body
        found = true;
        break;
      }
      bodyEnd = i + 1; // 1-based: keep extending
    }

    if (!found) {
      bodyEnd = this.lines.length; // body extends to end of file
    }

    if (bodyEnd < bodyStart) { return null; }
    return { start: bodyStart, end: bodyEnd };
  }

  /**
   * Detect whether the workflow has an actual infinite loop pattern
   * (`while True:`) wrapping a `wait_condition` call.
   */
  private detectInfiniteLoopAnchor(
    runBounds: { start: number; end: number } | null,
    nodes: WorkflowNode[]
  ): string | undefined {
    if (!runBounds) { return undefined; }

    for (let i = runBounds.start - 1; i < Math.min(this.lines.length, runBounds.end); i++) {
      const l = this.lines[i];
      const whileMatch = l.match(/^(\s*)while\s+(.+?)\s*:/);
      if (!whileMatch) { continue; }

      const cond = whileMatch[2].trim();
      if (cond !== 'True' && cond !== 'true' && cond !== '1') { continue; }

      const headerIndent = whileMatch[1].length;
      const loopBodyBounds = this.computeLoopBodyBounds(i, headerIndent);
      if (!loopBodyBounds) { continue; }

      // Check if there's a wait_condition inside this while True loop
      const anchorNode = nodes.find(
        n => n.role === 'flow' && n.id.startsWith('wait_cond_') &&
             n.line >= loopBodyBounds.start && n.line <= loopBodyBounds.end
      );
      if (anchorNode) { return anchorNode.id; }
    }
    return undefined;
  }

  // ── Run method bounds ────────────────────────────────────────────────────

  /**
   * Returns the 1-based line range [start, end] of the @workflow.run method body,
   * or null if not found. Uses Python indentation to detect method boundaries.
   * When searchBounds is provided, only looks for @workflow.run within that range.
   */
  private findRunMethodBounds(searchBounds?: { start: number; end: number }): { start: number; end: number } | null {
    // Find @workflow.run decorator (0-based index)
    const searchStart = searchBounds ? searchBounds.start - 1 : 0;
    const searchEnd = searchBounds ? Math.min(this.lines.length, searchBounds.end) : this.lines.length;
    let decoratorIdx = -1;
    for (let i = searchStart; i < searchEnd; i++) {
      if (/@workflow\.run\b/.test(this.lines[i])) {
        decoratorIdx = i;
        break;
      }
    }
    if (decoratorIdx < 0) { return null; }

    // Find the def line immediately after (within 3 lines)
    let defIdx = -1;
    for (let i = decoratorIdx + 1; i < Math.min(this.lines.length, decoratorIdx + 4); i++) {
      if (/^\s*(async\s+)?def\s+\w+/.test(this.lines[i])) {
        defIdx = i;
        break;
      }
    }
    if (defIdx < 0) { return null; }

    const defIndentMatch = this.lines[defIdx].match(/^(\s*)/);
    const defIndent = defIndentMatch ? defIndentMatch[1].length : 0;

    // Find the colon that ends the signature
    let sigEndIdx = defIdx;
    for (let i = defIdx; i < Math.min(this.lines.length, defIdx + 10); i++) {
      if (this.lines[i].trimEnd().endsWith(':')) {
        sigEndIdx = i;
        break;
      }
    }

    const bodyStart = sigEndIdx + 2;

    let bodyEnd = this.lines.length;
    for (let i = sigEndIdx + 1; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.trim() === '') { continue; }
      const indentMatch = l.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (indent <= defIndent) {
        bodyEnd = i + 1;
        break;
      }
    }

    return { start: bodyStart, end: bodyEnd - 1 };
  }

  // ── Activity call parsing ────────────────────────────────────────────────

  /**
   * Parses all execute_activity / start_activity calls and groups those inside
   * try blocks so that except-clause activities become error branches.
   * When runBounds is provided, only calls within that range are included.
   */
  private parseActivityCalls(runBounds: { start: number; end: number } | null): WorkflowNode[] {
    const result: WorkflowNode[] = [];

    const tryBlocks = this.findTryExceptBlocks();

    const lineToTryBlock = new Map<number, TryBlock>();
    const exceptBodyLines = new Set<number>();
    for (const tb of tryBlocks) {
      for (let l = tb.tryStart; l <= tb.tryEnd; l++) {
        lineToTryBlock.set(l, tb);
      }
      for (const ex of tb.exceptBlocks) {
        for (let l = ex.start; l <= ex.end; l++) {
          exceptBodyLines.add(l);
        }
      }
    }

    const actPat = /await\s+workflow\.(execute|start)_(?:local_)?activity(?:_method|_class)?\s*\(\s*(?:\w+\.)?(\w+)/;
    // Also match when the activity call ends with `(\s*$` (name on next line)
    const actPatMultiLine = /await\s+workflow\.(execute|start)_(?:local_)?activity(?:_method|_class)?\s*\(\s*$/;

    const processActivityMatch = (line: number, match: RegExpMatchArray, lineText: string) => {
      if (runBounds && (line < runBounds.start || line > runBounds.end)) { return; }
      if (exceptBodyLines.has(line)) { return; }

      const isStarted = match[1] === 'start';
      const isLocal = /(?:execute|start)_local_activity/.test(lineText);
      const rawName = match[2];
      const suffix = (isLocal ? ' (local)' : '') + (isStarted ? ' (started)' : '');
      const actName = rawName + suffix;
      const actId = this.toId(rawName + (isLocal ? '_local' : '') + (isStarted ? '_started' : ''), line);
      const opts = this.parseActivityCallOptions(line);

      const kind = isLocal ? 'localActivity' : 'activity';
      const tb = lineToTryBlock.get(line);
      if (tb) {
        const errorBranches = this.buildErrorBranches(tb);
        result.push({ id: actId, label: actName, kind, role: 'flow', line, options: opts, errorBranches });
      } else {
        result.push({ id: actId, label: actName, kind, role: 'flow', line, options: opts });
      }
    };

    this.findAllLines(actPat).forEach(({ line, match }) => {
      processActivityMatch(line, match, this.lines[line - 1]);
    });

    // Handle multi-line activity calls where the activity name is on the next line
    this.findAllLines(actPatMultiLine).forEach(({ line, match }) => {
      if (runBounds && (line < runBounds.start || line > runBounds.end)) { return; }
      if (exceptBodyLines.has(line)) { return; }
      // Check if this line was already matched by the single-line pattern
      if (result.some(r => r.line === line)) { return; }

      // Look at the next non-empty line for the activity name
      const nextLineIdx = line; // line is 1-based, so this.lines[line] is the next line
      if (nextLineIdx < this.lines.length) {
        const nextLine = this.lines[nextLineIdx].trim();
        const nameMatch = nextLine.match(/^(?:\w+\.)?(\w+)\s*[,)]/);
        if (nameMatch) {
          const fullMatch = [...match, nameMatch[1]] as unknown as RegExpMatchArray;
          fullMatch[2] = nameMatch[1];
          processActivityMatch(line, fullMatch, this.lines[line - 1]);
        }
      }
    });

    return result;
  }

  private buildErrorBranches(tb: { tryEnd: number; exceptBlocks: ExceptBlock[] }): ErrorBranch[] {
    const branches: ErrorBranch[] = [];
    for (const except of tb.exceptBlocks) {
      const exceptNodes: WorkflowNode[] = [];

      for (let l = except.start; l <= except.end && l <= this.lines.length; l++) {
        let m = this.lines[l - 1].match(/await\s+workflow\.(?:execute|start)_(?:local_)?activity(?:_method|_class)?\s*\(\s*(?:\w+\.)?(\w+)/);
        // Handle multi-line: activity name on next line
        if (!m && /await\s+workflow\.(?:execute|start)_(?:local_)?activity(?:_method|_class)?\s*\(\s*$/.test(this.lines[l - 1]) && l < this.lines.length) {
          const nextLine = this.lines[l].trim();
          const nameMatch = nextLine.match(/^(?:\w+\.)?(\w+)\s*[,)]/);
          if (nameMatch) {
            m = nameMatch;
          }
        }
        if (m) {
          const opts = this.parseActivityCallOptions(l);
          exceptNodes.push({
            id: this.toId('comp_' + m[1], l),
            label: m[1] + ' (compensate)',
            kind: 'activity',
            role: 'flow',
            line: l,
            options: opts,
          });
        }
        const raiseM = this.lines[l - 1].match(/raise\s+(\w+(?:Error|Exception|ApplicationError))\s*\(/);
        if (raiseM) {
          exceptNodes.push({
            id: `raise_${l}`,
            label: raiseM[1],
            kind: 'sideEffect',
            role: 'flow',
            line: l,
          });
        }
      }

      branches.push({
        nodes: exceptNodes,
        edgeLabel: except.errorType ? `except ${except.errorType}` : 'on error',
        line: except.start,
      });
    }
    return branches;
  }

  // ── try/except block detection ───────────────────────────────────────────

  private findTryExceptBlocks(): TryBlock[] {
    const blocks: TryBlock[] = [];

    for (let i = 0; i < this.lines.length; i++) {
      const tryMatch = this.lines[i].match(/^(\s*)try\s*:/);
      if (!tryMatch) { continue; }

      const baseIndent = tryMatch[1].length;
      const tryStart = i + 2;

      let exceptLineIdx = -1;
      for (let j = i + 1; j < this.lines.length; j++) {
        const l = this.lines[j];
        if (l.trim() === '') { continue; }
        const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent <= baseIndent && /^\s*(except|else|finally)/.test(l)) {
          exceptLineIdx = j;
          break;
        }
      }
      if (exceptLineIdx < 0) { continue; }

      const tryEnd = exceptLineIdx;

      const exceptBlocks: ExceptBlock[] = [];
      let j = exceptLineIdx;
      while (j < this.lines.length) {
        const l = this.lines[j];
        if (l.trim() === '') { j++; continue; }
        const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent < baseIndent) { break; }

        const exceptMatch = l.match(/^\s*except\s*(?:(\w+(?:\.\w+)?)\s*(?:as\s+\w+)?)?\s*:/);
        if (!exceptMatch) { break; }

        const errorType = exceptMatch[1] || '';
        const exceptStart = j + 2;
        let exceptEnd = exceptStart;

        for (let k = j + 1; k < this.lines.length; k++) {
          const el = this.lines[k];
          if (el.trim() === '') { continue; }
          const eindent = (el.match(/^(\s*)/)?.[1].length) ?? 0;
          if (eindent <= baseIndent && /^\s*(except|else|finally|[^\s])/.test(el)) {
            exceptEnd = k;
            break;
          }
          exceptEnd = k + 1;
        }

        exceptBlocks.push({ start: exceptStart, end: exceptEnd, errorType });
        j = exceptEnd;
      }

      if (exceptBlocks.length > 0) {
        blocks.push({ tryStart, tryEnd, exceptBlocks });
      }
    }

    return blocks;
  }

  // ── Options parsing ──────────────────────────────────────────────────────

  private parseActivityCallOptions(callLine: number): ActivityOptions | undefined {
    const callText: string[] = [];
    let depth = 0;
    for (let i = callLine - 1; i < Math.min(this.lines.length, callLine + 15); i++) {
      const l = this.lines[i];
      depth += (l.match(/\(/g) || []).length;
      depth -= (l.match(/\)/g) || []).length;
      callText.push(l);
      if (depth === 0 && callText.length > 1) { break; }
    }
    const block = callText.join('\n');
    const opts: ActivityOptions = {};

    const stc = block.match(/start_to_close_timeout\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (stc) { opts.startToCloseTimeout = this.parseTdelta(stc[1]); }

    const sc = block.match(/schedule_to_close_timeout\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (sc) { opts.scheduleToCloseTimeout = this.parseTdelta(sc[1]); }

    const hb = block.match(/heartbeat_timeout\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (hb) { opts.heartbeatTimeout = this.parseTdelta(hb[1]); }

    const rpRef = block.match(/retry_policy\s*=\s*([\w.]+)/);
    if (rpRef) {
      const rp = this.resolveRetryPolicy(rpRef[1]);
      if (rp) { opts.retryPolicy = rp; }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  private parseTdelta(args: string): string {
    const h = args.match(/hours\s*=\s*([\d.]+)/);
    const m = args.match(/minutes\s*=\s*([\d.]+)/);
    const s = args.match(/seconds\s*=\s*([\d.]+)/);
    const parts: string[] = [];
    if (h) { parts.push(h[1] + 'h'); }
    if (m) { parts.push(m[1] + 'm'); }
    if (s) { parts.push(s[1] + 's'); }
    return parts.length > 0 ? parts.join(' ') : args.trim();
  }

  private resolveRetryPolicy(ref: string): RetryPolicy | undefined {
    const escaped = ref.replace(/\./g, '\\.').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const pattern = new RegExp(`${escaped}\\s*=\\s*RetryPolicy\\s*\\(([\\s\\S]*?)\\)`, 'm');
    const m = this.source.match(pattern);
    if (!m) { return undefined; }
    const block = m[1];
    const rp: RetryPolicy = {};
    const ii = block.match(/initial_interval\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (ii) { rp.initialInterval = this.parseTdelta(ii[1]); }
    const bc = block.match(/backoff_coefficient\s*=\s*([\d.]+)/);
    if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
    const mi = block.match(/maximum_interval\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (mi) { rp.maximumInterval = this.parseTdelta(mi[1]); }
    const ma = block.match(/maximum_attempts\s*=\s*(\d+)/);
    if (ma) { rp.maximumAttempts = parseInt(ma[1], 10); }
    return Object.keys(rp).length > 0 ? rp : undefined;
  }

  private getNextMethodName(decoratorLine: number): string | undefined {
    for (let i = decoratorLine; i < Math.min(this.lines.length, decoratorLine + 3); i++) {
      const m = this.lines[i].match(/(?:async\s+)?def\s+(\w+)\s*\(/);
      if (m) { return m[1]; }
    }
    return undefined;
  }
}

interface ExceptBlock {
  start: number;
  end: number;
  errorType: string;
}

interface TryBlock {
  tryStart: number;
  tryEnd: number;
  exceptBlocks: ExceptBlock[];
}
