import { WorkflowModel, ActivityOptions } from '../types';

export abstract class BaseParser {
  protected lines: string[];

  constructor(protected source: string, protected filePath: string) {
    this.lines = source.split('\n');
  }

  abstract parse(): WorkflowModel | null;

  /** Returns 1-based line number of first line matching the regex, or -1 */
  protected findLine(pattern: RegExp, startFrom = 0): number {
    for (let i = startFrom; i < this.lines.length; i++) {
      if (pattern.test(this.lines[i])) {
        return i + 1;
      }
    }
    return -1;
  }

  /** Returns all {line (1-based), match} pairs for a pattern */
  protected findAllLines(pattern: RegExp): Array<{ line: number; match: RegExpMatchArray }> {
    const results: Array<{ line: number; match: RegExpMatchArray }> = [];
    this.lines.forEach((text, i) => {
      const m = text.match(pattern);
      if (m) {
        results.push({ line: i + 1, match: m });
      }
    });
    return results;
  }

  /** Extract block starting from startLine until braces are balanced */
  protected extractBlock(startLine: number, maxLines = 50): string {
    let depth = 0;
    const collected: string[] = [];
    for (let i = startLine - 1; i < Math.min(this.lines.length, startLine - 1 + maxLines); i++) {
      const l = this.lines[i];
      depth += (l.match(/\{/g) || []).length;
      depth -= (l.match(/\}/g) || []).length;
      collected.push(l);
      if (depth === 0 && collected.length > 1) {
        break;
      }
    }
    return collected.join('\n');
  }

  /** Slugify into a safe Mermaid node ID */
  protected toId(name: string, suffix?: string | number): string {
    const base = name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    return suffix !== undefined ? `${base}_${suffix}` : base;
  }

  /** Parse duration strings like "5s", "1m", "30000ms" into a readable string */
  protected normalizeDuration(value: string): string {
    return value.trim();
  }

  /** Build a partial ActivityOptions from a text block using generic patterns */
  protected parseGenericOptions(block: string): ActivityOptions {
    const opts: ActivityOptions = {};

    const stc = block.match(/[Ss]tart[Tt]o[Cc]lose[Tt]imeout['":\s]+([^\s,}\n'"]+)/);
    if (stc) { opts.startToCloseTimeout = stc[1]; }

    const stc2 = block.match(/[Ss]chedule[Tt]o[Cc]lose[Tt]imeout['":\s]+([^\s,}\n'"]+)/);
    if (stc2) { opts.scheduleToCloseTimeout = stc2[1]; }

    const sts = block.match(/[Ss]chedule[Tt]o[Ss]tart[Tt]imeout['":\s]+([^\s,}\n'"]+)/);
    if (sts) { opts.scheduleToStartTimeout = sts[1]; }

    const hb = block.match(/[Hh]eartbeat[Tt]imeout['":\s]+([^\s,}\n'"]+)/);
    if (hb) { opts.heartbeatTimeout = hb[1]; }

    return opts;
  }
}
