import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode } from '../types';

// try {      } catch (SomeException $e) {   or multi-catch SomeException|Other $e
const PHP_TRY   = /\btry\s*\{/;
const PHP_CATCH = /\}\s*catch\s*\(\s*(\w+(?:\|\w+)*)\s+\$\w+\s*\)/;
// Activity call pattern: yield $this->anyStub->method( or yield $anyVar->method(
const PHP_ACT   = /yield\s+\$(?:this->\w+|\w+)->(\w+)\s*\(/;
const PHP_THROW = /throw\s+new\s+(\w+(?:Exception)?)\s*\(/;

export class PhpParser extends BaseParser {
  parse(): WorkflowModel | null {
    const classMatch = this.source.match(/class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+WorkflowInterface/);
    if (!classMatch) {
      const attrMatch = this.source.match(/(?:#\[WorkflowInterface\]|@WorkflowInterface)[\s\S]*?class\s+(\w+)/);
      if (!attrMatch) { return null; }
      return this.buildModel(attrMatch[1]);
    }
    return this.buildModel(classMatch[1]);
  }

  private buildModel(name: string): WorkflowModel {
    const nodes: WorkflowNode[] = [];

    // Find the #[WorkflowMethod] / @WorkflowMethod entry point body so we only
    // pick up flow nodes inside it, not from private helper methods.
    const wfMethodRange = this.findWorkflowMethodRange();

    const tryCatchBlocks = this.findTryCatchBlocks(PHP_TRY, PHP_CATCH);
    const catchLines  = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap  = this.buildTryLineMap(tryCatchBlocks);

    /** Helper: true when a 1-based line is inside the workflow method body */
    const inWfMethod = (line: number) =>
      !wfMethodRange || (line >= wfMethodRange.start && line <= wfMethodRange.end);

    // ── Activity calls ─────────────────────────────────────────────────────

    // yield $this->stub->methodName(...) or yield $localVar->method(...)
    this.findAllLines(/yield\s+\$(?:this->\w+|\w+)->(\w+)\s*\(/).forEach(({ line, match }) => {
      if (catchLines.has(line) || !inWfMethod(line)) { return; }
      const tb = tryLineMap.get(line);
      const errorBranches = tb
        ? this.buildErrorBranchesFromCatch(tb, PHP_ACT, PHP_THROW)
        : undefined;
      nodes.push({
        id: this.toId(match[1], line),
        label: match[1],
        kind: 'activity',
        line,
        errorBranches: errorBranches?.length ? errorBranches : undefined,
      });
    });

    // Workflow::executeActivity (untyped direct execution)
    this.findAllLines(/Workflow::executeActivity\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      if (catchLines.has(line) || !inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('act_' + match[1], line), label: match[1], kind: 'activity', line });
    });

    // ── Signal handlers ────────────────────────────────────────────────────

    // @SignalMethod or #[SignalMethod] (PHP 8 attribute)
    this.findAllLines(/#\[SignalMethod[^\]]*\]|@SignalMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('signal_' + methodName), label: methodName + ' (signal)', kind: 'signal', role: 'signal-handler', line });
      }
    });
    // Dynamic signal handler registration
    this.findAllLines(/Workflow::registerSignal\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_dyn_' + match[1], line), label: match[1] + ' (signal, dynamic)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLines(/Workflow::registerDynamicSignal\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `signal_dynamic_${line}`, label: 'dynamic signal handler', kind: 'signal', role: 'signal-handler', line });
    });

    // ── Query handlers ─────────────────────────────────────────────────────

    // @QueryMethod or #[QueryMethod] (PHP 8 attribute)
    this.findAllLines(/#\[QueryMethod[^\]]*\]|@QueryMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('query_' + methodName), label: methodName + ' (query)', kind: 'query', role: 'query-handler', line });
      }
    });
    this.findAllLines(/Workflow::registerQuery\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_dyn_' + match[1], line), label: match[1] + ' (query, dynamic)', kind: 'query', role: 'query-handler', line });
    });
    this.findAllLines(/Workflow::registerDynamicQuery\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `query_dynamic_${line}`, label: 'dynamic query handler', kind: 'query', role: 'query-handler', line });
    });

    // ── Update handlers ────────────────────────────────────────────────────

    this.findAllLines(/#\[UpdateMethod[^\]]*\]|@UpdateMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('update_' + methodName), label: methodName + ' (update)', kind: 'signal', role: 'signal-handler', line });
      }
    });
    this.findAllLines(/Workflow::registerUpdate\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('update_dyn_' + match[1], line), label: match[1] + ' (update, dynamic)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLines(/Workflow::registerDynamicUpdate\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `update_dynamic_${line}`, label: 'dynamic update handler', kind: 'signal', role: 'signal-handler', line });
    });

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/(?:Workflow::timer|yield\s+Workflow::timer)\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `timer_${line}`, label: 'timer', kind: 'timer', line });
      }
    });

    // ── Conditions & waiting ──────────────────────────────────────────────

    this.findAllLines(/Workflow::await\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `await_cond_${line}`, label: 'Workflow::await (condition)', kind: 'condition', line });
      }
    });
    this.findAllLines(/Workflow::awaitWithTimeout\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `await_timeout_${line}`, label: 'awaitWithTimeout', kind: 'condition', line });
      }
    });

    // ── Side effects ───────────────────────────────────────────────────────

    this.findAllLines(/Workflow::sideEffect\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `side_effect_${line}`, label: 'sideEffect', kind: 'sideEffect', line });
    });

    // ── Versioning ─────────────────────────────────────────────────────────

    this.findAllLines(/Workflow::getVersion\s*\(\s*['"]([^'"]+)["']/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('version_' + match[1], line), label: 'getVersion: ' + match[1], kind: 'sideEffect', line });
    });

    // ── UUIDs ──────────────────────────────────────────────────────────────

    this.findAllLines(/Workflow::uuid4\s*\(|Workflow::uuid7\s*\(|Workflow::uuid\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `uuid_${line}`, label: 'uuid (deterministic)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/Workflow::upsertMemo\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow::upsertSearchAttributes\s*\(|Workflow::upsertTypedSearchAttributes\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsertSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    // Via stub: $this->newContinueAsNewStub()->method(...)
    this.findAllLines(/Workflow::newContinueAsNewStub\s*\(|continueAsNew\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `can_${line}`, label: 'continueAsNew', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/Workflow::newExternalWorkflowStub\s*\(|Workflow::newUntypedExternalWorkflowStub\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `ext_wf_${line}`, label: 'newExternalWorkflowStub', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/Workflow::newChildWorkflowStub\s*\(\s*(\w+)::class|Workflow::newUntypedChildWorkflowStub\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      const childName = match[1] || match[2] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_' + childName, line), label: childName + ' (child)', kind: 'childWorkflow', line });
    });
    this.findAllLines(/Workflow::executeChildWorkflow\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('child_exec_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    // ── Async coroutine scopes ─────────────────────────────────────────────

    this.findAllLines(/Workflow::async\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `async_scope_${line}`, label: 'Workflow::async (coroutine)', kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow::asyncDetached\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `async_detached_${line}`, label: 'Workflow::asyncDetached', kind: 'sideEffect', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    // Loop anchor: only set when there is an actual infinite loop
    // (`while(true)` / `for(;;)`) wrapping a Workflow::await call.
    const loopAnchorId = this.detectInfiniteLoopAnchor(wfMethodRange, nodes);
    return { name, language: 'php', filePath: this.filePath, nodes, loopAnchorId };
  }

  /**
   * Detect whether the workflow has an actual infinite loop
   * (`while(true)` / `for(;;)`) wrapping a Workflow::await call.
   */
  private detectInfiniteLoopAnchor(
    wfRange: { start: number; end: number } | null,
    nodes: WorkflowNode[]
  ): string | undefined {
    const start = wfRange ? wfRange.start - 1 : 0;
    const end = wfRange ? wfRange.end : this.lines.length;
    for (let i = start; i < end && i < this.lines.length; i++) {
      const l = this.lines[i];
      const isInfiniteLoop =
        /\bwhile\s*\(\s*true\s*\)/.test(l) ||
        /\bfor\s*\(\s*;\s*;\s*\)/.test(l);
      if (!isInfiniteLoop) { continue; }

      let openIdx = i;
      while (openIdx < this.lines.length && !this.lines[openIdx].includes('{')) { openIdx++; }
      if (openIdx >= this.lines.length) { continue; }

      let depth = 0;
      let blockEnd = openIdx;
      for (let j = openIdx; j < this.lines.length; j++) {
        depth += (this.lines[j].match(/\{/g) || []).length;
        depth -= (this.lines[j].match(/\}/g) || []).length;
        if (depth === 0 && j > openIdx) { blockEnd = j + 1; break; }
      }

      const bodyStart = openIdx + 2;
      const bodyEnd = blockEnd;

      const anchorNode = nodes.find(
        n => (!n.role || n.role === 'flow') && n.kind === 'condition' &&
             n.line >= bodyStart && n.line <= bodyEnd
      );
      if (anchorNode) { return anchorNode.id; }
    }
    return undefined;
  }

  /**
   * Find the 1-based line range of the #[WorkflowMethod] / @WorkflowMethod body.
   * Returns null if not found (falls back to scanning the whole file).
   */
  private findWorkflowMethodRange(): { start: number; end: number } | null {
    const annoIdx = this.lines.findIndex(l => /#\[WorkflowMethod[^\]]*\]|@WorkflowMethod/.test(l));
    if (annoIdx < 0) { return null; }

    // Find the function signature after the annotation
    let methodIdx = -1;
    for (let i = annoIdx + 1; i < Math.min(this.lines.length, annoIdx + 5); i++) {
      if (/(?:public|protected|private)\s+function\s+\w+\s*\(/.test(this.lines[i])) {
        methodIdx = i;
        break;
      }
    }
    if (methodIdx < 0) { return null; }

    let depth = 0;
    let started = false;
    for (let i = methodIdx; i < this.lines.length; i++) {
      const opens = (this.lines[i].match(/\{/g) || []).length;
      const closes = (this.lines[i].match(/\}/g) || []).length;
      depth += opens - closes;
      if (opens > 0 && !started) { started = true; }
      if (started && depth <= 0) {
        return { start: methodIdx + 1, end: i + 1 }; // 1-based
      }
    }
    return { start: methodIdx + 1, end: this.lines.length };
  }

  private getNextPhpMethodName(annotationLine: number): string | undefined {
    for (let i = annotationLine; i < Math.min(this.lines.length, annotationLine + 4); i++) {
      const m = this.lines[i].match(/(?:public|protected|private)\s+function\s+(\w+)\s*\(/);
      if (m) { return m[1]; }
    }
    return undefined;
  }
}
