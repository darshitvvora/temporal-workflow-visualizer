import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode, ActivityOptions, RetryPolicy } from '../types';

export class TypeScriptParser extends BaseParser {
  parse(): WorkflowModel | null {
    // Workflow function: export async function XxxWorkflow(
    const wfMatch = this.source.match(/export\s+async\s+function\s+(\w+)\s*\(/);
    if (!wfMatch) { return null; }
    const name = wfMatch[1];

    const { defaultOptions, activityNames } = this.parseProxyActivities();
    const nodes: WorkflowNode[] = [];

    // Activity calls: await activityNameAsync(  or await activityName(
    // Match each known proxied activity name at its call site
    for (const actName of activityNames) {
      this.findAllLines(new RegExp(`await\\s+${actName}\\s*\\(`)).forEach(({ line }) => {
        // Display label strips trailing "Async" suffix
        const label = actName.replace(/Async$/, '');
        nodes.push({
          id: this.toId(label, line),
          label,
          kind: 'activity',
          line,
          options: defaultOptions ? { ...defaultOptions } : undefined,
        });
      });
    }

    // Query definitions: defineQuery<T>('name')
    this.findAllLines(/defineQuery\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_' + match[1]), label: match[1] + ' (query)', kind: 'query', line });
    });

    // Signal definitions: defineSignal('name')
    this.findAllLines(/defineSignal\s*(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_' + match[1]), label: match[1] + ' (signal)', kind: 'signal', line });
    });

    // sleep calls
    this.findAllLines(/await\s+sleep\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `sleep_${line}`, label: 'sleep', kind: 'timer', line });
    });

    // uuid4 (side effect / idempotency key)
    this.findAllLines(/uuid4\s*\(\s*\)/).forEach(({ line }) => {
      nodes.push({ id: `uuid4_${line}`, label: 'uuid4 (idempotencyKey)', kind: 'sideEffect', line });
    });

    // executeChild
    this.findAllLines(/executeChild\s*\(\s*(\w+)/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    nodes.sort((a, b) => a.line - b.line);

    return { name, language: 'typescript', filePath: this.filePath, nodes, defaultOptions };
  }

  private parseProxyActivities(): { defaultOptions?: ActivityOptions; activityNames: string[] } {
    // Find: const { a, b, c } = proxyActivities<...>({ ... })
    const destructureMatch = this.source.match(
      /const\s+\{([^}]+)\}\s*=\s*\n?\s*proxyActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/
    );

    let activityNames: string[] = [];
    let defaultOptions: ActivityOptions | undefined;

    if (destructureMatch) {
      activityNames = destructureMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const block = destructureMatch[2];
      defaultOptions = this.parseOptionsBlock(block);
    } else {
      // Fallback: look for proxyActivities call without capturing names
      const proxyMatch = this.source.match(/proxyActivities\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/);
      if (proxyMatch) {
        defaultOptions = this.parseOptionsBlock(proxyMatch[1]);
      }
    }

    return { defaultOptions, activityNames };
  }

  private parseOptionsBlock(block: string): ActivityOptions | undefined {
    const opts: ActivityOptions = {};

    // startToCloseTimeout: '5s' or "5 seconds"
    const stc = block.match(/startToCloseTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (stc) { opts.startToCloseTimeout = stc[1]; }

    const sc = block.match(/scheduleToCloseTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (sc) { opts.scheduleToCloseTimeout = sc[1]; }

    const sts = block.match(/scheduleToStartTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (sts) { opts.scheduleToStartTimeout = sts[1]; }

    const hb = block.match(/heartbeatTimeout\s*:\s*['"]([^'"]+)['"]/);
    if (hb) { opts.heartbeatTimeout = hb[1]; }

    // retry: { initialInterval: '1s', ... } or retry: DEFAULT_RETRY_POLICY
    const retryInline = block.match(/retry\s*:\s*\{([\s\S]*?)\}/);
    const retryVar = block.match(/retry\s*:\s*(\w+)/);

    let retryBlock = '';
    if (retryInline) {
      retryBlock = retryInline[1];
    } else if (retryVar) {
      // Look up the named constant
      const constMatch = this.source.match(
        new RegExp(`const\\s+${retryVar[1]}[^=]*=\\s*\\{([\\s\\S]*?)\\}`)
      );
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
