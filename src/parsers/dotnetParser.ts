import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

// try {      } catch (SomeException e) {
const CS_TRY   = /\btry\s*\{/;
const CS_CATCH = /\}\s*catch\s*\(\s*(\w+(?:\s*\|\s*\w+)*)(?:\s+\w+)?\s*\)/;
// Captures activity name from: => act.MethodAsync(  or  nameof(Acts.Method)  or  "MethodName"
const CS_ACT   = /(?:=>\s*\w+\.(\w+)\s*\(|nameof\s*\(\s*\w+\.(\w+)\s*\)|["'](\w+)["'])/;
const CS_THROW = /throw\s+new\s+(\w+(?:Exception)?)\s*\(/;

export class DotNetParser extends BaseParser {
  parse(): WorkflowModel | null {
    const hasAttr = /\[Workflow\]/.test(this.source);
    const classMatch = this.source.match(/public\s+class\s+(\w+)/);
    if (!classMatch || (!hasAttr && !/[Ww]orkflow/.test(classMatch[1]))) { return null; }
    const name = classMatch[1];

    const defaultOptions = this.parseActivityOptions();

    const tryCatchBlocks = this.findTryCatchBlocks(CS_TRY, CS_CATCH);
    const catchLines  = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap  = this.buildTryLineMap(tryCatchBlocks);

    const nodes: WorkflowNode[] = [];

    // ── Activity execution ─────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.ExecuteActivityAsync\s*\(/).forEach(({ line }) => {
      if (catchLines.has(line)) { return; }
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
      if (catchLines.has(line)) { return; }
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

    this.findAllLines(/\[WorkflowQuery(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/).forEach(({ line, match }) => {
      const qName = match[1] || this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', line });
      }
    });

    // ── Signal handlers ────────────────────────────────────────────────────

    this.findAllLines(/\[WorkflowSignal(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/).forEach(({ line, match }) => {
      const sName = match[1] || this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', line });
      }
    });

    // ── Update handlers ────────────────────────────────────────────────────

    this.findAllLines(/\[WorkflowUpdate(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/).forEach(({ line, match }) => {
      const uName = match[1] || this.getNextMethodName(line);
      if (uName) {
        nodes.push({ id: this.toId('update_' + uName), label: uName + ' (update)', kind: 'signal', line });
      }
    });

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.DelayAsync\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `delay_${line}`, label: 'DelayAsync', kind: 'timer', line });
      }
    });

    // ── Conditions ─────────────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.WaitConditionAsync\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `wait_cond_${line}`, label: 'WaitConditionAsync', kind: 'signal', line });
      }
    });

    // ── Parallel task composition ──────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.WhenAllAsync\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `when_all_${line}`, label: 'WhenAllAsync (parallel)', kind: 'sideEffect', line });
    });
    this.findAllLines(/await\s+Workflow\.WhenAnyAsync\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `when_any_${line}`, label: 'WhenAnyAsync (race)', kind: 'sideEffect', line });
    });

    // ── Versioning / Patching ─────────────────────────────────────────────

    this.findAllLines(/Workflow\.Patched\s*\(\s*["']([^'"]+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('patch_' + match[1], line), label: 'Patched: ' + match[1], kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow\.DeprecatePatch\s*\(\s*["']([^'"]+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'DeprecatePatch: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Side effects / randomness / UUIDs ─────────────────────────────────

    this.findAllLines(/Workflow\.NewGuid\s*\(\s*\)/).forEach(({ line }) => {
      nodes.push({ id: `new_guid_${line}`, label: 'NewGuid (deterministic)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/Workflow\.UpsertMemo\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_memo_${line}`, label: 'UpsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow\.UpsertTypedSearchAttributes\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_sa_${line}`, label: 'UpsertTypedSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.CreateContinueAsNewException\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `can_${line}`, label: 'ContinueAsNew', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/Workflow\.GetExternalWorkflowHandle\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `ext_wf_${line}`, label: 'GetExternalWorkflowHandle', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/await\s+Workflow\.ExecuteChildWorkflowAsync\s*(?:<(\w+)>)?\s*\(/).forEach(({ line, match }) => {
      const childName = match[1] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_' + childName, line), label: childName + ' (child)', kind: 'childWorkflow', line });
    });
    this.findAllLines(/await\s+Workflow\.StartChildWorkflowAsync\s*(?:<(\w+)(?:,\s*\w+)?>)?\s*\(/).forEach(({ line, match }) => {
      const childName = match[1] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_started_' + childName, line), label: childName + ' (child, started)', kind: 'childWorkflow', line });
    });

    // ── Nexus ──────────────────────────────────────────────────────────────

    this.findAllLines(/Workflow\.CreateNexusWorkflowClient\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `nexus_${line}`, label: 'CreateNexusWorkflowClient', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    return { name, language: 'csharp', filePath: this.filePath, nodes, defaultOptions };
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
