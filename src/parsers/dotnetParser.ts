import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

// try {      } catch (SomeException e) {
const CS_TRY   = /\btry\s*\{/;
const CS_CATCH = /\}\s*catch\s*\(\s*(\w+(?:\s*\|\s*\w+)*)(?:\s+\w+)?\s*\)/;
// Captures activity name from: => act.MethodAsync(  or  nameof(Acts.Method)  or  "MethodName"
const CS_ACT   = /(?:=>\s*\w+\.(\w+)\s*\(|nameof\s*\(\s*\w+\.(\w+)\s*\)|["'](\w+)["'])/;
const CS_THROW = /throw\s+new\s+(\w+(?:Exception)?)\s*\(/;

// Known Temporal/.NET SDK methods to exclude from helper detection
const CS_TEMPORAL_METHODS = new Set([
  'ExecuteActivityAsync', 'ExecuteLocalActivityAsync', 'DelayAsync', 'WaitConditionAsync',
  'WhenAllAsync', 'WhenAnyAsync', 'Patched', 'DeprecatePatch', 'NewGuid',
  'UpsertMemo', 'UpsertTypedSearchAttributes', 'CreateContinueAsNewException',
  'GetExternalWorkflowHandle', 'ExecuteChildWorkflowAsync', 'StartChildWorkflowAsync',
  'CreateNexusWorkflowClient',
  // C# built-ins
  'ToString', 'Equals', 'GetHashCode', 'GetType', 'Add', 'Remove', 'Contains',
  'Count', 'Clear', 'ToList', 'ToArray', 'Select', 'Where', 'Any', 'All',
  'First', 'FirstOrDefault', 'Single', 'SingleOrDefault',
  'Console', 'WriteLine', 'Write', 'Log', 'LogInformation', 'LogWarning', 'LogError',
]);

export class DotNetParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Find ALL workflow classes, parse each, return the best
    const entries = this.findAllWorkflowClasses();
    if (entries.length === 0) { return null; }

    let bestModel: WorkflowModel | null = null;
    for (const entry of entries) {
      const model = this.parseWorkflowClass(entry.name, entry.classBounds);
      if (model && (!bestModel || model.nodes.length > bestModel.nodes.length)) {
        bestModel = model;
      }
    }
    return bestModel;
  }

  private findAllWorkflowClasses(): Array<{ name: string; classBounds: { start: number; end: number } }> {
    const results: Array<{ name: string; classBounds: { start: number; end: number } }> = [];

    for (let i = 0; i < this.lines.length; i++) {
      const hasAttr = i > 0 && /\[Workflow\]/.test(this.lines[i - 1]);
      const m = this.lines[i].match(/public\s+class\s+(\w+)/);
      if (!m || (!hasAttr && !/[Ww]orkflow/.test(m[1]))) { continue; }

      const bounds = this.findBraceFunctionBounds(/public\s+class\s+\w+/, i, this.lines.length);
      if (bounds) {
        results.push({ name: m[1], classBounds: bounds });
        i = bounds.end;
      }
    }
    if (results.length === 0) {
      // Fallback
      const hasAttr = /\[Workflow\]/.test(this.source);
      const classMatch = this.source.match(/public\s+class\s+(\w+)/);
      if (classMatch && (hasAttr || /[Ww]orkflow/.test(classMatch[1]))) {
        results.push({ name: classMatch[1], classBounds: { start: 1, end: this.lines.length } });
      }
    }
    return results;
  }

  private parseWorkflowClass(
    name: string,
    classBounds: { start: number; end: number }
  ): WorkflowModel | null {
    const defaultOptions = this.parseActivityOptions();

    const wfMethodRange = this.findWorkflowRunRange(classBounds);

    const tryCatchBlocks = this.findTryCatchBlocks(CS_TRY, CS_CATCH);
    const catchLines  = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap  = this.buildTryLineMap(tryCatchBlocks);

    const nodes: WorkflowNode[] = [];

    /** Helper: true when a 1-based line is inside the workflow run method */
    const inWfMethod = (line: number) =>
      !wfMethodRange || (line >= wfMethodRange.start && line <= wfMethodRange.end);

    // ── Helper function detection + inlining ──────────────────────────────
    const helperRegions = wfMethodRange
      ? this.collectHelperRegionsBrace(
          wfMethodRange,
          /(?:await\s+)?(?:this\.)?(\w+)\s*\(/,
          CS_TEMPORAL_METHODS,
          (methodName) => this.findCsMethodBounds(methodName, classBounds),
        )
      : [];

    for (const hr of helperRegions) {
      nodes.push({
        id: this.toId('fn_' + hr.methodName, hr.callSiteLine),
        label: hr.methodName + '()',
        kind: 'functionCall',
        role: 'flow',
        line: hr.callSiteLine,
      });
    }

    for (const hr of helperRegions) {
      const helperNodes = this.scanHelperForPrimitives(hr.bounds, [
        { pattern: /await\s+Workflow\.ExecuteActivityAsync\s*\(/, nodeFactory: (line) => {
          const methodName = this.extractActivityMethodName(line);
          return {
            id: this.toId(methodName || 'activity', line),
            label: (methodName || 'Activity').replace(/Async$/, ''),
            kind: 'activity' as const, line,
            options: defaultOptions ? { ...defaultOptions } : undefined,
          };
        } },
        { pattern: /await\s+Workflow\.ExecuteLocalActivityAsync\s*\(/, nodeFactory: (line) => {
          const methodName = this.extractActivityMethodName(line) || 'LocalActivity';
          return {
            id: this.toId('local_' + methodName, line),
            label: methodName.replace(/Async$/, '') + ' (local)',
            kind: 'activity' as const, line,
          };
        } },
        { pattern: /await\s+Workflow\.DelayAsync\s*\(/, nodeFactory: (line) => ({
          id: `delay_${line}`, label: 'DelayAsync', kind: 'timer' as const, line,
        }) },
        { pattern: /await\s+Workflow\.WaitConditionAsync\s*\(/, nodeFactory: (line) => ({
          id: `wait_cond_${line}`, label: 'WaitConditionAsync', kind: 'condition' as const, line,
        }) },
        { pattern: /await\s+Workflow\.ExecuteChildWorkflowAsync\s*(?:<(\w+)>)?\s*\(/, nodeFactory: (line, match) => ({
          id: this.toId('child_' + (match[1] || 'ChildWorkflow'), line),
          label: (match[1] || 'ChildWorkflow') + ' (child)',
          kind: 'childWorkflow' as const, line,
        }) },
        { pattern: /Workflow\.CreateContinueAsNewException\s*(?:<[^>]+>)?\s*\(/, nodeFactory: (line) => ({
          id: `can_${line}`, label: 'ContinueAsNew', kind: 'sideEffect' as const, line,
        }) },
      ]);
      this.applyVirtualLines(helperNodes, hr.callSiteLine);
      nodes.push(...helperNodes);
    }

    // ── Activity execution ─────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.ExecuteActivityAsync\s*\(/).forEach(({ line }) => {
      if (catchLines.has(line) || !inWfMethod(line)) { return; }
      const methodName = this.extractActivityMethodName(line);
      if (!methodName) { return; }
      const tb = tryLineMap.get(line);
      const errorBranches = tb
        ? this.buildErrorBranchesFromCatch(tb, CS_ACT, CS_THROW)
        : undefined;
      nodes.push({
        id: this.toId(methodName, line),
        label: methodName.replace(/Async$/, ''),
        kind: 'activity',
        line,
        options: defaultOptions ? { ...defaultOptions } : undefined,
        errorBranches: errorBranches?.length ? errorBranches : undefined,
      });
    });

    // Local activities
    this.findAllLines(/await\s+Workflow\.ExecuteLocalActivityAsync\s*\(/).forEach(({ line }) => {
      if (catchLines.has(line) || !inWfMethod(line)) { return; }
      const methodName = this.extractActivityMethodName(line) || 'LocalActivity';
      const tb = tryLineMap.get(line);
      const errorBranches = tb
        ? this.buildErrorBranchesFromCatch(tb, CS_ACT, CS_THROW)
        : undefined;
      nodes.push({
        id: this.toId('local_' + methodName, line),
        label: methodName.replace(/Async$/, '') + ' (local)',
        kind: 'activity',
        line,
        options: defaultOptions ? { ...defaultOptions } : undefined,
        errorBranches: errorBranches?.length ? errorBranches : undefined,
      });
    });

    // ── Query handlers ─────────────────────────────────────────────────────

    this.findAllLinesInBounds(/\[WorkflowQuery(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/, classBounds).forEach(({ line, match }) => {
      const qName = match[1] || this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', role: 'query-handler', line });
      }
    });

    // ── Signal handlers ────────────────────────────────────────────────────

    this.findAllLinesInBounds(/\[WorkflowSignal(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/, classBounds).forEach(({ line, match }) => {
      const sName = match[1] || this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', role: 'signal-handler', line });
      }
    });

    // ── Update handlers ────────────────────────────────────────────────────

    this.findAllLinesInBounds(/\[WorkflowUpdate(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/, classBounds).forEach(({ line, match }) => {
      const uName = match[1] || this.getNextMethodName(line);
      if (uName) {
        nodes.push({ id: this.toId('update_' + uName), label: uName + ' (update)', kind: 'signal', role: 'signal-handler', line });
      }
    });

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.DelayAsync\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `delay_${line}`, label: 'DelayAsync', kind: 'timer', line });
      }
    });

    // ── Conditions ─────────────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.WaitConditionAsync\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfMethod(line)) {
        nodes.push({ id: `wait_cond_${line}`, label: 'WaitConditionAsync', kind: 'condition', line });
      }
    });

    // ── Parallel task composition ──────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.WhenAllAsync\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `when_all_${line}`, label: 'WhenAllAsync (parallel)', kind: 'sideEffect', line });
    });
    this.findAllLines(/await\s+Workflow\.WhenAnyAsync\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `when_any_${line}`, label: 'WhenAnyAsync (race)', kind: 'sideEffect', line });
    });

    // ── Versioning / Patching ─────────────────────────────────────────────

    this.findAllLines(/Workflow\.Patched\s*\(\s*["']([^'"]+)["']/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('patch_' + match[1], line), label: 'Patched: ' + match[1], kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow\.DeprecatePatch\s*\(\s*["']([^'"]+)["']/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'DeprecatePatch: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Side effects / randomness / UUIDs ─────────────────────────────────

    this.findAllLines(/Workflow\.NewGuid\s*\(\s*\)/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `new_guid_${line}`, label: 'NewGuid (deterministic)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/Workflow\.UpsertMemo\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `upsert_memo_${line}`, label: 'UpsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow\.UpsertTypedSearchAttributes\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `upsert_sa_${line}`, label: 'UpsertTypedSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.CreateContinueAsNewException\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `can_${line}`, label: 'ContinueAsNew', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/Workflow\.GetExternalWorkflowHandle\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `ext_wf_${line}`, label: 'GetExternalWorkflowHandle', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.ExecuteChildWorkflowAsync\s*(?:<(\w+)>)?\s*\(/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      const childName = match[1] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_' + childName, line), label: childName + ' (child)', kind: 'childWorkflow', line });
    });
    this.findAllLines(/await\s+Workflow\.StartChildWorkflowAsync\s*(?:<(\w+)(?:,\s*\w+)?>)?\s*\(/).forEach(({ line, match }) => {
      if (!inWfMethod(line)) { return; }
      const childName = match[1] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_started_' + childName, line), label: childName + ' (child, started)', kind: 'childWorkflow', line });
    });

    // ── Nexus ──────────────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.CreateNexusWorkflowClient\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      if (!inWfMethod(line)) { return; }
      nodes.push({ id: `nexus_${line}`, label: 'CreateNexusWorkflowClient', kind: 'nexus', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    const loopAnchorId = this.detectInfiniteLoopAnchor(wfMethodRange, nodes);
    return { name, language: 'csharp', filePath: this.filePath, nodes, defaultOptions, loopAnchorId };
  }

  private findCsMethodBounds(name: string, classBounds: { start: number; end: number }): { start: number; end: number } | null {
    const pat = new RegExp(`(?:private|protected|public|internal)\\s+(?:async\\s+)?\\S+\\s+${name}\\s*\\(`);
    return this.findBraceFunctionBounds(pat, classBounds.start - 1, classBounds.end);
  }

  /**
   * Detect whether the workflow has an actual infinite loop
   * (`while(true)` / `for(;;)`) wrapping a WaitConditionAsync call.
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
   * Find the 1-based line range of the [WorkflowRun] method body.
   * Returns null if not found (falls back to scanning the whole file).
   */
  private findWorkflowRunRange(searchBounds?: { start: number; end: number }): { start: number; end: number } | null {
    const searchStart = searchBounds ? searchBounds.start - 1 : 0;
    const searchEnd = searchBounds ? Math.min(this.lines.length, searchBounds.end) : this.lines.length;
    let annoIdx = -1;
    for (let i = searchStart; i < searchEnd; i++) {
      if (/\[WorkflowRun\]/.test(this.lines[i])) { annoIdx = i; break; }
    }
    if (annoIdx < 0) { return null; }

    // Find the method signature after the annotation
    let methodIdx = -1;
    for (let i = annoIdx + 1; i < Math.min(this.lines.length, annoIdx + 5); i++) {
      if (/(?:public|protected|private|internal)\s+(?:async\s+)?(?:Task|ValueTask)/.test(this.lines[i])) {
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

  private extractActivityMethodName(callLine: number): string | undefined {
    const lines: string[] = [];
    let depth = 0;
    for (let i = callLine - 1; i < Math.min(this.lines.length, callLine + 5); i++) {
      const l = this.lines[i];
      depth += (l.match(/\(/g) || []).length;
      depth -= (l.match(/\)/g) || []).length;
      lines.push(l);
      if (depth === 0 && lines.length > 1) { break; }
    }
    const text = lines.join(' ');

    // Lambda form: => acts.MethodAsync(
    const m1 = text.match(/=>\s*\w+\.(\w+)\s*\(/);
    if (m1) { return m1[1]; }

    // nameof(Acts.Method)
    const m2 = text.match(/nameof\s*\(\s*\w+\.(\w+)\s*\)/);
    if (m2) { return m2[1]; }

    // String literal: ExecuteActivityAsync("MethodName", ...)
    const m3 = text.match(/ExecuteActivityAsync\s*(?:<[^>]+>)?\s*\(\s*["'](\w+)["']/);
    if (m3) { return m3[1]; }

    return undefined;
  }

  private parseActivityOptions(): ActivityOptions | undefined {
    const blockStart = this.findLine(/new\s+ActivityOptions\s*\{/);
    if (blockStart < 0) { return undefined; }
    const block = this.extractBlock(blockStart, 20);
    const opts: ActivityOptions = {};

    const stc = block.match(/StartToCloseTimeout\s*=\s*TimeSpan\.From(Seconds?|Minutes?|Hours?)\s*\(\s*([\d.]+)\s*\)/);
    if (stc) {
      const unit = stc[1].toLowerCase().startsWith('second') ? 's' : stc[1].toLowerCase().startsWith('minute') ? 'm' : 'h';
      opts.startToCloseTimeout = stc[2] + unit;
    }

    const sc = block.match(/ScheduleToCloseTimeout\s*=\s*TimeSpan\.From(Seconds?|Minutes?|Hours?)\s*\(\s*([\d.]+)\s*\)/);
    if (sc) {
      const unit = sc[1].toLowerCase().startsWith('second') ? 's' : sc[1].toLowerCase().startsWith('minute') ? 'm' : 'h';
      opts.scheduleToCloseTimeout = sc[2] + unit;
    }

    const retryBlockMatch = block.match(/RetryPolicy\s*=\s*new\s+RetryPolicy\s*\{([\s\S]*?)\}/);
    if (retryBlockMatch) {
      const rp: RetryPolicy = {};
      const ii = retryBlockMatch[1].match(/InitialInterval\s*=\s*TimeSpan\.From(Seconds?|Millis?)\s*\(\s*([\d.]+)\s*\)/);
      if (ii) { rp.initialInterval = ii[2] + (ii[1].toLowerCase().startsWith('milli') ? 'ms' : 's'); }
      const bc = retryBlockMatch[1].match(/BackoffCoefficient\s*=\s*([\d.]+)/);
      if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
      const mi = retryBlockMatch[1].match(/MaximumInterval\s*=\s*TimeSpan\.From(Seconds?|Minutes?)\s*\(\s*([\d.]+)\s*\)/);
      if (mi) { rp.maximumInterval = mi[2] + (mi[1].toLowerCase().startsWith('second') ? 's' : 'm'); }
      const ma = retryBlockMatch[1].match(/MaximumAttempts\s*=\s*(\d+)/);
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
