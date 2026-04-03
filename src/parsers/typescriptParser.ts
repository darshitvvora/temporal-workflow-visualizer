import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

// try {        catch (e) {     or    } catch (err: Some.Type) {
const TS_TRY     = /\btry\s*\{/;
const TS_CATCH   = /\}\s*catch\s*\((?:\w+\s*:\s*([\w.]+)|\w+)\s*\)/;
const TS_THROW   = /throw\s+new\s+(\w+(?:Error|Exception)?)\s*\(/;

// Known Temporal/TS SDK and JS built-in names to exclude from helper detection
const TS_TEMPORAL_METHODS = new Set([
  'proxyActivities', 'proxyLocalActivities', 'sleep', 'condition',
  'setHandler', 'defineSignal', 'defineQuery', 'defineUpdate',
  'setDefaultSignalHandler', 'setDefaultQueryHandler', 'setDefaultUpdateHandler',
  'executeChild', 'startChild', 'continueAsNew', 'makeContinueAsNewFunc',
  'patched', 'deprecatePatch', 'uuid4', 'upsertMemo', 'upsertSearchAttributes',
  'getExternalWorkflowHandle', 'createNexusClient',
  // JS built-ins
  'console', 'log', 'warn', 'error', 'info', 'debug', 'JSON', 'parse', 'stringify',
  'Promise', 'all', 'allSettled', 'race', 'any', 'resolve', 'reject',
  'setTimeout', 'clearTimeout', 'setInterval', 'Array', 'Object', 'Map', 'Set',
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'filter', 'map', 'reduce',
  'forEach', 'find', 'findIndex', 'some', 'every', 'includes', 'indexOf',
  'keys', 'values', 'entries', 'from', 'of', 'isArray', 'assign', 'freeze',
  'toString', 'valueOf', 'hasOwnProperty',
]);

export class TypeScriptParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Find ALL workflow functions, parse each, return the one with the most nodes
    const entries = this.findAllWorkflowFunctions();
    if (entries.length === 0) { return null; }

    let bestModel: WorkflowModel | null = null;
    for (const entry of entries) {
      const model = this.parseWorkflowFunction(entry.name, entry.funcRange);
      if (model && (!bestModel || model.nodes.length > bestModel.nodes.length)) {
        bestModel = model;
      }
    }
    return bestModel;
  }

  private findAllWorkflowFunctions(): Array<{ name: string; funcRange: { start: number; end: number } }> {
    const results: Array<{ name: string; funcRange: { start: number; end: number } }> = [];
    const pattern = /export\s+async\s+function\s+(\w+)\s*\(/;

    for (let i = 0; i < this.lines.length; i++) {
      const m = this.lines[i].match(pattern);
      if (!m) { continue; }
      const bounds = this.findBraceFunctionBounds(pattern, i, this.lines.length);
      if (bounds) {
        results.push({ name: m[1], funcRange: { start: i + 1, end: bounds.end } });
        i = bounds.end;
      }
    }
    return results.length > 0 ? results : (() => {
      const wfMatch = this.source.match(pattern);
      if (!wfMatch) { return []; }
      return [{ name: wfMatch[1], funcRange: { start: 1, end: this.lines.length } }];
    })();
  }

  private parseWorkflowFunction(
    name: string,
    wfRange: { start: number; end: number }
  ): WorkflowModel | null {
    const { defaultOptions, activityNames, activitySet, proxyVarNames, localProxyVarNames } = this.parseProxyActivities();

    const tryCatchBlocks = this.findTryCatchBlocks(TS_TRY, TS_CATCH);
    const catchLines = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap = this.buildTryLineMap(tryCatchBlocks);

    const funcOpenLine = wfRange.start;
    const funcEndLine = wfRange.end;

    // Helper: find the matching closing brace line (1-based) for the block
    const findBlockEnd = (startLine: number): number => {
      let depth = 0;
      for (let i = startLine - 1; i < this.lines.length; i++) {
        const l = this.lines[i];
        depth += (l.match(/\{/g) || []).length;
        depth -= (l.match(/\}/g) || []).length;
        if (depth === 0 && i >= startLine - 1) { return i + 1; }
      }
      return this.lines.length;
    };

    /** Helper: true when a 1-based line is inside the workflow function body */
    const inWfFunc = (line: number) =>
      line >= funcOpenLine && line <= funcEndLine;

    let nodes: WorkflowNode[] = [];
    const seenLines = new Set<number>();

    // ── Helper function detection + inlining ──────────────────────────────
    const allExclude = new Set([...TS_TEMPORAL_METHODS, ...activityNames, ...proxyVarNames, ...localProxyVarNames]);
    const helperRegions = this.collectHelperRegionsBrace(
      wfRange,
      /(?:await\s+)?(\w+)\s*\(/,
      allExclude,
      (methodName) => this.findTsFunctionBounds(methodName),
    );

    for (const hr of helperRegions) {
      nodes.push({
        id: this.toId('fn_' + hr.methodName, hr.callSiteLine),
        label: hr.methodName + '()',
        kind: 'functionCall',
        role: 'flow',
        line: hr.callSiteLine,
      });
    }

    for (const hr of helperRegions) {
      const helperNodes: WorkflowNode[] = [];
      // Activities via destructured names
      for (const actName of activityNames) {
        this.findAllLinesInBounds(new RegExp(`await\\s+${actName}\\s*\\(`), hr.bounds).forEach(({ line }) => {
          helperNodes.push({
            id: this.toId(actName.replace(/Async$/, ''), line),
            label: actName.replace(/Async$/, ''),
            kind: 'activity', line,
            options: defaultOptions ? { ...defaultOptions } : undefined,
          });
        });
      }
      // Activities via proxy var
      for (const varName of [...proxyVarNames, ...localProxyVarNames]) {
        const isLocal = localProxyVarNames.includes(varName);
        this.findAllLinesInBounds(new RegExp(`await\\s+${varName}\\.(\\w+)\\s*\\(`), hr.bounds).forEach(({ line, match }) => {
          const baseName = match[1].replace(/Async$/, '');
          helperNodes.push({
            id: this.toId(baseName, line),
            label: baseName + (isLocal ? ' (local)' : ''),
            kind: isLocal ? 'localActivity' : 'activity', line,
            options: defaultOptions ? { ...defaultOptions } : undefined,
          });
        });
      }
      // Conditions, timers, child workflows, etc.
      helperNodes.push(...this.scanHelperForPrimitives(hr.bounds, [
        { pattern: /await\s+condition\s*\(/, nodeFactory: (line) => ({
          id: `condition_${line}`, label: 'condition', kind: 'condition', line,
        }) },
        { pattern: /await\s+sleep\s*\(/, nodeFactory: (line) => ({
          id: `sleep_${line}`, label: 'sleep', kind: 'timer', line,
        }) },
        { pattern: /executeChild\s*\(\s*(\w+)/, nodeFactory: (line, match) => ({
          id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line,
        }) },
        { pattern: /startChild\s*\(\s*(\w+)/, nodeFactory: (line, match) => ({
          id: this.toId('child_started_' + match[1], line), label: match[1] + ' (child, started)', kind: 'childWorkflow', line,
        }) },
        { pattern: /continueAsNew\s*(?:<[^>]+>)?\s*\(/, nodeFactory: (line) => ({
          id: `can_${line}`, label: 'continueAsNew', kind: 'sideEffect', line,
        }) },
      ]));
      this.applyVirtualLines(helperNodes, hr.callSiteLine);
      nodes.push(...helperNodes);
    }

    // Activity calls via destructured names: await chargeCard(...)
    for (const actName of activityNames) {
      this.findAllLines(new RegExp(`await\\s+${actName}\\s*\\(`)).forEach(({ line }) => {
        if (catchLines.has(line) || seenLines.has(line) || !inWfFunc(line)) { return; }
        seenLines.add(line);
        const label = actName.replace(/Async$/, '');
        const tb = tryLineMap.get(line);
        const catchActPat = this.buildCatchActivityPattern(activitySet, proxyVarNames, localProxyVarNames);
        const errorBranches = tb
          ? this.buildErrorBranchesFromCatch(tb, catchActPat, TS_THROW)
          : undefined;
        nodes.push({
          id: this.toId(label, line),
          label,
          kind: 'activity',
          line,
          options: defaultOptions ? { ...defaultOptions } : undefined,
          errorBranches: errorBranches?.length ? errorBranches : undefined,
        });
      });
    }

    // Activity calls via proxy variable: await acts.chargeCard(...)
    for (const varName of [...proxyVarNames, ...localProxyVarNames]) {
      const isLocal = localProxyVarNames.includes(varName);
      this.findAllLines(new RegExp(`await\\s+${varName}\\.(\\w+)\\s*\\(`)).forEach(({ line, match }) => {
        if (catchLines.has(line) || seenLines.has(line) || !inWfFunc(line)) { return; }
        seenLines.add(line);
        const baseName = match[1].replace(/Async$/, '');
        const label = baseName + (isLocal ? ' (local)' : '');
        const tb = tryLineMap.get(line);
        const catchActPat = this.buildCatchActivityPattern(activitySet, proxyVarNames, localProxyVarNames);
        const errorBranches = tb
          ? this.buildErrorBranchesFromCatch(tb, catchActPat, TS_THROW)
          : undefined;
        nodes.push({
          id: this.toId(label, line),
          label,
          kind: isLocal ? 'localActivity' : 'activity',
          line,
          options: defaultOptions ? { ...defaultOptions } : undefined,
          errorBranches: errorBranches?.length ? errorBranches : undefined,
        });
      });
    }

    // ── Signal definitions ─────────────────────────────────────────────────

    this.findAllLines(/defineSignal\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', role: 'signal-handler', line });
    });
    // setDefaultSignalHandler — dynamic fallback
    this.findAllLines(/setDefaultSignalHandler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `default_signal_${line}`, label: 'default signal handler', kind: 'signal', role: 'signal-handler', line });
    });

    // ── Query definitions ──────────────────────────────────────────────────

    this.findAllLines(/defineQuery\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', role: 'query-handler', line });
    });
    this.findAllLines(/setDefaultQueryHandler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `default_query_${line}`, label: 'default query handler', kind: 'query', role: 'query-handler', line });
    });

    // ── Update definitions ─────────────────────────────────────────────────

    this.findAllLines(/defineUpdate\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('update_' + match[1]), label: match[1] + ' (update)', kind: 'signal', role: 'signal-handler', line });
    });
    this.findAllLines(/setDefaultUpdateHandler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `default_update_${line}`, label: 'default update handler', kind: 'signal', role: 'signal-handler', line });
    });

    // ── Conditions & timers ────────────────────────────────────────────────

    this.findAllLines(/await\s+condition\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfFunc(line)) {
        nodes.push({ id: `condition_${line}`, label: 'condition', kind: 'condition', line });
      }
    });

    this.findAllLines(/await\s+sleep\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line) && inWfFunc(line)) {
        nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
      }
    });

    // ── Versioning / Patching ─────────────────────────────────────────────

    this.findAllLines(/patched\s*\(\s*['"]([^'"]+)['"]\s*\)/).forEach(({ line, match }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: this.toId('patch_' + match[1], line), label: 'patched: ' + match[1], kind: 'sideEffect', line });
    });
    this.findAllLines(/deprecatePatch\s*\(\s*['"]([^'"]+)['"]\s*\)/).forEach(({ line, match }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'deprecatePatch: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Side effects / randomness / UUIDs ─────────────────────────────────

    this.findAllLines(/uuid4\s*\(\s*\)/).forEach(({ line }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/upsertMemo\s*\(/).forEach(({ line }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/upsertSearchAttributes\s*\(/).forEach(({ line }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsertSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/continueAsNew\s*(?:<[^>]+>)?\s*\(|makeContinueAsNewFunc\s*\(/).forEach(({ line }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `can_${line}`, label: 'continueAsNew', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/getExternalWorkflowHandle\s*\(/).forEach(({ line }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `ext_wf_${line}`, label: 'getExternalWorkflowHandle', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/executeChild\s*\(\s*(\w+)/).forEach(({ line, match }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });
    this.findAllLines(/startChild\s*\(\s*(\w+)/).forEach(({ line, match }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: this.toId('child_started_' + match[1], line), label: match[1] + ' (child, started)', kind: 'childWorkflow', line });
    });

    // ── Cancellation scopes ────────────────────────────────────────────────

    this.findAllLines(/CancellationScope\.(run|withTimeout|cancellable|nonCancellable)\s*\(/).forEach(({ line, match }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `cancel_scope_${line}`, label: 'CancellationScope.' + match[1], kind: 'sideEffect', line });
    });

    // ── Nexus ──────────────────────────────────────────────────────────────

    this.findAllLines(/createNexusClient\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      if (!inWfFunc(line)) { return; }
      nodes.push({ id: `nexus_${line}`, label: 'createNexusClient', kind: 'nexus', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    // Basic control-flow analysis: detect simple for/while loop blocks and
    // top-level if/else blocks so the diagram generator can render them as
    // loop regions and conditional branches. This is intentionally simple
    // (brace-based) to cover common patterns.
    const loopRegions: Array<{ nodeId: string; bodyStart: number; bodyEnd: number }> = [];

    // We'll perform analysis for loops and if/else, but avoid mutating the
    // `nodes` list while scanning so both detections can see original nodes.
    const skippedNodeIds = new Set<string>();
    const newNodes: WorkflowNode[] = [];

    // Find loops (for/while) within the function body
    const loopMatches = this.findAllLines(/\b(for|while)\b\s*\(/).filter(m => m.line >= funcOpenLine && m.line <= funcEndLine);
    for (const m of loopMatches) {
      // locate opening brace for the loop
      let openIdx = m.line - 1;
      while (openIdx < this.lines.length && !this.lines[openIdx].includes('{')) { openIdx++; }
      if (openIdx >= this.lines.length) { continue; }
      const blockEnd = findBlockEnd(openIdx + 1);
      const bodyStart = openIdx + 2; // first line inside braces
      const bodyEnd = Math.max(openIdx + 1, blockEnd - 1);

      const bodyNodes = nodes.filter(n => (!n.role || n.role === 'flow') && n.line >= bodyStart && n.line <= bodyEnd);
      if (bodyNodes.length === 0) { continue; }

      // Mark body nodes to be skipped in main flow and register a loop node
      for (const bn of bodyNodes) { skippedNodeIds.add(bn.id); }
      const loopId = this.toId('loop_' + m.line);
      newNodes.push({ id: loopId, label: 'loop', kind: 'loop', line: m.line });
      loopRegions.push({ nodeId: loopId, bodyStart, bodyEnd });
    }

    // Rebuild node list excluding skipped nodes, then append the synthetic nodes
    nodes = nodes.filter(n => !skippedNodeIds.has(n.id)).concat(newNodes);
    nodes.sort((a, b) => a.line - b.line);

    const loopAnchorId = this.detectInfiniteLoopAnchor(funcOpenLine, funcEndLine, nodes);
    return { name, language: 'typescript', filePath: this.filePath, nodes, defaultOptions, loopAnchorId, loopRegions: loopRegions.length ? loopRegions : undefined };
  }

  private findTsFunctionBounds(name: string): { start: number; end: number } | null {
    const patterns = [
      new RegExp(`(?:async\\s+)?function\\s+${name}\\s*[(<]`),
      new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?(?:function|\\()`),
    ];
    for (const pat of patterns) {
      const bounds = this.findBraceFunctionBounds(pat);
      if (bounds) { return bounds; }
    }
    return null;
  }

  /**
   * Detect whether the workflow has an actual infinite loop pattern
   * (e.g. `while (true) { ... await condition(...) ... }`).
   * Only returns a loop anchor ID when there's a real `while(true)` or `for(;;)`
   * wrapping a condition/await call. Returns undefined otherwise.
   */
  private detectInfiniteLoopAnchor(
    funcStart: number,
    funcEnd: number,
    nodes: WorkflowNode[]
  ): string | undefined {
    // Look for while(true) / while(1) / for(;;) patterns in the function body
    for (let i = funcStart - 1; i < Math.min(this.lines.length, funcEnd); i++) {
      const l = this.lines[i];
      const isInfiniteLoop =
        /\bwhile\s*\(\s*true\s*\)/.test(l) ||
        /\bwhile\s*\(\s*1\s*\)/.test(l) ||
        /\bfor\s*\(\s*;\s*;\s*\)/.test(l);
      if (!isInfiniteLoop) { continue; }

      // Find the block bounds of this loop
      let openIdx = i;
      while (openIdx < this.lines.length && !this.lines[openIdx].includes('{')) { openIdx++; }
      if (openIdx >= this.lines.length) { continue; }

      let depth = 0;
      let blockEnd = openIdx;
      for (let j = openIdx; j < this.lines.length; j++) {
        depth += (this.lines[j].match(/\{/g) || []).length;
        depth -= (this.lines[j].match(/\}/g) || []).length;
        if (depth === 0 && j > openIdx) { blockEnd = j + 1; break; }
      }

      const bodyStart = openIdx + 2; // 1-based first line inside braces
      const bodyEnd = blockEnd;

      // Find the first condition/await node inside this loop body
      const anchorNode = nodes.find(
        n => (!n.role || n.role === 'flow') && n.kind === 'condition' &&
             n.line >= bodyStart && n.line <= bodyEnd
      );
      if (anchorNode) {
        return anchorNode.id;
      }
    }
    return undefined;
  }

  private buildCatchActivityPattern(
    activitySet: Set<string>,
    proxyVarNames: string[],
    localProxyVarNames: string[]
  ): RegExp {
    const parts: string[] = [];
    if (activitySet.size > 0) {
      parts.push(`await\\s+(${[...activitySet].join('|')})\\s*\\(`);
    }
    const allVars = [...proxyVarNames, ...localProxyVarNames];
    if (allVars.length > 0) {
      parts.push(`await\\s+(?:${allVars.join('|')})\\.(\\w+)\\s*\\(`);
    }
    if (parts.length === 0) {
      return /await\s+(\w+Async)\s*\(/;
    }
    return new RegExp(parts.join('|'));
  }

  private parseProxyActivities(): {
    defaultOptions?: ActivityOptions;
    activityNames: string[];
    activitySet: Set<string>;
    proxyVarNames: string[];
    localProxyVarNames: string[];
  } {
    let activityNames: string[] = [];
    let defaultOptions: ActivityOptions | undefined;
    const proxyVarNames: string[] = [];
    const localProxyVarNames: string[] = [];

    // Form 1: const { chargeCard, refundCard } = proxyActivities<...>({ ... })
    const destructureMatch = this.source.match(
      /const\s+\{([^}]+)\}\s*=\s*\n?\s*proxyActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/
    );
    if (destructureMatch) {
      activityNames = destructureMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      defaultOptions = this.parseOptionsBlock(destructureMatch[2]);
    }

    // Form 2: const acts = proxyActivities<T>({ ... }) — regular activities
    const proxyVarRe = /const\s+(\w+)\s*=\s*proxyActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    let pvm: RegExpExecArray | null;
    while ((pvm = proxyVarRe.exec(this.source)) !== null) {
      const varName = pvm[1];
      if (!varName || varName === '{') { continue; }
      proxyVarNames.push(varName);
      if (!defaultOptions) { defaultOptions = this.parseOptionsBlock(pvm[2]); }
      // Discover activity names from call sites
      const callRe = new RegExp(`await\\s+${varName}\\.(\\w+)\\s*\\(`, 'g');
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(this.source)) !== null) {
        const mName = cm[1].replace(/Async$/, '');
        if (!activityNames.includes(mName)) { activityNames.push(mName); }
      }
    }

    // Form 3: const localActs = proxyLocalActivities<T>({ ... })
    const localProxyVarRe = /const\s+(\w+)\s*=\s*proxyLocalActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    let lvm: RegExpExecArray | null;
    while ((lvm = localProxyVarRe.exec(this.source)) !== null) {
      const varName = lvm[1];
      if (!varName || varName === '{') { continue; }
      localProxyVarNames.push(varName);
      if (!defaultOptions) { defaultOptions = this.parseOptionsBlock(lvm[2]); }
    }

    // Also handle destructured local activities
    const localDestructureMatch = this.source.match(
      /const\s+\{([^}]+)\}\s*=\s*\n?\s*proxyLocalActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/
    );
    if (localDestructureMatch) {
      const localNames = localDestructureMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const n of localNames) {
        if (!activityNames.includes(n)) { activityNames.push(n); }
      }
    }

    // Fallback: plain proxyActivities call for options only
    if (!defaultOptions && proxyVarNames.length === 0 && activityNames.length === 0) {
      const proxyMatch = this.source.match(/proxyActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/);
      if (proxyMatch) { defaultOptions = this.parseOptionsBlock(proxyMatch[1]); }
    }

    return { defaultOptions, activityNames, activitySet: new Set(activityNames), proxyVarNames, localProxyVarNames };
  }

  private parseOptionsBlock(block: string): ActivityOptions | undefined {
    const opts: ActivityOptions = {};

    const stc = block.match(/startToCloseTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (stc) { opts.startToCloseTimeout = stc[1]; }
    const sc = block.match(/scheduleToCloseTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (sc) { opts.scheduleToCloseTimeout = sc[1]; }
    const sts = block.match(/scheduleToStartTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (sts) { opts.scheduleToStartTimeout = sts[1]; }
    const hb = block.match(/heartbeatTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (hb) { opts.heartbeatTimeout = hb[1]; }

    const retryInline = block.match(/retry\s*:\s*\{([\s\S]*?)\}/);
    const retryVar    = block.match(/retry\s*:\s*(\w+)/);
    let retryBlock = '';
    if (retryInline) {
      retryBlock = retryInline[1];
    } else if (retryVar) {
      const constMatch = this.source.match(new RegExp(`const\\s+${retryVar[1]}[^=]*=\\s*\\{([\\s\\S]*?)\\}`));
      if (constMatch) { retryBlock = constMatch[1]; }
    }

    if (retryBlock) {
      const rp: RetryPolicy = {};
      const ii = retryBlock.match(/initialInterval\s*:\s*['"]([^'"]+)['"]/);
      if (ii) { rp.initialInterval = ii[1]; }
      const bc = retryBlock.match(/backoffCoefficient\s*:\s*([\d.]+)/);
      if (bc) { rp.backoffCoefficient = parseFloat(bc[1]); }
      const mi = retryBlock.match(/maximumInterval\s*:\s*['"]([^'"]+)['"]/);
      if (mi) { rp.maximumInterval = mi[1]; }
      const ma = retryBlock.match(/maximumAttempts\s*:\s*(\d+)/);
      if (ma) { rp.maximumAttempts = parseInt(ma[1], 10); }
      if (Object.keys(rp).length > 0) { opts.retryPolicy = rp; }
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  }
}
