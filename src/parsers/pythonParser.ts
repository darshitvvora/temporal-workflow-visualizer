import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy, ErrorBranch } from '../types';

export class PythonParser extends BaseParser {
  parse(): WorkflowModel | null {
    // @workflow.defn  or  @workflow.defn(...)  followed by class XxxWorkflow:
    // The [\s\S]*? allows for arguments like (dynamic=True, name="foo")
    const classMatch = this.source.match(/@workflow\.defn(?:\([^)]*\))?\s*\nclass\s+(\w+)\s*[:(]/);
    if (!classMatch) { return null; }
    const name = classMatch[1];

    const nodes: WorkflowNode[] = [];

    // Collect execute_activity calls with their error branches
    const activityNodes = this.parseActivityCalls();
    nodes.push(...activityNodes);

    // @workflow.query decorated methods
    this.findAllLines(/@workflow\.query(?:\([^)]*\))?/).forEach(({ line, match }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const qName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', line });
      }
    });

    // @workflow.signal decorated methods
    this.findAllLines(/@workflow\.signal(?:\([^)]*\))?/).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const sName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', line });
      }
    });

    // wait_condition (approval gate / human-in-loop)
    this.findAllLines(/await\s+workflow\.wait_condition\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `wait_cond_${line}`, label: 'wait_condition', kind: 'signal', line });
    });

    // asyncio.sleep / workflow.sleep
    this.findAllLines(/await\s+asyncio\.sleep\s*\(|await\s+workflow\.sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
    });

    // uuid4 idempotency key
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

  /**
   * Parses all execute_activity calls and groups those inside try blocks
   * so that except-clause activities become error branches.
   */
  private parseActivityCalls(): WorkflowNode[] {
    const result: WorkflowNode[] = [];

    const tryBlocks = this.findTryExceptBlocks();

    // Map lines in try-body → their TryBlock (for attaching error branches)
    const lineToTryBlock = new Map<number, TryBlock>();
    // Set of lines inside except bodies (should NOT be emitted as top-level nodes)
    const exceptBodyLines = new Set<number>();
    for (const tb of tryBlocks) {
      for (let l = tb.tryStart; l <= tb.tryEnd; l++) {
        lineToTryBlock.set(l, tb);
      }
      for (const ex of tb.exceptBlocks) {
        for (let l = ex.start; l <= ex.end; l++) {
          exceptBodyLines.add(l);
        }
      }
    }

    // Collect all execute_activity occurrences
    this.findAllLines(/await\s+workflow\.execute_(?:local_)?activity\s*\(\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      // Skip activities that live inside an except block — they're already captured
      // as compensation nodes inside buildErrorBranches
      if (exceptBodyLines.has(line)) { return; }

      const isLocal = /execute_local_activity/.test(this.lines[line - 1]);
      const actName = match[1] + (isLocal ? ' (local)' : '');
      const actId = this.toId(match[1] + (isLocal ? '_local' : ''), line);
      const opts = this.parseActivityCallOptions(line);

      const tb = lineToTryBlock.get(line);
      if (tb) {
        const errorBranches = this.buildErrorBranches(tb, line);
        result.push({ id: actId, label: actName, kind: 'activity', line, options: opts, errorBranches });
      } else {
        result.push({ id: actId, label: actName, kind: 'activity', line, options: opts });
      }
    });

    return result;
  }

  private buildErrorBranches(tb: { tryEnd: number; exceptBlocks: ExceptBlock[] }, _triggerLine: number): ErrorBranch[] {
    const branches: ErrorBranch[] = [];
    for (const except of tb.exceptBlocks) {
      const exceptNodes: WorkflowNode[] = [];

      // Find any execute_activity calls inside the except block
      for (let l = except.start; l <= except.end && l <= this.lines.length; l++) {
        const m = this.lines[l - 1].match(/await\s+workflow\.execute_(?:local_)?activity\s*\(\s*(?:\w+\.)?(\w+)/);
        if (m) {
          const opts = this.parseActivityCallOptions(l);
          exceptNodes.push({
            id: this.toId('comp_' + m[1], l),
            label: m[1] + ' (compensate)',
            kind: 'activity',
            line: l,
            options: opts,
          });
        }
        // raise → error terminal
        const raiseM = this.lines[l - 1].match(/raise\s+(\w+(?:Error|Exception|ApplicationError))\s*\(/);
        if (raiseM) {
          exceptNodes.push({
            id: `raise_${l}`,
            label: raiseM[1],
            kind: 'sideEffect',
            line: l,
          });
        }
      }

      branches.push({
        nodes: exceptNodes,
        edgeLabel: except.errorType ? `except ${except.errorType}` : 'on error',
        line: except.start,
      });
    }
    return branches;
  }

  // ── try/except block detection ───────────────────────────────────────────

  private findTryExceptBlocks(): TryBlock[] {
    const blocks: TryBlock[] = [];

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const tryMatch = line.match(/^(\s*)try\s*:/);
      if (!tryMatch) { continue; }

      const baseIndent = tryMatch[1].length;
      const tryStart = i + 1; // 1-based

      // Find where the try body ends (first line with same or less indent that isn't blank)
      let tryEnd = tryStart;
      for (let j = i + 1; j < this.lines.length; j++) {
        const l = this.lines[j];
        if (l.trim() === '') { continue; }
        const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent <= baseIndent && /^\s*(except|else|finally)/.test(l)) {
          tryEnd = j; // 1-based: j is index, but it's the except line itself
          break;
        }
        tryEnd = j + 1;
      }

      // Collect except blocks
      const exceptBlocks: ExceptBlock[] = [];
      let j = tryEnd; // index of first except line
      while (j < this.lines.length) {
        const l = this.lines[j];
        if (l.trim() === '') { j++; continue; }
        const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent < baseIndent) { break; }

        const exceptMatch = l.match(/^\s*except\s*(?:(\w+(?:\.\w+)?)\s*(?:as\s+\w+)?)?\s*:/);
        if (!exceptMatch) { break; }

        const errorType = exceptMatch[1] || '';
        const exceptStart = j + 1; // 1-based
        let exceptEnd = exceptStart;

        for (let k = j + 1; k < this.lines.length; k++) {
          const el = this.lines[k];
          if (el.trim() === '') { continue; }
          const eindent = el.match(/^(\s*)/)?.[1].length ?? 0;
          if (eindent <= baseIndent && /^\s*(except|else|finally|[^\s])/.test(el)) {
            exceptEnd = k; // exclusive
            break;
          }
          exceptEnd = k + 1;
        }

        exceptBlocks.push({ start: exceptStart, end: exceptEnd, errorType });
        j = exceptEnd;
      }

      if (exceptBlocks.length > 0) {
        blocks.push({ tryStart, tryEnd, exceptBlocks });
      }
    }

    return blocks;
  }

  // ── options parsing ──────────────────────────────────────────────────────

  private parseActivityCallOptions(callLine: number): ActivityOptions | undefined {
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

    const rpRef = block.match(/retry_policy\s*=\s*([\w.]+)/);
    if (rpRef) {
      const rp = this.resolveRetryPolicy(rpRef[1]);
      if (rp) { opts.retryPolicy = rp; }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  private resolveRetryPolicy(ref: string): RetryPolicy | undefined {
    const escaped = ref.replace(/\./g, '\\.').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const pattern = new RegExp(`${escaped}\\s*=\\s*RetryPolicy\\s*\\(([\\s\\S]*?)\\)`, 'm');
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
      const m = this.lines[i].match(/(?:async\s+)?def\s+(\w+)\s*\(/);
      if (m) { return m[1]; }
    }
    return undefined;
  }
}

interface ExceptBlock {
  start: number;  // 1-based line of first line in body
  end: number;    // 1-based inclusive last line
  errorType: string;
}

interface TryBlock {
  tryStart: number;
  tryEnd: number;
  exceptBlocks: ExceptBlock[];
}
