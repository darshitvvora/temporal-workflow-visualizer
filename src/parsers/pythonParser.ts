/**
 * AST-based Python parser for Temporal workflow visualization.
 *
 * Orchestration:
 *
 *   source text
 *     ↓  parsePython() (tree-sitter)
 *   AST
 *     ↓  buildImportContext()
 *   ImportContext (resolves `wf` / `unsafe` / `sleep` aliases)
 *     ↓  buildWorkflowCfg()
 *   WorkflowCfg (structured: if / try / for / while / with / match)
 *     ↓  cfgToWorkflowModel()
 *   WorkflowModel (the existing flat shape that diagramGenerator consumes)
 *
 * The parser does NOT initialize tree-sitter — that's done once at extension
 * activation via `initPythonParser()`. If parse() is called before the
 * runtime is ready, we throw a clear error rather than blocking.
 *
 * Replaces the prior regex-based PythonParser, which mis-handled control flow
 * (no real branching, line-sort-only ordering, brittle indentation tracking).
 */

import { BaseParser } from './baseParser';
import { WorkflowModel } from '../types';

import { parsePython, isParserInitialized } from './python/astHelpers';
import { buildImportContext } from './python/importContext';
import {
  recognizeWorkflowClass,
} from './python/primitiveRecognizer';
import { buildWorkflowCfg } from './python/cfgBuilder';
import { cfgToWorkflowModel } from './python/cfgToModel';
import { WorkflowCfg, flattenPrimitives } from './python/cfgTypes';
import { PyNodeType, namedChildren, unwrapDecorated } from './python/astHelpers';
import { Node } from 'web-tree-sitter';

export class PythonParser extends BaseParser {
  parse(): WorkflowModel | null {
    if (!isParserInitialized()) {
      throw new Error(
        'Python tree-sitter runtime not initialized. ' +
        'Call initPythonParser() during extension activation before parsing.',
      );
    }

    const tree = parsePython(this.source);
    const root = tree.rootNode;
    const ctx = buildImportContext(root);

    // Find every @workflow.defn class and build its CFG. If more than one
    // workflow class is defined in the file (unusual but valid), pick the
    // one with the most flow-relevant primitives — same selection rule the
    // old parser used.
    const candidates: WorkflowCfg[] = [];
    for (const stmt of namedChildren(root)) {
      const classNode = unwrapWorkflowClassNode(stmt);
      if (!classNode) { continue; }
      if (!recognizeWorkflowClass(classNode, ctx)) { continue; }
      const cfg = buildWorkflowCfg(classNode, ctx);
      if (cfg) { candidates.push(cfg); }
    }

    if (candidates.length === 0) { return null; }

    candidates.sort((a, b) => primitiveCount(b) - primitiveCount(a));
    const chosen = candidates[0];

    return cfgToWorkflowModel(chosen, {
      filePath: this.filePath,
      source: this.source,
    });
  }
}

/**
 * If `stmt` is a `decorated_definition` wrapping a class, return the
 * wrapping node (which is what recognizeWorkflowClass / buildWorkflowCfg
 * expect as input). Returns null for any other statement.
 */
function unwrapWorkflowClassNode(stmt: Node): Node | null {
  if (stmt.type !== PyNodeType.DecoratedDefinition) { return null; }
  const u = unwrapDecorated(stmt);
  if (!u || u.definition.type !== PyNodeType.ClassDefinition) { return null; }
  return stmt;
}

function primitiveCount(cfg: WorkflowCfg): number {
  let n = 0;
  if (cfg.run) {
    for (const _ of flattenPrimitives(cfg.run.body)) { n++; }
  }
  return n;
}
