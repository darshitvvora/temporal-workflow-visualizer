import { BaseParser } from './baseParser';
import { WorkflowModel, WorkflowNode } from '../types';

// try {      } catch (SomeException $e) {   or multi-catch SomeException|Other $e
const PHP_TRY   = /\btry\s*\{/;
const PHP_CATCH = /\}\s*catch\s*\(\s*(\w+(?:\|\w+)*)\s+\$\w+\s*\)/;
// Activity call pattern: yield $this->anyStub->method( or yield $anyVar->method(
const PHP_ACT   = /yield\s+\$(?:this->\w+|\w+)->(\w+)\s*\(/;
const PHP_THROW = /throw\s+new\s+(\w+(?:Exception)?)\s*\(/;

export class PhpParser extends BaseParser {
  parse(): WorkflowModel | null {
    const classMatch = this.source.match(/class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+WorkflowInterface/);
    if (!classMatch) {
      const attrMatch = this.source.match(/(?:#\[WorkflowInterface\]|@WorkflowInterface)[\s\S]*?class\s+(\w+)/);
      if (!attrMatch) { return null; }
      return this.buildModel(attrMatch[1]);
    }
    return this.buildModel(classMatch[1]);
  }

  private buildModel(name: string): WorkflowModel {
    const nodes: WorkflowNode[] = [];

    const tryCatchBlocks = this.findTryCatchBlocks(PHP_TRY, PHP_CATCH);
    const catchLines  = this.buildCatchLineSet(tryCatchBlocks);
    const tryLineMap  = this.buildTryLineMap(tryCatchBlocks);

    // ── Activity calls ─────────────────────────────────────────────────────

    // yield $this->stub->methodName(...) or yield $localVar->method(...)
    this.findAllLines(/yield\s+\$(?:this->\w+|\w+)->(\w+)\s*\(/).forEach(({ line, match }) => {
      if (catchLines.has(line)) { return; }
      const tb = tryLineMap.get(line);
      const errorBranches = tb
        ? this.buildErrorBranchesFromCatch(tb, PHP_ACT, PHP_THROW)
        : undefined;
      nodes.push({
        id: this.toId(match[1], line),
        label: match[1],
        kind: 'activity',
        line,
        errorBranches: errorBranches?.length ? errorBranches : undefined,
      });
    });

    // Workflow::executeActivity (untyped direct execution)
    this.findAllLines(/Workflow::executeActivity\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      if (catchLines.has(line)) { return; }
      nodes.push({ id: this.toId('act_' + match[1], line), label: match[1], kind: 'activity', line });
    });

    // ── Signal handlers ────────────────────────────────────────────────────

    // @SignalMethod or #[SignalMethod] (PHP 8 attribute)
    this.findAllLines(/#\[SignalMethod[^\]]*\]|@SignalMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('signal_' + methodName), label: methodName + ' (signal)', kind: 'signal', line });
      }
    });
    // Dynamic signal handler registration
    this.findAllLines(/Workflow::registerSignal\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('signal_dyn_' + match[1], line), label: match[1] + ' (signal, dynamic)', kind: 'signal', line });
    });
    this.findAllLines(/Workflow::registerDynamicSignal\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `signal_dynamic_${line}`, label: 'dynamic signal handler', kind: 'signal', line });
    });

    // ── Query handlers ─────────────────────────────────────────────────────

    // @QueryMethod or #[QueryMethod] (PHP 8 attribute)
    this.findAllLines(/#\[QueryMethod[^\]]*\]|@QueryMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('query_' + methodName), label: methodName + ' (query)', kind: 'query', line });
      }
    });
    this.findAllLines(/Workflow::registerQuery\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('query_dyn_' + match[1], line), label: match[1] + ' (query, dynamic)', kind: 'query', line });
    });
    this.findAllLines(/Workflow::registerDynamicQuery\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `query_dynamic_${line}`, label: 'dynamic query handler', kind: 'query', line });
    });

    // ── Update handlers ────────────────────────────────────────────────────

    this.findAllLines(/#\[UpdateMethod[^\]]*\]|@UpdateMethod/).forEach(({ line }) => {
      const methodName = this.getNextPhpMethodName(line);
      if (methodName) {
        nodes.push({ id: this.toId('update_' + methodName), label: methodName + ' (update)', kind: 'signal', line });
      }
    });
    this.findAllLines(/Workflow::registerUpdate\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('update_dyn_' + match[1], line), label: match[1] + ' (update, dynamic)', kind: 'signal', line });
    });
    this.findAllLines(/Workflow::registerDynamicUpdate\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `update_dynamic_${line}`, label: 'dynamic update handler', kind: 'signal', line });
    });

    // ── Timers ─────────────────────────────────────────────────────────────

    this.findAllLines(/(?:Workflow::timer|yield\s+Workflow::timer)\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `timer_${line}`, label: 'timer', kind: 'timer', line });
      }
    });

    // ── Conditions & waiting ──────────────────────────────────────────────

    this.findAllLines(/Workflow::await\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `await_cond_${line}`, label: 'Workflow::await (condition)', kind: 'signal', line });
      }
    });
    this.findAllLines(/Workflow::awaitWithTimeout\s*\(/).forEach(({ line }) => {
      if (!catchLines.has(line)) {
        nodes.push({ id: `await_timeout_${line}`, label: 'awaitWithTimeout', kind: 'signal', line });
      }
    });

    // ── Side effects ───────────────────────────────────────────────────────

    this.findAllLines(/Workflow::sideEffect\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `side_effect_${line}`, label: 'sideEffect', kind: 'sideEffect', line });
    });

    // ── Versioning ─────────────────────────────────────────────────────────

    this.findAllLines(/Workflow::getVersion\s*\(\s*['"]([^'"]+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('version_' + match[1], line), label: 'getVersion: ' + match[1], kind: 'sideEffect', line });
    });

    // ── UUIDs ──────────────────────────────────────────────────────────────

    this.findAllLines(/Workflow::uuid4\s*\(|Workflow::uuid7\s*\(|Workflow::uuid\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `uuid_${line}`, label: 'uuid (deterministic)', kind: 'sideEffect', line });
    });

    // ── Memo & Search Attributes ───────────────────────────────────────────

    this.findAllLines(/Workflow::upsertMemo\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_memo_${line}`, label: 'upsertMemo', kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow::upsertSearchAttributes\s*\(|Workflow::upsertTypedSearchAttributes\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `upsert_sa_${line}`, label: 'upsertSearchAttributes', kind: 'sideEffect', line });
    });

    // ── Continue-As-New ────────────────────────────────────────────────────

    // Via stub: $this->newContinueAsNewStub()->method(...)
    this.findAllLines(/Workflow::newContinueAsNewStub\s*\(|continueAsNew\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `can_${line}`, label: 'continueAsNew', kind: 'sideEffect', line });
    });

    // ── External workflow handles ──────────────────────────────────────────

    this.findAllLines(/Workflow::newExternalWorkflowStub\s*\(|Workflow::newUntypedExternalWorkflowStub\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `ext_wf_${line}`, label: 'newExternalWorkflowStub', kind: 'childWorkflow', line });
    });

    // ── Child workflows ────────────────────────────────────────────────────

    this.findAllLines(/Workflow::newChildWorkflowStub\s*\(\s*(\w+)::class|Workflow::newUntypedChildWorkflowStub\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      const childName = match[1] || match[2] || 'ChildWorkflow';
      nodes.push({ id: this.toId('child_' + childName, line), label: childName + ' (child)', kind: 'childWorkflow', line });
    });
    this.findAllLines(/Workflow::executeChildWorkflow\s*\(\s*['"](\w+)["']/).forEach(({ line, match }) => {
      nodes.push({ id: this.toId('child_exec_' + match[1], line), label: match[1] + ' (child)', kind: 'childWorkflow', line });
    });

    // ── Async coroutine scopes ─────────────────────────────────────────────

    this.findAllLines(/Workflow::async\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `async_scope_${line}`, label: 'Workflow::async (coroutine)', kind: 'sideEffect', line });
    });
    this.findAllLines(/Workflow::asyncDetached\s*\(/).forEach(({ line }) => {
      nodes.push({ id: `async_detached_${line}`, label: 'Workflow::asyncDetached', kind: 'sideEffect', line });
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
