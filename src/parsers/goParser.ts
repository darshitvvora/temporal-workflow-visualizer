import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions } from '../types';

export class GoParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Detect workflow function: func XxxWorkflow(ctx workflow.Context
    const wfMatch = this.source.match(/func\s+(\w+)\s*\(ctx workflow\.Context/);
    if (!wfMatch) { return null; }
    const name = wfMatch[1];

    const defaultOptions = this.parseActivityOptions();
    const nodes: WorkflowNode[] = [];

    // ExecuteActivity calls: workflow.ExecuteActivity(ctx, activities.Name
    // or workflow.ExecuteActivity(ctx, Name
    this.findAllLines(/workflow\.ExecuteActivity\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      nodes.push({
        id: this.toId(match[1], line),
        label: match[1],
        kind: 'activity',
        line,
        options: defaultOptions ? { ...defaultOptions } : undefined,
      });
    });

    // Query handlers: workflow.SetQueryHandler(ctx, "name"  OR  messages.SetQueryHandlerFor...
    this.findAllLines(/workflow\.SetQueryHandler\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', line });
    });
    // Generic query handler helper pattern
    this.findAllLines(/SetQueryHandlerFor(\w+)\s*\(/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', line });
    });

    // Signal channels: workflow.GetSignalChannel(ctx, "name")
    this.findAllLines(/workflow\.GetSignalChannel\s*\(\s*ctx,\s*"(\w+)"/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', line });
    });

    // SideEffect
    this.findAllLines(/workflow\.SideEffect\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `side_effect_${line}`, label: 'SideEffect', kind: 'sideEffect', line });
    });

    // Timers: workflow.Sleep
    this.findAllLines(/workflow\.Sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'Sleep', kind: 'timer', line });
    });

    // Child workflows: workflow.ExecuteChildWorkflow
    this.findAllLines(/workflow\.ExecuteChildWorkflow\s*\(\s*ctx,\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    return { name, language: 'go', filePath: this.filePath, nodes, defaultOptions };
  }

  private parseActivityOptions(): ActivityOptions | undefined {
    const blockStart = this.findLine(/workflow\.ActivityOptions\s*\{/);
    if (blockStart < 0) { return undefined; }
    const block = this.extractBlock(blockStart);

    const opts: ActivityOptions = {};

    // StartToCloseTimeout: N * time.Second / time.Minute
    const stc = block.match(/StartToCloseTimeout:\s*([\d]+)\s*\*\s*time\.(Second|Minute|Hour)/);
    if (stc) {
      const unit = stc[2] === 'Second' ? 's' : stc[2] === 'Minute' ? 'm' : 'h';
      opts.startToCloseTimeout = stc[1] + unit;
    }
    const stcDur = block.match(/StartToCloseTimeout:\s*([\d]+)\s*\*\s*time\.Duration\((\d+)\)/);
    if (stcDur) { opts.startToCloseTimeout = stcDur[1] + 's'; }

    const sc = block.match(/ScheduleToCloseTimeout:\s*([\d]+)\s*\*\s*time\.(Second|Minute|Hour)/);
    if (sc) {
      const unit = sc[2] === 'Second' ? 's' : sc[2] === 'Minute' ? 'm' : 'h';
      opts.scheduleToCloseTimeout = sc[1] + unit;
    }

    // RetryPolicy block
    const retryBlock = block.match(/RetryPolicy:\s*&temporal\.RetryPolicy\{([\s\S]*?)\}/);
    if (retryBlock) {
      opts.retryPolicy = {};
      const ii = retryBlock[1].match(/InitialInterval:\s*([\d]+)\s*\*\s*time\.(Second|Minute)/);
      if (ii) {
        const unit = ii[2] === 'Second' ? 's' : 'm';
        opts.retryPolicy.initialInterval = ii[1] + unit;
      }
      const bc = retryBlock[1].match(/BackoffCoefficient:\s*([\d.]+)/);
      if (bc) { opts.retryPolicy.backoffCoefficient = parseFloat(bc[1]); }
      const mi = retryBlock[1].match(/MaximumInterval:\s*([\d]+)\s*\*\s*time\.(Second|Minute)/);
      if (mi) {
        const unit = mi[2] === 'Second' ? 's' : 'm';
        opts.retryPolicy.maximumInterval = mi[1] + unit;
      }
      const ma = retryBlock[1].match(/MaximumAttempts:\s*(\d+)/);
      if (ma) { opts.retryPolicy.maximumAttempts = parseInt(ma[1], 10); }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }
}
