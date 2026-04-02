import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

export class PythonParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Detect: @workflow.defn followed by class XxxWorkflow:
    const classMatch = this.source.match(/@workflow\.defn[\s\S]*?class\s+(\w+)\s*:/);
    if (!classMatch) { return null; }
    const name = classMatch[1];

    const nodes: WorkflowNode[] = [];

    // execute_activity calls:
    // await workflow.execute_activity(AccountTransferActivities.method, ...)
    // await workflow.execute_activity(method_name, ...)
    this.findAllLines(/await\s+workflow\.execute_activity\s*\(\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      const opts = this.parseActivityCallOptions(line);
      nodes.push({
        id: this.toId(match[1], line),
        label: match[1],
        kind: 'activity',
        line,
        options: opts,
      });
    });

    // execute_local_activity
    this.findAllLines(/await\s+workflow\.execute_local_activity\s*\(\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      const opts = this.parseActivityCallOptions(line);
      nodes.push({
        id: this.toId(match[1] + '_local', line),
        label: match[1] + ' (local)',
        kind: 'activity',
        line,
        options: opts,
      });
    });

    // @workflow.query decorated methods
    this.findAllLines(/@workflow\.query\s*(?:\(name=["'](\w+)["']\))?/).forEach(({ line, match }) => {
      const qName = match[1] || this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', line });
      }
    });

    // @workflow.signal decorated methods
    this.findAllLines(/@workflow\.signal\s*(?:\(name=["'](\w+)["']\))?/).forEach(({ line, match }) => {
      const sName = match[1] || this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', line });
      }
    });

    // asyncio.sleep / workflow.sleep
    this.findAllLines(/await\s+asyncio\.sleep\s*\(|await\s+workflow\.sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
    });

    // uuid4 / idempotency key
    this.findAllLines(/workflow\.uuid4\s*\(\s*\)/).forEach(({ line }) => {
      nodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', line });
    });

    // execute_child_workflow
    this.findAllLines(/await\s+workflow\.execute_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    return { name, language: 'python', filePath: this.filePath, nodes };
  }

  /** Extracts options from the multi-line execute_activity call starting at callLine */
  private parseActivityCallOptions(callLine: number): ActivityOptions | undefined {
    // Collect lines from call until closing paren
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

    const stc = block.match(/start_to_close_timeout\s*=\s*timedelta\s*\(seconds\s*=\s*([\d.]+)\)/);
    if (stc) { opts.startToCloseTimeout = stc[1] + 's'; }

    const sc = block.match(/schedule_to_close_timeout\s*=\s*timedelta\s*\(seconds\s*=\s*([\d.]+)\)/);
    if (sc) { opts.scheduleToCloseTimeout = sc[1] + 's'; }

    const hb = block.match(/heartbeat_timeout\s*=\s*timedelta\s*\(seconds\s*=\s*([\d.]+)\)/);
    if (hb) { opts.heartbeatTimeout = hb[1] + 's'; }

    // retry_policy=self.retry_policy  → look up class attribute assignment
    const rpRef = block.match(/retry_policy\s*=\s*([\w.]+)/);
    if (rpRef) {
      const rp = this.resolveRetryPolicy(rpRef[1]);
      if (rp) { opts.retryPolicy = rp; }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  private resolveRetryPolicy(ref: string): RetryPolicy | undefined {
    // Look for: RetryPolicy(initial_interval=timedelta(seconds=1), ...)
    const pattern = new RegExp(
      `${ref.replace(/\./g, '\\.')}\\s*=\\s*RetryPolicy\\s*\\(([\\s\\S]*?)\\)`, 'm'
    );
    const m = this.source.match(pattern);
    if (!m) { return undefined; }
    const block = m[1];
    const rp: RetryPolicy = {};
    const ii = block.match(/initial_interval\s*=\s*timedelta\s*\(seconds\s*=\s*([\d.]+)\)/);
    if (ii) { rp.initialInterval = ii[1] + 's'; }
    const bc = block.match(/backoff_coefficient\s*=\s*([\d.]+)/);
    if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
    const mi = block.match(/maximum_interval\s*=\s*timedelta\s*\(seconds\s*=\s*([\d.]+)\)/);
    if (mi) { rp.maximumInterval = mi[1] + 's'; }
    const ma = block.match(/maximum_attempts\s*=\s*(\d+)/);
    if (ma) { rp.maximumAttempts = parseInt(ma[1], 10); }
    return Object.keys(rp).length > 0 ? rp : undefined;
  }

  private getNextMethodName(decoratorLine: number): string | undefined {
    for (let i = decoratorLine; i < Math.min(this.lines.length, decoratorLine + 3); i++) {
      const m = this.lines[i].match(/def\s+(\w+)\s*\(/);
      if (m) { return m[1]; }
    }
    return undefined;
  }
}
