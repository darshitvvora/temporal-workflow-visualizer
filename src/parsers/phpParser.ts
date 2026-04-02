import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions } from '../types';

export class PhpParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Detect: class XxxWorkflow implements WorkflowInterface
    const classMatch = this.source.match(/class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+WorkflowInterface/);
    if (!classMatch) {
      // Also try: #[WorkflowInterface] attribute or @WorkflowInterface annotation
      const attrMatch = this.source.match(/(?:#\[WorkflowInterface\]|@WorkflowInterface)[\s\S]*?class\s+(\w+)/);
      if (!attrMatch) { return null; }
      return this.buildModel(attrMatch[1]);
    }
    return this.buildModel(classMatch[1]);
  }

  private buildModel(name: string): WorkflowModel {
    const nodes: WorkflowNode[] = [];

    // yield $this->stubVar->methodName(...)
    this.findAllLines(/yield\s+\$this->\w+->(\w+)\s*\(/).forEach(({ line, match }) => {
      nodes.push({
        id: this.toId(match[1], line),
        label: match[1],
        kind: 'activity',
        line,
      });
    });

    // @SignalMethod decorated methods
    this.findAllLines(/@SignalMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('signal_' + methodName), label: methodName + ' (signal)', kind: 'signal', line });
      }
    });

    // @QueryMethod decorated methods
    this.findAllLines(/@QueryMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('query_' + methodName), label: methodName + ' (query)', kind: 'query', line });
      }
    });

    // Workflow::timer() or $this->timer()
    this.findAllLines(/(?:Workflow::timer|yield\s+Workflow::timer)\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `timer_${line}`, label: 'timer', kind: 'timer', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    return { name, language: 'php', filePath: this.filePath, nodes };
  }

  private getNextPhpMethodName(annotationLine: number): string | undefined {
    for (let i = annotationLine; i < Math.min(this.lines.length, annotationLine + 4); i++) {
      const m = this.lines[i].match(/(?:public|protected|private)\s+function\s+(\w+)\s*\(/);
      if (m) { return m[1]; }
    }
    return undefined;
  }
}
