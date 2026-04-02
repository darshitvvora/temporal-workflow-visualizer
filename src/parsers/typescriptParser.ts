import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

// try {        catch (e) {     or    } catch (err: Some.Type) {
const TS_TRY     = /\btry\s*\{/;
const TS_CATCH   = /\}\s*catch\s*\((?:\w+\s*:\s*([\w.]+)|\w+)\s*\)/;
const TS_THROW   = /throw\s+new\s+(\w+(?:Error|Exception)?)\s*\(/;

export class TypeScriptParser extends BaseParser {
  parse(): WorkflowModel | null {
    const wfMatch = this.source.match(/export\s+async\s+function\s+(\w+)\s*\(/);
    if (!wfMatch) { return null; }
    const name = wfMatch[1];

    const { defaultOptions, activityNames, activitySet, proxyVarNames, localProxyVarNames } = this.parseProxyActivities();

    // Build try/catch structure
    const tryCatchBlocks = this.findTryCatchBlocks(TS_TRY, TS_CATCH);
    const catchLines = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap = this.buildTryLineMap(tryCatchBlocks);

    const nodes: WorkflowNode[] = [];
    const seenLines = new Set<number>();

    // Activity calls via destructured names: await chargeCard(...)
    for (const actName of activityNames) {
      this.findAllLines(new RegExp(`await\\s+${actName}\\s*\\(`)).forEach(({ line }) => {
        if (catchLines.has(line) || seenLines.has(line)) { return; }
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
        if (catchLines.has(line) || seenLines.has(line)) { return; }
        seenLines.add(line);
        const label = match[1].replace(/Async$/, '') + (isLocal ? ' (local)' : '');
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

    // ── Signal definitions ─────────────────────────────────────────────────

    this.findAllLines(/defineSignal\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', line });
    });
    // setDefaultSignalHandler — dynamic fallback
    this.findAllLines(/setDefaultSignalHandler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `default_signal_${line}`, label: 'default signal handler', kind: 'signal', line });
    });

    // ── Query definitions ──────────────────────────────────────────────────

    this.findAllLines(/defineQuery\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', line });
    });
    this.findAllLines(/setDefaultQueryHandler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `default_query_${line}`, label: 'default query handler', kind: 'query', line });
    });

    // ── Update definitions ─────────────────────────────────────────────────

    this.findAllLines(/defineUpdate\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('update_' + match[1]), label: match[1] + ' (update)', kind: 'signal', line });
    });
    this.findAllLines(/setDefaultUpdateHandler\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `default_update_${line}`, label: 'default update handler', kind: 'signal', line });
    });

    // ── Conditions & timers ────────────────────────────────────────────────

    this.findAllLines(/await\s+condition\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `condition_${line}`, label: 'condition', kind: 'signal', line });
      }
    });

    this.findAllLines(/await\s+sleep\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
      }
    });

    // ── Versioning / Patching ─────────────────────────────────────────────

    this.findAllLines(/patched\s*\(\s*['"]([^'"]+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('patch_' + match[1], line), label: 'patched: ' + match[1], kind: 'sideEffect', line });
    });
    this.findAllLines(/deprecatePatch\s*\(\s*['"]([^'"]+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('deprecate_patch_' + match[1], line), label: 'deprecatePatch: ' + match[1], kind: 'sideEffect', line });
    });

    // ── Side effects / randomness / UUIDs ─────────────────────────────────

    this.findAllLines(/uuid4\s*\(\s*\)/).forEach(({ line }) => {
      nodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/upsertMemo\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/upsertSearchAttributes\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsertSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    this.findAllLines(/continueAsNew\s*(?:<[^>]+>)?\s*\(|makeContinueAsNewFunc\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `can_${line}`, label: 'continueAsNew', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/getExternalWorkflowHandle\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `ext_wf_${line}`, label: 'getExternalWorkflowHandle', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/executeChild\s*\(\s*(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });
    this.findAllLines(/startChild\s*\(\s*(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_started_' + match[1], line), label: match[1] + ' (child, started)', kind: 'childWorkflow', line });
    });

    // ── Cancellation scopes ────────────────────────────────────────────────

    this.findAllLines(/CancellationScope\.(run|withTimeout|cancellable|nonCancellable)\s*\(/).forEach(({ line, match }) => {
      nodes.push({ id: `cancel_scope_${line}`, label: 'CancellationScope.' + match[1], kind: 'sideEffect', line });
    });

    // ── Nexus ──────────────────────────────────────────────────────────────

    this.findAllLines(/createNexusClient\s*(?:<[^>]+>)?\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `nexus_${line}`, label: 'createNexusClient', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);
    return { name, language: 'typescript', filePath: this.filePath, nodes, defaultOptions };
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
