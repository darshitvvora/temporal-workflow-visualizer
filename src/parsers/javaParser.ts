import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

export class JavaParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Detect: class XxxImpl implements XxxWorkflow  OR  class Xxx (with @WorkflowInterface)
    const classMatch = this.source.match(/public\s+class\s+(\w+)\s+implements\s+\w*[Ww]orkflow/);
    if (!classMatch) { return null; }
    const name = classMatch[1].replace(/Impl$/, '');

    const defaultOptions = this.parseActivityOptions();
    const nodes: WorkflowNode[] = [];

    // Activity stub variable name(s): Workflow.newActivityStub(...)
    // Then calls are: stubVar.methodName(...)
    const stubVars = this.findActivityStubVars();

    for (const stubVar of stubVars) {
      // activities.validate(...), activities.withdraw(...) etc
      this.findAllLines(new RegExp(`\\b${stubVar}\\.(\\w+)\\s*\\(`)).forEach(({ line, match }) => {
        // Skip non-activity method names like getters
        const methodName = match[1];
        nodes.push({
          id: this.toId(methodName, line),
          label: methodName,
          kind: 'activity',
          line,
          options: defaultOptions ? { ...defaultOptions } : undefined,
        });
      });
    }

    // Workflow.sleep
    this.findAllLines(/Workflow\.sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
    });

    // @WorkflowQuery methods
    this.findAllLines(/@WorkflowQuery/).forEach(({ line }) => {
      const methodName = this.getNextMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('query_' + methodName), label: methodName + ' (query)', kind: 'query', line });
      }
    });

    // @WorkflowSignal methods
    this.findAllLines(/@WorkflowSignal/).forEach(({ line }) => {
      const methodName = this.getNextMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('signal_' + methodName), label: methodName + ' (signal)', kind: 'signal', line });
      }
    });

    // Workflow.newChildWorkflowStub
    this.findAllLines(/Workflow\.newChildWorkflowStub\s*\(\s*(\w+)\.class/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    return { name, language: 'java', filePath: this.filePath, nodes, defaultOptions };
  }

  private findActivityStubVars(): string[] {
    const vars: string[] = [];
    // private final XxxActivities activities = Workflow.newActivityStub(...)
    this.findAllLines(/(?:private|protected)?\s+\w+\s+(\w+)\s*=\s*Workflow\.newActivityStub\s*\(/).forEach(({ match }) => {
      vars.push(match[1]);
    });
    if (vars.length === 0) {
      // fallback: just look for "activities" as common name
      vars.push('activities');
    }
    return vars;
  }

  private parseActivityOptions(): ActivityOptions | undefined {
    // ActivityOptions.newBuilder() ... .build()
    const builderStart = this.findLine(/ActivityOptions\.newBuilder\s*\(\s*\)/);
    if (builderStart < 0) {
      // Look for ActivityOptions reference in a constant (another file usually)
      // Try to get inline options
      return undefined;
    }

    const block = this.extractBlock(builderStart, 30);
    const opts: ActivityOptions = {};

    // .setStartToCloseTimeout(Duration.ofSeconds(5))
    const stc = block.match(/setStartToCloseTimeout\s*\(\s*Duration\.of(Seconds?|Minutes?|Hours?)\s*\(\s*(\d+)\s*\)/);
    if (stc) {
      const unit = stc[1].toLowerCase().startsWith('second') ? 's' : stc[1].toLowerCase().startsWith('minute') ? 'm' : 'h';
      opts.startToCloseTimeout = stc[2] + unit;
    }

    const sc = block.match(/setScheduleToCloseTimeout\s*\(\s*Duration\.of(Seconds?|Minutes?|Hours?)\s*\(\s*(\d+)\s*\)/);
    if (sc) {
      const unit = sc[1].toLowerCase().startsWith('second') ? 's' : sc[1].toLowerCase().startsWith('minute') ? 'm' : 'h';
      opts.scheduleToCloseTimeout = sc[2] + unit;
    }

    // RetryOptions
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
