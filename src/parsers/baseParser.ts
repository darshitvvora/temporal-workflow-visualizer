import { WorkflowModel, ActivityOptions, WorkflowNode, ErrorBranch } from '../types';

export interface CatchBlock {
  start: number;   // 1-based first line of the catch body
  end: number;     // 1-based last line (inclusive)
  errorType: string;
}

export interface TryCatchBlock {
  tryStart: number;
  tryEnd: number;
  catchBlocks: CatchBlock[];
}

export abstract class BaseParser {
  protected lines: string[];

  constructor(protected source: string, protected filePath: string) {
    this.lines = source.split('\n');
  }

  abstract parse(): WorkflowModel | null;

  /** Returns 1-based line number of first line matching the regex, or -1 */
  protected findLine(pattern: RegExp, startFrom = 0): number {
    for (let i = startFrom; i < this.lines.length; i++) {
      if (pattern.test(this.lines[i])) { return i + 1; }
    }
    return -1;
  }

  /** Returns all {line (1-based), match} pairs for a pattern (first match per line) */
  protected findAllLines(pattern: RegExp): Array<{ line: number; match: RegExpMatchArray }> {
    const results: Array<{ line: number; match: RegExpMatchArray }> = [];
    this.lines.forEach((text, i) => {
      const m = text.match(pattern);
      if (m) { results.push({ line: i + 1, match: m }); }
    });
    return results;
  }

  /**
   * Like findAllLines but returns ALL matches on each line (useful for patterns
   * like `Promise.allOf(stub.a(), stub.b())` where multiple calls share a line).
   * The pattern must NOT have the `g` flag — this method adds it internally.
   */
  protected findAllOccurrences(pattern: RegExp): Array<{ line: number; match: RegExpMatchArray }> {
    const results: Array<{ line: number; match: RegExpMatchArray }> = [];
    const globalPat = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    this.lines.forEach((text, i) => {
      for (const m of text.matchAll(globalPat)) {
        results.push({ line: i + 1, match: m as RegExpMatchArray });
      }
    });
    return results;
  }

  /** Extract block from startLine until braces balance to zero */
  protected extractBlock(startLine: number, maxLines = 50): string {
    let depth = 0;
    const collected: string[] = [];
    for (let i = startLine - 1; i < Math.min(this.lines.length, startLine - 1 + maxLines); i++) {
      const l = this.lines[i];
      depth += (l.match(/\{/g) || []).length;
      depth -= (l.match(/\}/g) || []).length;
      collected.push(l);
      if (depth === 0 && collected.length > 1) { break; }
    }
    return collected.join('\n');
  }

  /** Slugify into a safe Mermaid node ID (alphanumeric + underscore only) */
  protected toId(name: string, suffix?: string | number): string {
    const base = name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    return suffix !== undefined ? `${base}_${suffix}` : base;
  }

  // ── Shared try/catch block detection (brace-based, for C-style languages) ──

  /**
   * Finds all try { } catch blocks using brace matching.
   * Works for TypeScript, Java, C#, Go (try/if-err).
   * The openKeyword regex matches the line that opens the try body.
   * The catchKeyword regex matches catch/except lines.
   */
  protected findTryCatchBlocks(
    tryPattern: RegExp,
    catchPattern: RegExp
  ): TryCatchBlock[] {
    const blocks: TryCatchBlock[] = [];

    for (let i = 0; i < this.lines.length; i++) {
      if (!tryPattern.test(this.lines[i])) { continue; }

      // find where the try body ends
      const tryBodyStart = i + 1; // 0-based index of line after "try {"
      let depth = 0;
      let tryBodyEnd = i; // 0-based index of closing brace of try

      // count opening brace on the try line itself
      depth += (this.lines[i].match(/\{/g) || []).length;
      depth -= (this.lines[i].match(/\}/g) || []).length;

      let j = i + 1;
      for (; j < this.lines.length; j++) {
        depth += (this.lines[j].match(/\{/g) || []).length;
        depth -= (this.lines[j].match(/\}/g) || []).length;
        if (depth <= 0) { tryBodyEnd = j; break; }
      }

      // now scan for catch blocks immediately following
      const catchBlocks: CatchBlock[] = [];
      let k = tryBodyEnd + 1;
      while (k < this.lines.length) {
        // skip blank lines
        if (this.lines[k].trim() === '') { k++; continue; }
        const catchMatch = this.lines[k].match(catchPattern);
        if (!catchMatch) { break; }

        const errorType = catchMatch[1] || catchMatch[2] || '';
        const catchBodyStart = k; // 0-based

        // find the closing brace of this catch block
        let catchDepth = 0;
        let catchBodyEnd = k;
        for (let m = k; m < this.lines.length; m++) {
          catchDepth += (this.lines[m].match(/\{/g) || []).length;
          catchDepth -= (this.lines[m].match(/\}/g) || []).length;
          if (catchDepth <= 0 && m > k) { catchBodyEnd = m; break; }
          if (catchDepth <= 0 && m === k && !this.lines[k].includes('{')) {
            // no brace on catch line — inline form
            catchBodyEnd = k;
            break;
          }
        }

        catchBlocks.push({
          start: catchBodyStart + 1,   // 1-based
          end: catchBodyEnd + 1,
          errorType,
        });
        k = catchBodyEnd + 1;
      }

      if (catchBlocks.length > 0) {
        blocks.push({
          tryStart: tryBodyStart + 1,  // 1-based
          tryEnd: tryBodyEnd + 1,
          catchBlocks,
        });
      }
    }

    return blocks;
  }

  /** Build a set of all lines that are inside catch/except bodies */
  protected buildCatchLineSet(blocks: TryCatchBlock[]): Set<number> {
    const s = new Set<number>();
    for (const tb of blocks) {
      for (const cb of tb.catchBlocks) {
        for (let l = cb.start; l <= cb.end; l++) { s.add(l); }
      }
    }
    return s;
  }

  /** Build a map from try-body lines → their TryCatchBlock */
  protected buildTryLineMap(blocks: TryCatchBlock[]): Map<number, TryCatchBlock> {
    const m = new Map<number, TryCatchBlock>();
    for (const tb of blocks) {
      for (let l = tb.tryStart; l <= tb.tryEnd; l++) { m.set(l, tb); }
    }
    return m;
  }

  /**
   * Given a catch block, extract compensation/rollback activity calls inside it.
   * activityPattern must capture the activity name in group 1.
   */
  protected extractCatchNodes(
    cb: CatchBlock,
    activityPattern: RegExp,
    throwPattern: RegExp
  ): WorkflowNode[] {
    const nodes: WorkflowNode[] = [];
    for (let l = cb.start; l <= cb.end && l <= this.lines.length; l++) {
      const am = this.lines[l - 1].match(activityPattern);
      if (am) {
        // group 1 or first non-undefined captured group (handles alternation patterns)
        const actName = am.slice(1).find(g => g !== undefined) || 'activity';
        nodes.push({
          id: this.toId('comp_' + actName, l),
          label: actName + ' (compensate)',
          kind: 'activity',
          line: l,
        });
      }
      const tm = this.lines[l - 1].match(throwPattern);
      if (tm) {
        nodes.push({
          id: `throw_${l}`,
          label: tm[1] || 'throw',
          kind: 'sideEffect',
          line: l,
        });
      }
    }
    return nodes;
  }

  protected buildErrorBranchesFromCatch(
    tb: TryCatchBlock,
    activityPattern: RegExp,
    throwPattern: RegExp
  ): ErrorBranch[] {
    return tb.catchBlocks.map(cb => ({
      nodes: this.extractCatchNodes(cb, activityPattern, throwPattern),
      edgeLabel: cb.errorType ? `catch ${cb.errorType}` : 'on error',
      line: cb.start,
    }));
  }

  // ── Shared helper function inlining utilities ─────────────────────────────

  /**
   * Like findAllLines but restricted to lines within [bounds.start, bounds.end] (inclusive, 1-based).
   * When bounds is null, falls back to full-file scan.
   */
  protected findAllLinesInBounds(
    pattern: RegExp,
    bounds: { start: number; end: number } | null
  ): Array<{ line: number; match: RegExpMatchArray }> {
    const all = this.findAllLines(pattern);
    if (!bounds) { return all; }
    return all.filter(r => r.line >= bounds.start && r.line <= bounds.end);
  }

  /**
   * Reassign line numbers to virtual fractional values based on call site.
   * Nodes are sorted by their actual line first, then assigned
   * callSiteLine + (rank+1)*0.001 so they sort correctly in the flow.
   */
  protected applyVirtualLines(nodes: WorkflowNode[], callSiteLine: number): void {
    nodes.sort((a, b) => a.line - b.line);
    nodes.forEach((n, idx) => {
      n.line = callSiteLine + (idx + 1) * 0.001;
    });
  }

  /**
   * Find a function/method body using brace counting.
   * Searches for a line matching `signaturePattern`, then finds the opening `{`
   * and counts braces to determine the body end.
   * Returns 1-based { start, end } bounds of the body (inside the braces), or null.
   */
  protected findBraceFunctionBounds(
    signaturePattern: RegExp,
    searchStart = 0,
    searchEnd = this.lines.length
  ): { start: number; end: number } | null {
    let sigIdx = -1;
    for (let i = searchStart; i < searchEnd; i++) {
      if (signaturePattern.test(this.lines[i])) { sigIdx = i; break; }
    }
    if (sigIdx < 0) { return null; }

    // Find opening brace
    let openIdx = sigIdx;
    while (openIdx < this.lines.length && !this.lines[openIdx].includes('{')) { openIdx++; }
    if (openIdx >= this.lines.length) { return null; }

    // Count braces to find end
    let depth = 0;
    let blockEnd = openIdx;
    for (let j = openIdx; j < this.lines.length; j++) {
      depth += (this.lines[j].match(/\{/g) || []).length;
      depth -= (this.lines[j].match(/\}/g) || []).length;
      if (depth === 0 && j > openIdx) { blockEnd = j; break; }
    }

    return { start: openIdx + 2, end: blockEnd }; // 1-based, inside braces
  }

  /**
   * Detect helper function calls within bounds, excluding known SDK methods.
   * Returns call site lines and function names.
   * `callPattern` should capture the function/method name in group 1.
   * `excludeSet` contains known framework method names to skip.
   */
  protected findHelperCallsInBoundsGeneric(
    bounds: { start: number; end: number },
    callPattern: RegExp,
    excludeSet: Set<string>
  ): Array<{ line: number; methodName: string }> {
    const results: Array<{ line: number; methodName: string }> = [];
    for (let i = bounds.start - 1; i < Math.min(this.lines.length, bounds.end); i++) {
      const l = this.lines[i];
      if (l.trimStart().startsWith('//') || l.trimStart().startsWith('#') || l.trimStart().startsWith('*')) { continue; }
      const global = new RegExp(callPattern.source, callPattern.flags.includes('g') ? callPattern.flags : callPattern.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = global.exec(l)) !== null) {
        const name = m[1];
        if (name && !excludeSet.has(name) && !results.some(r => r.line === i + 1 && r.methodName === name)) {
          results.push({ line: i + 1, methodName: name });
        }
      }
    }
    return results;
  }

  private static readonly MAX_HELPER_DEPTH = 3;

  /**
   * Collect helper method regions called from bounds, recursively up to depth 3.
   * `callPattern` and `excludeSet` are passed to findHelperCallsInBounds.
   * `findBounds` is a function that finds the body bounds of a named method/function.
   */
  protected collectHelperRegionsBrace(
    bounds: { start: number; end: number },
    callPattern: RegExp,
    excludeSet: Set<string>,
    findBounds: (name: string) => { start: number; end: number } | null,
    depth = 0,
    visited = new Set<string>()
  ): Array<{ methodName: string; callSiteLine: number; bounds: { start: number; end: number } }> {
    if (depth >= BaseParser.MAX_HELPER_DEPTH) { return []; }

    const results: Array<{ methodName: string; callSiteLine: number; bounds: { start: number; end: number } }> = [];
    const calls = this.findHelperCallsInBoundsGeneric(bounds, callPattern, excludeSet);

    for (const { line, methodName } of calls) {
      if (visited.has(methodName)) { continue; }
      const helperBounds = findBounds(methodName);
      if (!helperBounds) { continue; }

      const nextVisited = new Set(visited);
      nextVisited.add(methodName);

      results.push({ methodName, callSiteLine: line, bounds: helperBounds });

      // Recurse
      const nested = this.collectHelperRegionsBrace(
        helperBounds, callPattern, excludeSet, findBounds, depth + 1, nextVisited
      );
      results.push(...nested);
    }

    return results;
  }

  /**
   * Scan a helper region for all Temporal primitives using the provided patterns.
   * Returns nodes with original (non-virtual) lines.
   * Each entry in `patterns` is { pattern, nodeFactory }.
   */
  protected scanHelperForPrimitives(
    helperBounds: { start: number; end: number },
    patterns: Array<{
      pattern: RegExp;
      nodeFactory: (line: number, match: RegExpMatchArray) => WorkflowNode;
    }>
  ): WorkflowNode[] {
    const nodes: WorkflowNode[] = [];
    for (const { pattern, nodeFactory } of patterns) {
      this.findAllLinesInBounds(pattern, helperBounds).forEach(({ line, match }) => {
        nodes.push(nodeFactory(line, match));
      });
    }
    return nodes;
  }
}
