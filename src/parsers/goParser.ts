import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, ErrorBranch } from '../types';

export class GoParser extends BaseParser {
  parse(): WorkflowModel | null {
    const wfMatch = this.source.match(/func\s+(\w+)\s*\(ctx workflow\.Context/);
    if (!wfMatch) { return null; }
    const name = wfMatch[1];

    // Determine the line range of the workflow function body so we only
    // parse nodes that belong to it (ignoring helper functions).
    const wfRange = this.findWorkflowFuncRange(wfMatch[0]);

    // Build a set of lines inside `if err != nil { ... }` blocks so we can
    // exclude compensation / rollback activities from the main flow.
    const errBlockLines = this.buildErrBlockLineSet(wfRange);

    const defaultOptions = this.parseActivityOptions();
    const nodes: WorkflowNode[] = [];

    /** Helper: true when a 1-based line is inside the workflow function */
    const inWf = (line: number) =>
      wfRange.start <= line && line <= wfRange.end;

    /** Helper: true when a 1-based line is inside an `if err != nil` block */
    const inErrBlock = (line: number) => errBlockLines.has(line);

    // ── Activities ──────────────────────────────────────────────────────────

    // ExecuteActivity
    this.findAllLines(/workflow\.ExecuteActivity\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      if (!inWf(line) || inErrBlock(line)) { return; }
      const errorBranch = this.detectGoErrorBranch(line);
      nodes.push({
        id: this.toId(match[1], line),
        label: match[1],
        kind: 'activity',
        line,
        options: defaultOptions ? { ...defaultOptions } : undefined,
        errorBranches: errorBranch ? [errorBranch] : undefined,
      });
    });

    // ExecuteLocalActivity
    this.findAllLines(/workflow\.ExecuteLocalActivity\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      if (!inWf(line) || inErrBlock(line)) { return; }
      const errorBranch = this.detectGoErrorBranch(line);
      nodes.push({
        id: this.toId('local_' + match[1], line),
        label: match[1] + ' (local)',
        kind: 'localActivity',
        line,
        options: defaultOptions ? { ...defaultOptions } : undefined,
        errorBranches: errorBranch ? [errorBranch] : undefined,
      });
    });

    // ── Query handlers ────────────────────────────────────────────────────

    this.findAllLines(/workflow\.SetQueryHandler\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', role: 'query-handler', line });
    });
    this.findAllLines(/workflow\.SetQueryHandlerWithOptions\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', role: 'query-handler', line });
    });
    this.findAllLines(/SetQueryHandlerFor(\w+)\s*\(/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', role: 'query-handler', line });
    });

    // ── Signal channels ────────────────────────────────────────────────────

    this.findAllLines(/workflow\.GetSignalChannel\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLines(/workflow\.GetSignalChannelWithOptions\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', role: 'signal-handler', line });
    });

    // SignalExternalWorkflow — sent TO another workflow, stays in flow
    this.findAllLines(/workflow\.SignalExternalWorkflow\s*\(\s*ctx,/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `signal_ext_${line}`, label: 'SignalExternalWorkflow', kind: 'signal', role: 'flow', line });
    });

    // ── Update handlers ────────────────────────────────────────────────────

    this.findAllLines(/workflow\.SetUpdateHandler\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('update_' + match[1]), label: match[1] + ' (update)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLines(/workflow\.SetUpdateHandlerWithOptions\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('update_' + match[1]), label: match[1] + ' (update)', kind: 'signal', role: 'signal-handler', line });
    });

    // ── SideEffect / MutableSideEffect ────────────────────────────────────

    this.findAllLines(/workflow\.SideEffect\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `side_effect_${line}`, label: 'SideEffect', kind: 'sideEffect', line });
    });
    this.findAllLines(/workflow\.MutableSideEffect\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('mutable_se_' + match[1], line), label: 'MutableSideEffect: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/workflow\.Sleep\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `sleep_${line}`, label: 'Sleep', kind: 'timer', line });
    });
    this.findAllLines(/workflow\.NewTimer\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `timer_${line}`, label: 'NewTimer', kind: 'timer', line });
    });

    // ── Conditions / Await ─────────────────────────────────────────────────

    this.findAllLines(/workflow\.Await\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `await_${line}`, label: 'Await (condition)', kind: 'condition', line });
    });
    this.findAllLines(/workflow\.AwaitWithTimeout\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `await_timeout_${line}`, label: 'AwaitWithTimeout', kind: 'condition', line });
    });

    // ── Versioning ─────────────────────────────────────────────────────────

    this.findAllLines(/workflow\.GetVersion\s*\(\s*ctx,\s*"([^"]+)"/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('version_' + match[1], line), label: 'GetVersion: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/workflow\.ExecuteChildWorkflow\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/workflow\.NewContinueAsNewError\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `can_${line}`, label: 'ContinueAsNew', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/workflow\.UpsertMemo\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `upsert_memo_${line}`, label: 'UpsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/workflow\.UpsertTypedSearchAttributes\s*\(|workflow\.UpsertSearchAttributes\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `upsert_sa_${line}`, label: 'UpsertSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Sessions ───────────────────────────────────────────────────────────

    this.findAllLines(/workflow\.CreateSession\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `session_${line}`, label: 'CreateSession', kind: 'sideEffect', line });
    });

    // ── Goroutines (workflow.Go) ───────────────────────────────────────────

    this.findAllLines(/workflow\.Go\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `goroutine_${line}`, label: 'workflow.Go (goroutine)', kind: 'sideEffect', line });
    });

    // ── Nexus ──────────────────────────────────────────────────────────────

    this.findAllLines(/workflow\.NewNexusClient\s*\(/).forEach(({ line }) => {
      if (!inWf(line)) { return; }
      nodes.push({ id: `nexus_${line}`, label: 'NewNexusClient', kind: 'nexus', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    // Loop anchor: only set when there is an actual infinite loop (`for { ... }`)
    // wrapping an Await/condition call. A standalone Await is a one-time wait.
    const loopAnchorId = this.detectInfiniteLoopAnchor(wfRange, nodes);
    return { name, language: 'go', filePath: this.filePath, nodes, defaultOptions, loopAnchorId };
  }

  /**
   * In Go, error handling for activities looks like:
   *   err = workflow.ExecuteActivity(...).Get(ctx, &result)
   *   if err != nil {
   *       // optional compensation activities
   *       return nil, err
   *   }
   */
  private detectGoErrorBranch(activityLine: number): ErrorBranch | null {
    for (let i = activityLine; i < Math.min(this.lines.length, activityLine + 6); i++) {
      const l = this.lines[i];
      if (/if\s+err\s*!=\s*nil\s*\{/.test(l)) {
        const errBranchLine = i + 1;
        const block = this.extractBlock(errBranchLine, 20);
        const branchNodes: WorkflowNode[] = [];

        const blockLines = block.split('\n');
        for (let j = 0; j < blockLines.length; j++) {
          const m = blockLines[j].match(/workflow\.ExecuteActivity\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/);
          if (m) {
            const compLine = errBranchLine + j;
            branchNodes.push({
              id: this.toId('comp_' + m[1], compLine),
              label: m[1] + ' (compensate)',
              kind: 'activity',
              line: compLine,
            });
          }
          if (/return\s+nil,\s*(?:err|fmt\.Errorf)/.test(blockLines[j])) {
            const retLine = errBranchLine + j;
            branchNodes.push({
              id: `return_err_${retLine}`,
              label: 'return error',
              kind: 'sideEffect',
              line: retLine,
            });
          }
        }

        return { nodes: branchNodes, edgeLabel: 'on error', line: errBranchLine };
      }
    }
    return null;
  }

  /**
   * Detect whether the workflow has an actual infinite loop pattern
   * (Go: `for { ... }` with no condition) wrapping an Await/condition call.
   */
  private detectInfiniteLoopAnchor(
    wfRange: { start: number; end: number },
    nodes: WorkflowNode[]
  ): string | undefined {
    for (let i = wfRange.start - 1; i < Math.min(this.lines.length, wfRange.end); i++) {
      const l = this.lines[i].trim();
      // Go infinite loop: `for {` (no condition)
      if (!/^for\s*\{/.test(l)) { continue; }

      let depth = 0;
      let blockEnd = i;
      for (let j = i; j < this.lines.length; j++) {
        depth += (this.lines[j].match(/\{/g) || []).length;
        depth -= (this.lines[j].match(/\}/g) || []).length;
        if (depth === 0 && j > i) { blockEnd = j + 1; break; }
      }

      const bodyStart = i + 2; // 1-based
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
   * Find the 1-based line range of the workflow function body.
   * This prevents us from picking up nodes in helper functions.
   */
  private findWorkflowFuncRange(funcSignature: string): { start: number; end: number } {
    const sigIdx = this.lines.findIndex(l => l.includes(funcSignature));
    if (sigIdx < 0) { return { start: 1, end: this.lines.length }; }

    let depth = 0;
    let started = false;
    for (let i = sigIdx; i < this.lines.length; i++) {
      const opens = (this.lines[i].match(/\{/g) || []).length;
      const closes = (this.lines[i].match(/\}/g) || []).length;
      depth += opens - closes;
      if (opens > 0 && !started) { started = true; }
      if (started && depth <= 0) {
        return { start: sigIdx + 1, end: i + 1 }; // 1-based
      }
    }
    return { start: sigIdx + 1, end: this.lines.length };
  }

  /**
   * Build a set of 1-based line numbers that are inside `if err != nil { ... }` blocks
   * within the workflow function. Activities on these lines are compensation/rollback
   * and should NOT appear as main flow nodes.
   */
  private buildErrBlockLineSet(wfRange: { start: number; end: number }): Set<number> {
    const errLines = new Set<number>();
    for (let i = wfRange.start - 1; i < wfRange.end && i < this.lines.length; i++) {
      if (/if\s+err\s*!=\s*nil\s*\{/.test(this.lines[i])) {
        // Find the matching closing brace
        let depth = 0;
        for (let j = i; j < this.lines.length; j++) {
          depth += (this.lines[j].match(/\{/g) || []).length;
          depth -= (this.lines[j].match(/\}/g) || []).length;
          // Mark all lines inside the block (not the if-line itself)
          if (j > i) { errLines.add(j + 1); } // 1-based
          if (depth <= 0) { break; }
        }
      }
    }
    return errLines;
  }

  private parseActivityOptions(): ActivityOptions | undefined {
    const blockStart = this.findLine(/workflow\.ActivityOptions\s*\{/);
    if (blockStart < 0) { return undefined; }
    const block = this.extractBlock(blockStart);
    const opts: ActivityOptions = {};

    const stc = block.match(/StartToCloseTimeout:\s*([\d]+)\s*\*\s*time\.(Second|Minute|Hour)/);
    if (stc) {
      const unit = stc[2] === 'Second' ? 's' : stc[2] === 'Minute' ? 'm' : 'h';
      opts.startToCloseTimeout = stc[1] + unit;
    }

    const sc = block.match(/ScheduleToCloseTimeout:\s*([\d]+)\s*\*\s*time\.(Second|Minute|Hour)/);
    if (sc) {
      const unit = sc[2] === 'Second' ? 's' : sc[2] === 'Minute' ? 'm' : 'h';
      opts.scheduleToCloseTimeout = sc[1] + unit;
    }

    const retryBlock = block.match(/RetryPolicy:\s*&temporal\.RetryPolicy\{([\s\S]*?)\}/);
    if (retryBlock) {
      opts.retryPolicy = {};
      const ii = retryBlock[1].match(/InitialInterval:\s*([\d]+)\s*\*\s*time\.(Second|Minute)/);
      if (ii) {
        opts.retryPolicy.initialInterval = ii[1] + (ii[2] === 'Second' ? 's' : 'm');
      }
      const bc = retryBlock[1].match(/BackoffCoefficient:\s*([\d.]+)/);
      if (bc) { opts.retryPolicy.backoffCoefficient = parseFloat(bc[1]); }
      const mi = retryBlock[1].match(/MaximumInterval:\s*([\d]+)\s*\*\s*time\.(Second|Minute)/);
      if (mi) {
        opts.retryPolicy.maximumInterval = mi[1] + (mi[2] === 'Second' ? 's' : 'm');
      }
      const ma = retryBlock[1].match(/MaximumAttempts:\s*(\d+)/);
      if (ma) { opts.retryPolicy.maximumAttempts = parseInt(ma[1], 10); }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }
}
