import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

export class DotNetParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Detect: [Workflow] attribute + public class XxxWorkflow
    const hasAttr = /\[Workflow\]/.test(this.source);
    const classMatch = this.source.match(/public\s+class\s+(\w+)/);
    if (!classMatch || (!hasAttr && !/[Ww]orkflow/.test(classMatch[1]))) { return null; }
    const name = classMatch[1];

    const defaultOptions = this.parseActivityOptions();
    const nodes: WorkflowNode[] = [];

    // await Workflow.ExecuteActivityAsync((XxxActivities act) => act.MethodAsync(...), options)
    this.findAllLines(/await\s+Workflow\.ExecuteActivityAsync\s*\(/).forEach(({ line }) => {
      const methodName = this.extractActivityMethodName(line);
      if (methodName) {
        nodes.push({
          id: this.toId(methodName, line),
          label: methodName.replace(/Async$/, ''),
          kind: 'activity',
          line,
          options: defaultOptions ? { ...defaultOptions } : undefined,
        });
      }
    });

    // [WorkflowQuery("name")] or [WorkflowQuery]
    this.findAllLines(/\[WorkflowQuery(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/).forEach(({ line, match }) => {
      const qName = match[1] || this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', line });
      }
    });

    // [WorkflowSignal("name")] or [WorkflowSignal]
    this.findAllLines(/\[WorkflowSignal(?:\s*\(\s*["']?(\w+)["']?\s*\))?\]/).forEach(({ line, match }) => {
      const sName = match[1] || this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', line });
      }
    });

    // await Workflow.DelayAsync(...)
    this.findAllLines(/await\s+Workflow\.DelayAsync\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `delay_${line}`, label: 'DelayAsync', kind: 'timer', line });
    });

    // await Workflow.ExecuteChildWorkflowAsync
    this.findAllLines(/await\s+Workflow\.ExecuteChildWorkflowAsync\s*(?:<(\w+)>)?\s*\(/).forEach(({ line, match }) => {
      const childName = match[1] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_' + childName, line), label: childName + ' (child)', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    return { name, language: 'csharp', filePath: this.filePath, nodes, defaultOptions };
  }

  private extractActivityMethodName(callLine: number): string | undefined {
    // Collect the call expression across lines
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
    // (XxxActivities act) => act.MethodNameAsync(
    const m = text.match(/=>\s*\w+\.(\w+)\s*\(/);
    if (m) { return m[1]; }
    // ExecuteActivityAsync<XxxActivities>(nameof(XxxActivities.Method)
    const m2 = text.match(/nameof\s*\(\s*\w+\.(\w+)\s*\)/);
    if (m2) { return m2[1]; }
    return undefined;
  }

  private parseActivityOptions(): ActivityOptions | undefined {
    // new ActivityOptions { StartToCloseTimeout = TimeSpan.FromSeconds(5), ... }
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

    // RetryPolicy = new RetryPolicy { ... }
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
