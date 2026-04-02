import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy, ErrorBranch } from '../types';

export class PythonParser extends BaseParser {
  parse(): WorkflowModel | null {
    // @workflow.defn  or  @workflow.defn(...)  followed by class XxxWorkflow:
    const classMatch = this.source.match(/@workflow\.defn(?:\([^)]*\))?\s*\nclass\s+(\w+)\s*[:(]/);
    if (!classMatch) { return null; }
    const name = classMatch[1];

    const nodes: WorkflowNode[] = [];

    // Collect execute_activity / start_activity calls with their error branches
    const activityNodes = this.parseActivityCalls();
    nodes.push(...activityNodes);

    // ── Signal handlers ──────────────────────────────────────────────────

    // @workflow.signal decorated methods
    this.findAllLines(/@workflow\.signal(?:\([^)]*\))?/).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const sName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (sName) {
        nodes.push({ id: this.toId('signal_' + sName), label: sName + ' (signal)', kind: 'signal', line });
      }
    });
    // Dynamic signal handler registration
    this.findAllLines(/workflow\.set_signal_handler\s*\(\s*["'](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_dyn_' + match[1], line), label: match[1] + ' (signal, dynamic)', kind: 'signal', line });
    });
    this.findAllLines(/workflow\.set_dynamic_signal_handler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `signal_dynamic_${line}`, label: 'dynamic signal handler', kind: 'signal', line });
    });

    // ── Query handlers ────────────────────────────────────────────────────

    // @workflow.query decorated methods
    this.findAllLines(/@workflow\.query(?:\([^)]*\))?/).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const qName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (qName) {
        nodes.push({ id: this.toId('query_' + qName), label: qName + ' (query)', kind: 'query', line });
      }
    });
    this.findAllLines(/workflow\.set_query_handler\s*\(\s*["'](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_dyn_' + match[1], line), label: match[1] + ' (query, dynamic)', kind: 'query', line });
    });

    // ── Update handlers ───────────────────────────────────────────────────

    this.findAllLines(/@workflow\.update(?:\([^)]*\))?/).forEach(({ line }) => {
      const rawLine = this.lines[line - 1];
      const nameMatch = rawLine.match(/name=["'](\w+)["']/);
      const uName = nameMatch ? nameMatch[1] : this.getNextMethodName(line);
      if (uName) {
        nodes.push({ id: this.toId('update_' + uName), label: uName + ' (update)', kind: 'signal', line });
      }
    });
    this.findAllLines(/workflow\.set_update_handler\s*\(\s*["'](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('update_dyn_' + match[1], line), label: match[1] + ' (update, dynamic)', kind: 'signal', line });
    });
    this.findAllLines(/workflow\.set_dynamic_update_handler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `update_dynamic_${line}`, label: 'dynamic update handler', kind: 'signal', line });
    });

    // ── Conditions / waiting ──────────────────────────────────────────────

    // wait_condition (approval gate / human-in-loop)
    this.findAllLines(/await\s+workflow\.wait_condition\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `wait_cond_${line}`, label: 'wait_condition', kind: 'signal', line });
    });

    // asyncio.gather / workflow.wait — parallel waiting
    this.findAllLines(/await\s+asyncio\.gather\s*\(|await\s+workflow\.wait\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `wait_gather_${line}`, label: 'wait (parallel)', kind: 'sideEffect', line });
    });

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/await\s+asyncio\.sleep\s*\(|await\s+workflow\.sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
    });

    // ── Versioning / Patching ─────────────────────────────────────────────

    this.findAllLines(/workflow\.patched\s*\(\s*["']([^'"]+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('patch_' + match[1], line), label: 'patched: ' + match[1], kind: 'sideEffect', line });
    });
    this.findAllLines(/workflow\.deprecate_patch\s*\(\s*["']([^'"]+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'deprecate_patch: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Side effects / randomness / UUIDs ─────────────────────────────────

    this.findAllLines(/workflow\.uuid4\s*\(\s*\)/).forEach(({ line }) => {
      nodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', line });
    });
    this.findAllLines(/workflow\.random\s*\(\s*\)/).forEach(({ line }) => {
      nodes.push({ id: `random_${line}`, label: 'random (deterministic)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ──────────────────────────────────────────

    this.findAllLines(/workflow\.upsert_memo\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsert_memo', kind: 'sideEffect', line });
    });
    this.findAllLines(/workflow\.upsert_search_attributes\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsert_search_attributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/workflow\.continue_as_new\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `can_${line}`, label: 'continue_as_new', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/workflow\.get_external_workflow_handle\s*\(|workflow\.get_external_workflow_handle_for\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `ext_wf_${line}`, label: 'get_external_workflow_handle', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    // execute_child_workflow (awaited)
    this.findAllLines(/await\s+workflow\.execute_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });
    // start_child_workflow (fire-and-forget handle)
    this.findAllLines(/await\s+workflow\.start_child_workflow\s*\(\s*(?:\w+\.)?(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_started_' + match[1], line), label: match[1] + ' (child, started)', kind: 'childWorkflow', line });
    });

    // ── Nexus ──────────────────────────────────────────────────────────────

    this.findAllLines(/workflow\.create_nexus_client\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `nexus_${line}`, label: 'create_nexus_client', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    return { name, language: 'python', filePath: this.filePath, nodes };
  }

  /**
   * Parses all execute_activity / start_activity calls and groups those inside
   * try blocks so that except-clause activities become error branches.
   */
  private parseActivityCalls(): WorkflowNode[] {
    const result: WorkflowNode[] = [];

    const tryBlocks = this.findTryExceptBlocks();

    const lineToTryBlock = new Map<number, TryBlock>();
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

    // Matches execute_activity, execute_local_activity, start_activity, start_local_activity,
    // plus _method and _class variants
    const actPat = /await\s+workflow\.(execute|start)_(?:local_)?activity(?:_method|_class)?\s*\(\s*(?:\w+\.)?(\w+)/;

    this.findAllLines(actPat).forEach(({ line, match }) => {
      if (exceptBodyLines.has(line)) { return; }

      const isStarted = match[1] === 'start';
      const lineText = this.lines[line - 1];
      const isLocal = /(?:execute|start)_local_activity/.test(lineText);
      const rawName = match[2];
      const suffix = (isLocal ? ' (local)' : '') + (isStarted ? ' (started)' : '');
      const actName = rawName + suffix;
      const actId = this.toId(rawName + (isLocal ? '_local' : '') + (isStarted ? '_started' : ''), line);
      const opts = this.parseActivityCallOptions(line);

      const tb = lineToTryBlock.get(line);
      if (tb) {
        const errorBranches = this.buildErrorBranches(tb);
        result.push({ id: actId, label: actName, kind: 'activity', line, options: opts, errorBranches });
      } else {
        result.push({ id: actId, label: actName, kind: 'activity', line, options: opts });
      }
    });

    return result;
  }

  private buildErrorBranches(tb: { tryEnd: number; exceptBlocks: ExceptBlock[] }): ErrorBranch[] {
    const branches: ErrorBranch[] = [];
    for (const except of tb.exceptBlocks) {
      const exceptNodes: WorkflowNode[] = [];

      for (let l = except.start; l <= except.end && l <= this.lines.length; l++) {
        const m = this.lines[l - 1].match(/await\s+workflow\.(?:execute|start)_(?:local_)?activity(?:_method|_class)?\s*\(\s*(?:\w+\.)?(\w+)/);
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

  // ── try/except block detection (indent-based for Python) ─────────────────

  private findTryExceptBlocks(): TryBlock[] {
    const blocks: TryBlock[] = [];

    for (let i = 0; i < this.lines.length; i++) {
      const tryMatch = this.lines[i].match(/^(\s*)try\s*:/);
      if (!tryMatch) { continue; }

      const baseIndent = tryMatch[1].length;
      // tryStart: 1-based line number of the first try-body line
      const tryStart = i + 2; // i is 0-based index of "try:", body starts at i+1 (0-based) = i+2 (1-based)

      // Find the 0-based index of the first except/else/finally at the same indent level
      let exceptLineIdx = -1;
      for (let j = i + 1; j < this.lines.length; j++) {
        const l = this.lines[j];
        if (l.trim() === '') { continue; }
        const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent <= baseIndent && /^\s*(except|else|finally)/.test(l)) {
          exceptLineIdx = j;
          break;
        }
      }
      if (exceptLineIdx < 0) { continue; }

      // tryEnd: 1-based line number of the last line of the try body
      // Last try-body line is at 0-based (exceptLineIdx - 1) = 1-based exceptLineIdx
      const tryEnd = exceptLineIdx;

      // Collect except blocks; j tracks 0-based index of the except line
      const exceptBlocks: ExceptBlock[] = [];
      let j = exceptLineIdx;
      while (j < this.lines.length) {
        const l = this.lines[j];
        if (l.trim() === '') { j++; continue; }
        const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent < baseIndent) { break; }

        const exceptMatch = l.match(/^\s*except\s*(?:(\w+(?:\.\w+)?)\s*(?:as\s+\w+)?)?\s*:/);
        if (!exceptMatch) { break; }

        const errorType = exceptMatch[1] || '';
        // except body starts at the next line after the except: declaration
        const exceptStart = j + 2; // 0-based j+1 → 1-based j+2
        let exceptEnd = exceptStart;

        for (let k = j + 1; k < this.lines.length; k++) {
          const el = this.lines[k];
          if (el.trim() === '') { continue; }
          const eindent = (el.match(/^(\s*)/)?.[1].length) ?? 0;
          if (eindent <= baseIndent && /^\s*(except|else|finally|[^\s])/.test(el)) {
            // Last except-body line is 0-based k-1 = 1-based k
            exceptEnd = k;
            break;
          }
          exceptEnd = k + 1; // 0-based k → 1-based k+1
        }

        exceptBlocks.push({ start: exceptStart, end: exceptEnd, errorType });
        // exceptEnd is 1-based last line of except body; as 0-based index of next line = exceptEnd
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

    const stc = block.match(/start_to_close_timeout\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (stc) { opts.startToCloseTimeout = this.parseTdelta(stc[1]); }

    const sc = block.match(/schedule_to_close_timeout\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (sc) { opts.scheduleToCloseTimeout = this.parseTdelta(sc[1]); }

    const hb = block.match(/heartbeat_timeout\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (hb) { opts.heartbeatTimeout = this.parseTdelta(hb[1]); }

    const rpRef = block.match(/retry_policy\s*=\s*([\w.]+)/);
    if (rpRef) {
      const rp = this.resolveRetryPolicy(rpRef[1]);
      if (rp) { opts.retryPolicy = rp; }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  /** Parse a timedelta(...) argument string like "hours=1, minutes=30, seconds=5" → "1h 30m 5s" */
  private parseTdelta(args: string): string {
    const h = args.match(/hours\s*=\s*([\d.]+)/);
    const m = args.match(/minutes\s*=\s*([\d.]+)/);
    const s = args.match(/seconds\s*=\s*([\d.]+)/);
    const parts: string[] = [];
    if (h) { parts.push(h[1] + 'h'); }
    if (m) { parts.push(m[1] + 'm'); }
    if (s) { parts.push(s[1] + 's'); }
    return parts.length > 0 ? parts.join(' ') : args.trim();
  }

  private resolveRetryPolicy(ref: string): RetryPolicy | undefined {
    const escaped = ref.replace(/\./g, '\\.').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const pattern = new RegExp(`${escaped}\\s*=\\s*RetryPolicy\\s*\\(([\\s\\S]*?)\\)`, 'm');
    const m = this.source.match(pattern);
    if (!m) { return undefined; }
    const block = m[1];
    const rp: RetryPolicy = {};
    const ii = block.match(/initial_interval\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (ii) { rp.initialInterval = this.parseTdelta(ii[1]); }
    const bc = block.match(/backoff_coefficient\s*=\s*([\d.]+)/);
    if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
    const mi = block.match(/maximum_interval\s*=\s*timedelta\s*\(([^)]+)\)/);
    if (mi) { rp.maximumInterval = this.parseTdelta(mi[1]); }
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
