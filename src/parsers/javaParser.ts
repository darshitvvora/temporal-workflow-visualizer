import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

// try {      } catch (SomeException e) {    or   } catch (A | B e) {
const JAVA_TRY   = /\btry\s*\{/;
const JAVA_CATCH = /\}\s*catch\s*\((?:[\w|]+\s+(\w+)|(\w+))\s*\)/;
const JAVA_THROW = /throw\s+new\s+(\w+(?:Exception|Error)?)\s*\(/;

export class JavaParser extends BaseParser {
  parse(): WorkflowModel | null {
    const classMatch = this.source.match(/public\s+class\s+(\w+)\s+implements\s+\w*[Ww]orkflow/);
    if (!classMatch) { return null; }
    const name = classMatch[1].replace(/Impl$/, '');

    const defaultOptions = this.parseActivityOptions();
    const stubVars = this.findActivityStubVars();

    // Find the @WorkflowMethod body so we only pick up flow nodes inside it,
    // not from private helper methods that may call Workflow.* primitives.
    const wfMethodRange = this.findWorkflowMethodRange();

    const tryCatchBlocks = this.findTryCatchBlocks(JAVA_TRY, JAVA_CATCH);
    const catchLines  = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap  = this.buildTryLineMap(tryCatchBlocks);

    // Activity pattern inside catch: stubVar.methodName(
    const actPat = new RegExp(`(?:${stubVars.join('|')})\\.(\\w+)\\s*\\(`);

    const nodes: import('../types').WorkflowNode[] = [];

    /** Helper: true when a 1-based line is inside the workflow method body */
    const inWfMethod = (line: number) =>
      !wfMethodRange || (line >= wfMethodRange.start && line <= wfMethodRange.end);

    // ── Activity calls via stubs ───────────────────────────────────────────

    for (const stubVar of stubVars) {
      this.findAllLines(new RegExp(`\\b${stubVar}\\.(\\w+)\\s*\\(`)).forEach(({ line, match }) => {
        if (catchLines.has(line) || !inWfMethod(line)) { return; }
        const methodName = match[1].replace(/Async$/, '');
        const tb = tryLineMap.get(line);
        const errorBranches = tb
          ? this.buildErrorBranchesFromCatch(tb, actPat, JAVA_THROW)
          : undefined;
        nodes.push({
          id: this.toId(methodName, line),
          label: methodName,
          kind: 'activity' as const,
          line,
          options: defaultOptions ? { ...defaultOptions } : undefined,
          errorBranches: errorBranches?.length ? errorBranches : undefined,
        });
      });
    }

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.sleep\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer' as const, line });
      }
    });

    // ── Conditions ─────────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.await\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `await_cond_${line}`, label: 'Workflow.await (condition)', kind: 'condition' as const, line });
      }
    });

    // ── Query handlers ─────────────────────────────────────────────────────
    // Signal/query/update handlers are separate methods — do NOT scope to wfMethodRange.

    this.findAllLines(/@WorkflowQuery/).forEach(({ line }) => {
      const methodName = this.getNextMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('query_' + methodName), label: methodName + ' (query)', kind: 'query' as const, role: 'query-handler' as const, line });
      }
    });

    // ── Signal handlers ────────────────────────────────────────────────────

    this.findAllLines(/@WorkflowSignal/).forEach(({ line }) => {
      const methodName = this.getNextMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('signal_' + methodName), label: methodName + ' (signal)', kind: 'signal' as const, role: 'signal-handler' as const, line });
      }
    });

    // ── Update handlers ────────────────────────────────────────────────────

    this.findAllLines(/@WorkflowUpdateHandler/).forEach(({ line }) => {
      const methodName = this.getNextMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('update_' + methodName), label: methodName + ' (update)', kind: 'signal' as const, role: 'signal-handler' as const, line });
      }
    });

    // ── Versioning ─────────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.getVersion\s*\(\s*"([^"]+)"/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('version_' + match[1], line), label: 'getVersion: ' + match[1], kind: 'sideEffect' as const, line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.continueAsNew\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `can_${line}`, label: 'continueAsNew', kind: 'sideEffect' as const, line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/Workflow\.upsertMemo\s*\(|Workflow\.upsertTypedMemo\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsertMemo', kind: 'sideEffect' as const, line });
    });
    this.findAllLines(/Workflow\.upsertSearchAttributes\s*\(|Workflow\.upsertTypedSearchAttributes\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsertSearchAttributes', kind: 'sideEffect' as const, line });
    });

    // ── Parallel execution (Promise.allOf) ────────────────────────────────

    this.findAllLines(/Promise\.allOf\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `promise_allof_${line}`, label: 'Promise.allOf (parallel)', kind: 'sideEffect' as const, line });
    });
    this.findAllLines(/Promise\.anyOf\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `promise_anyof_${line}`, label: 'Promise.anyOf (race)', kind: 'sideEffect' as const, line });
    });

    // ── External workflow communication ────────────────────────────────────

    this.findAllLines(/Workflow\.newExternalWorkflowStub\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `ext_wf_${line}`, label: 'newExternalWorkflowStub', kind: 'childWorkflow' as const, line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.newChildWorkflowStub\s*\(\s*(\w+)\.class/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow' as const, line });
    });

    nodes.sort((a, b) => a.line - b.line);
    // Loop anchor: only set when there is an actual infinite loop
    // (`while(true)` / `for(;;)`) wrapping a Workflow.await() call.
    const loopAnchorId = this.detectInfiniteLoopAnchor(wfMethodRange, nodes);
    return { name, language: 'java', filePath: this.filePath, nodes, defaultOptions, loopAnchorId };
  }

  /**
   * Detect whether the workflow has an actual infinite loop
   * (`while(true)` / `for(;;)`) wrapping a Workflow.await() call.
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

  private findActivityStubVars(): string[] {
    const vars: string[] = [];
    // Matches any combination of modifiers (private, public, protected, final, static)
    // before the type and variable name:
    //   private final MyActivities acts = Workflow.newActivityStub(
    //   MyActivities acts = Workflow.newActivityStub(
    this.findAllLines(
      /(?:(?:private|public|protected|final|static)\s+)*(\w+)\s+(\w+)\s*=\s*Workflow\.newActivityStub\s*\(/
    ).forEach(({ match }) => {
      // match[1] = type, match[2] = variable name
      if (match[2]) { vars.push(match[2]); }
    });
    return vars.length > 0 ? vars : ['activities'];
  }

  /**
   * Find the 1-based line range of the @WorkflowMethod body.
   * Returns null if not found (falls back to scanning the whole file).
   */
  private findWorkflowMethodRange(): { start: number; end: number } | null {
    const annoIdx = this.lines.findIndex(l => /@WorkflowMethod/.test(l));
    if (annoIdx < 0) { return null; }

    // Find the method signature after the annotation
    let methodIdx = -1;
    for (let i = annoIdx + 1; i < Math.min(this.lines.length, annoIdx + 5); i++) {
      if (/(?:public|protected|private)\s+\S+\s+\w+\s*\(/.test(this.lines[i])) {
        methodIdx = i;
        break;
      }
    }
    // If annotation is on the same line as the method
    if (methodIdx < 0 && /(?:public|protected|private)\s+\S+\s+\w+\s*\(/.test(this.lines[annoIdx])) {
      methodIdx = annoIdx;
    }
    if (methodIdx < 0) { return null; }

    // Find the opening brace and then the matching closing brace
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

  private parseActivityOptions(): ActivityOptions | undefined {
    const builderStart = this.findLine(/ActivityOptions\.newBuilder\s*\(\s*\)/);
    if (builderStart < 0) { return undefined; }
    const block = this.extractBlock(builderStart, 30);
    const opts: ActivityOptions = {};

    const stc = block.match(/setStartToCloseTimeout\s*\(\s*Duration\.of(Seconds?|Minutes?|Hours?)\s*\(\s*(\d+)\s*\)/);
    if (stc) {
      opts.startToCloseTimeout = stc[2] + (stc[1].toLowerCase().startsWith('second') ? 's' : stc[1].toLowerCase().startsWith('minute') ? 'm' : 'h');
    }
    const sc = block.match(/setScheduleToCloseTimeout\s*\(\s*Duration\.of(Seconds?|Minutes?|Hours?)\s*\(\s*(\d+)\s*\)/);
    if (sc) {
      opts.scheduleToCloseTimeout = sc[2] + (sc[1].toLowerCase().startsWith('second') ? 's' : sc[1].toLowerCase().startsWith('minute') ? 'm' : 'h');
    }

    const retryBlock = block.match(/setRetryOptions\s*\(([\s\S]*?)\)/);
    if (retryBlock) {
      const rp: RetryPolicy = {};
      const ii = retryBlock[1].match(/setInitialInterval\s*\(\s*Duration\.of(?:Seconds?|Millis?)\s*\(\s*(\d+)\s*\)/);
      if (ii) { rp.initialInterval = ii[1] + 's'; }
      const bc = retryBlock[1].match(/setBackoffCoefficient\s*\(\s*([\d.]+)\s*\)/);
      if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
      const mi = retryBlock[1].match(/setMaximumInterval\s*\(\s*Duration\.of(?:Seconds?|Minutes?)\s*\(\s*(\d+)\s*\)/);
      if (mi) { rp.maximumInterval = mi[1] + 's'; }
      const ma = retryBlock[1].match(/setMaximumAttempts\s*\(\s*(\d+)\s*\)/);
      if (ma) { rp.maximumAttempts = parseInt(ma[1], 10); }
      if (Object.keys(rp).length > 0) { opts.retryPolicy = rp; }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  private getNextMethodName(annotationLine: number): string | undefined {
    for (let i = annotationLine; i < Math.min(this.lines.length, annotationLine + 4); i++) {
      const m = this.lines[i].match(/(?:public|protected|private)\s+\S+\s+(\w+)\s*\(/);
      if (m) { return m[1]; }
    }
    return undefined;
  }
}
