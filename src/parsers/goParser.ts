import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, ErrorBranch } from '../types';

export class GoParser extends BaseParser {
  parse(): WorkflowModel | null {
    const wfMatch = this.source.match(/func\s+(\w+)\s*\(ctx workflow\.Context/);
    if (!wfMatch) { return null; }
    const name = wfMatch[1];

    const defaultOptions = this.parseActivityOptions();
    const nodes: WorkflowNode[] = [];

    // ExecuteActivity with if-err-return error branch detection
    this.findAllLines(/workflow\.ExecuteActivity\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
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

    // Query handlers
    this.findAllLines(/workflow\.SetQueryHandler\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', line });
    });
    this.findAllLines(/SetQueryHandlerFor(\w+)\s*\(/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', line });
    });

    // Signal channels
    this.findAllLines(/workflow\.GetSignalChannel\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', line });
    });

    // SideEffect
    this.findAllLines(/workflow\.SideEffect\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `side_effect_${line}`, label: 'SideEffect', kind: 'sideEffect', line });
    });

    // Timers
    this.findAllLines(/workflow\.Sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'Sleep', kind: 'timer', line });
    });

    // Child workflows
    this.findAllLines(/workflow\.ExecuteChildWorkflow\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    return { name, language: 'go', filePath: this.filePath, nodes, defaultOptions };
  }

  /**
   * In Go, error handling for activities looks like:
   *   err = workflow.ExecuteActivity(...).Get(ctx, &result)
   *   if err != nil {
   *       // optional compensation activities
   *       return nil, err
   *   }
   * We detect the if-err block and any compensation activities inside it.
   */
  private detectGoErrorBranch(activityLine: number): ErrorBranch | null {
    // Look for "if err != nil {" within the next ~5 lines after the activity call
    for (let i = activityLine; i < Math.min(this.lines.length, activityLine + 6); i++) {
      const l = this.lines[i];
      if (/if\s+err\s*!=\s*nil\s*\{/.test(l)) {
        const errBranchLine = i + 1; // 1-based
        const block = this.extractBlock(errBranchLine, 20);
        const branchNodes: WorkflowNode[] = [];

        // Any compensation activities inside the if block?
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
          // return nil, err pattern
          if (/return\s+nil,\s*err/.test(blockLines[j])) {
            const retLine = errBranchLine + j;
            branchNodes.push({
              id: `return_err_${retLine}`,
              label: 'return error',
              kind: 'sideEffect',
              line: retLine,
            });
          }
        }

        return {
          nodes: branchNodes,
          edgeLabel: 'on error',
          line: errBranchLine,
        };
      }
    }
    return null;
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
