/**
 * Import-context resolver.
 *
 * A Python developer can refer to a Temporal SDK primitive in several ways:
 *
 *   from temporalio import workflow            → workflow.execute_activity(...)
 *   from temporalio import workflow as wf      → wf.execute_activity(...)
 *   import temporalio.workflow                 → temporalio.workflow.execute_activity(...)
 *   import temporalio.workflow as wf           → wf.execute_activity(...)
 *   from temporalio.workflow import sleep      → sleep(...)          (bare)
 *   from temporalio.workflow import sleep as s → s(...)              (bare alias)
 *   from temporalio.workflow import unsafe     → unsafe.is_replaying(...)
 *
 * Likewise for `temporalio.activity`, `temporalio.exceptions`, and `asyncio`.
 *
 * This module walks the top-level `import` / `from ... import ...` statements
 * of a module and produces a map that the recognizer uses to rewrite a
 * source-level attribute path (e.g. `wf.execute_activity`) into its canonical
 * SDK form (`workflow.execute_activity`).
 *
 * Design notes:
 *
 *  - We only consider module-level imports. Imports inside functions are rare
 *    in workflow files and not necessary for the visualizer.
 *  - We never resolve via runtime metadata — purely lexical. Anything we can't
 *    resolve, the recognizer treats as "not a Temporal primitive".
 *  - The canonical form mirrors the catalog's `qualifiedName`. So:
 *      workflow.*           → "workflow.<name>"
 *      workflow.unsafe.*    → "workflow.unsafe.<name>"
 *      activity.*           → "activity.<name>"
 *      asyncio.*            → "asyncio.<name>"
 *      temporalio.exceptions.* → "<ExceptionName>" used in except clauses; we
 *                                expose those separately via `isTemporalException`.
 */

import { Node } from 'web-tree-sitter';
import {
  PyNodeType,
  namedChildren,
} from './astHelpers';
import {
  TEMPORAL_EXCEPTION_NAMES,
  TEMPORAL_SDK_BY_QUALIFIED_NAME,
} from './temporalSdk';

/**
 * Which canonical module a source-level alias maps to.
 * The recognizer uses this to rewrite call/attribute paths into catalog form.
 */
export type CanonicalModule =
  | 'workflow'          // temporalio.workflow
  | 'workflow.unsafe'   // temporalio.workflow.unsafe
  | 'activity'          // temporalio.activity
  | 'asyncio';          // asyncio (stdlib)

export interface ImportContext {
  /**
   * Map from a source-level top identifier → canonical module.
   * Examples after `from temporalio import workflow as wf`:
   *   "wf" → "workflow"
   * After `import asyncio`:
   *   "asyncio" → "asyncio"
   * After `from temporalio.workflow import unsafe`:
   *   "unsafe" → "workflow.unsafe"
   */
  moduleAliases: Map<string, CanonicalModule>;

  /**
   * Map from a source-level top identifier → canonical *fully qualified*
   * primitive name from the catalog. Populated by `from <module> import <name>`
   * forms.
   *
   * Example after `from temporalio.workflow import sleep as s`:
   *   "s" → "workflow.sleep"
   *
   * Recognizer uses this for bare-identifier calls like `s(...)`.
   */
  primitiveAliases: Map<string, string>;

  /**
   * Symbols imported from `temporalio.exceptions`. Used for labeling
   * `except <ErrorName>:` clauses in the recognizer's error-branch handling.
   *
   * Example after `from temporalio.exceptions import ActivityError as AE`:
   *   "AE" → "ActivityError"
   */
  exceptionAliases: Map<string, string>;
}

/**
 * Build an ImportContext from the root (Module) AST node.
 *
 * Only top-level statements are scanned. The function is total: malformed or
 * unrecognized imports are simply skipped.
 */
export function buildImportContext(rootNode: Node): ImportContext {
  const ctx: ImportContext = {
    moduleAliases: new Map(),
    primitiveAliases: new Map(),
    exceptionAliases: new Map(),
  };

  if (rootNode.type !== PyNodeType.Module) {
    // Caller may pass a non-Module (e.g. when testing). Fall back to scanning
    // direct children for import statements without recursing.
  }

  for (const stmt of namedChildren(rootNode)) {
    if (stmt.type === PyNodeType.ImportStatement) {
      handleImportStatement(stmt, ctx);
    } else if (stmt.type === PyNodeType.ImportFromStatement) {
      handleImportFromStatement(stmt, ctx);
    }
  }

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// `import x` / `import x as y` / `import x.y.z`
// ─────────────────────────────────────────────────────────────────────────────

function handleImportStatement(node: Node, ctx: ImportContext): void {
  // The grammar represents this as:
  //   import_statement → "import" (dotted_name | aliased_import) ("," ...)*
  // We iterate named children and handle each module clause.
  for (const child of namedChildren(node)) {
    if (child.type === PyNodeType.DottedName) {
      // `import temporalio.workflow` → top identifier is `temporalio`.
      // Python binds the *top-level* name in the importing scope, so
      // references look like `temporalio.workflow.X`. We don't usefully
      // recognize this form unless followed by `.workflow` / `.workflow.unsafe`
      // — see resolveAttributePath below, which special-cases the
      // `temporalio.workflow.*` prefix.
      const parts = dottedNameParts(child);
      if (parts.length === 0) { continue; }
      const top = parts[0];
      // Bind the top-level name to a synthetic "temporalio" module so the
      // resolver can tell it apart from arbitrary identifiers.
      bindModule(ctx, top, mapTemporalioPath(parts));
    } else if (child.type === PyNodeType.AliasedImport) {
      // `import temporalio.workflow as wf`
      const moduleName = child.childForFieldName('name');
      const aliasName = child.childForFieldName('alias');
      if (!moduleName || !aliasName) { continue; }
      const parts = moduleName.type === PyNodeType.DottedName
        ? dottedNameParts(moduleName)
        : [moduleName.text];
      bindModule(ctx, aliasName.text, mapTemporalioPath(parts));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `from x import a, b as c, ...`
// ─────────────────────────────────────────────────────────────────────────────

function handleImportFromStatement(node: Node, ctx: ImportContext): void {
  // Grammar:
  //   import_from_statement → "from" module "import" (name | aliased_import | "*") ("," ...)*
  // The module is in field `module_name`; the imported names are listed after
  // the "import" keyword as named children (excluding the module).
  const moduleField = node.childForFieldName('module_name');
  if (!moduleField) { return; }

  const fromParts = moduleField.type === PyNodeType.DottedName
    ? dottedNameParts(moduleField)
    : [moduleField.text];

  const fromModule = mapTemporalioPath(fromParts);

  // The "name" field on import_from_statement is repeatable in this grammar;
  // we iterate named children and pick out the ones that come after the module
  // field. Easiest: iterate all named children and skip the one equal to
  // moduleField by node id.
  for (const child of namedChildren(node)) {
    if (child.id === moduleField.id) { continue; }
    if (child.type === PyNodeType.DottedName) {
      // Plain `from x import y`. y is a dotted_name with one identifier child.
      const parts = dottedNameParts(child);
      if (parts.length !== 1) { continue; }
      const imported = parts[0];
      bindFromImport(ctx, fromModule, fromParts, imported, imported);
    } else if (child.type === PyNodeType.AliasedImport) {
      const nameField = child.childForFieldName('name');
      const aliasField = child.childForFieldName('alias');
      if (!nameField || !aliasField) { continue; }
      const importedName = nameField.type === PyNodeType.DottedName
        ? dottedNameParts(nameField).join('.')
        : nameField.text;
      bindFromImport(ctx, fromModule, fromParts, importedName, aliasField.text);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a source-level attribute path (as produced by `attributePath` in
 * astHelpers), return its canonical Temporal-SDK form, or null if it does
 * not resolve to anything in the catalog.
 *
 * Examples (with `import temporalio.workflow as wf`):
 *   "wf.execute_activity"        → "workflow.execute_activity"
 *   "wf.unsafe.is_replaying"     → "workflow.unsafe.is_replaying"
 *
 * Examples (with `from temporalio.workflow import sleep`):
 *   "sleep"                      → "workflow.sleep"
 *
 * Examples (with `import temporalio.workflow`):
 *   "temporalio.workflow.sleep"  → "workflow.sleep"
 *
 * Returns null for any path whose head is unknown to the import context.
 */
export function resolveAttributePath(ctx: ImportContext, path: string): string | null {
  const segments = path.split('.');
  if (segments.length === 0) { return null; }

  // Case 1 — bare identifier resolving to a specific primitive
  // (e.g. `sleep` after `from temporalio.workflow import sleep`).
  if (segments.length === 1) {
    const primitive = ctx.primitiveAliases.get(segments[0]);
    if (primitive && TEMPORAL_SDK_BY_QUALIFIED_NAME.has(primitive)) {
      return primitive;
    }
    return null;
  }

  // Case 2 — head identifier is a module alias.
  const head = segments[0];
  const module = ctx.moduleAliases.get(head);
  if (module) {
    const tail = segments.slice(1).join('.');
    const canonical = `${module}.${tail}`;
    if (TEMPORAL_SDK_BY_QUALIFIED_NAME.has(canonical)) { return canonical; }
    return null;
  }

  // Case 3 — `from temporalio.workflow import unsafe` etc. The first segment
  // is itself a primitive-alias entry, and we extend it with the remaining
  // path. Example: primitive alias "unsafe" → "workflow.unsafe", then
  // path "unsafe.is_replaying" → "workflow.unsafe.is_replaying".
  const primitivePrefix = ctx.primitiveAliases.get(head);
  if (primitivePrefix) {
    const tail = segments.slice(1).join('.');
    const canonical = `${primitivePrefix}.${tail}`;
    if (TEMPORAL_SDK_BY_QUALIFIED_NAME.has(canonical)) { return canonical; }
    return null;
  }

  return null;
}

/**
 * True if `name` (as it appeared in an `except <name>` clause) is a Temporal
 * exception class, taking the import context's aliases into account.
 *
 * Accepts both fully aliased names (e.g. `AE` if the file did `import ... as AE`)
 * and bare class names imported directly.
 */
export function isTemporalException(ctx: ImportContext, name: string): boolean {
  // Was it imported from temporalio.exceptions?
  const canonical = ctx.exceptionAliases.get(name);
  if (canonical) { return TEMPORAL_EXCEPTION_NAMES.has(canonical); }
  // Or did the user `import temporalio.exceptions as exc` and write
  // `except exc.ActivityError`? In that case the source-level name in the
  // except clause is `exc.ActivityError`; we resolve it via attribute path.
  const segments = name.split('.');
  if (segments.length >= 2) {
    const head = segments[0];
    const module = ctx.moduleAliases.get(head);
    if (module === 'asyncio' || module === 'activity') { return false; }
    if (module === 'workflow') {
      const tail = segments.slice(1).join('.');
      // workflow-module exceptions are in the catalog under workflow.<Name>
      return TEMPORAL_SDK_BY_QUALIFIED_NAME.has(`workflow.${tail}`);
    }
  }
  // Fallback — accept the bare catalog name (e.g. `except ActivityError:` with
  // no explicit import statement found by us; common in IDE-driven files).
  return TEMPORAL_EXCEPTION_NAMES.has(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function dottedNameParts(dottedNameNode: Node): string[] {
  return namedChildren(dottedNameNode)
    .filter(c => c.type === PyNodeType.Identifier)
    .map(c => c.text);
}

/**
 * Map an import-source dotted-name to a CanonicalModule, or null if the
 * module isn't one we care about.
 *
 *   ["temporalio", "workflow"]         → "workflow"
 *   ["temporalio", "workflow", "unsafe"] → "workflow.unsafe"
 *   ["temporalio", "activity"]         → "activity"
 *   ["asyncio"]                        → "asyncio"
 *   anything else                      → null
 */
function mapTemporalioPath(parts: string[]): CanonicalModule | null {
  if (parts.length === 1 && parts[0] === 'asyncio') { return 'asyncio'; }
  if (parts.length >= 2 && parts[0] === 'temporalio') {
    if (parts[1] === 'workflow') {
      if (parts.length === 2) { return 'workflow'; }
      if (parts.length === 3 && parts[2] === 'unsafe') { return 'workflow.unsafe'; }
    }
    if (parts[1] === 'activity' && parts.length === 2) { return 'activity'; }
  }
  return null;
}

function bindModule(
  ctx: ImportContext,
  alias: string,
  module: CanonicalModule | null,
): void {
  if (module === null) { return; }
  ctx.moduleAliases.set(alias, module);
}

/**
 * Bind a `from <fromModule> import <imported> as <alias>` clause.
 * `imported` may itself be dotted, but tree-sitter-python forbids dotted
 * names in `from ... import` so we treat it as a single segment.
 */
function bindFromImport(
  ctx: ImportContext,
  fromModule: CanonicalModule | null,
  fromParts: string[],
  imported: string,
  alias: string,
): void {
  // 1. Exceptions module → exceptionAliases
  if (fromParts.length === 2 && fromParts[0] === 'temporalio' && fromParts[1] === 'exceptions') {
    if (TEMPORAL_EXCEPTION_NAMES.has(imported)) {
      ctx.exceptionAliases.set(alias, imported);
    }
    return;
  }

  // 2. `from temporalio import workflow [as wf]` / `from temporalio import activity [as a]`
  //    fromModule is null here (mapTemporalioPath rejects bare "temporalio") but
  //    this is the canonical way Python developers import the workflow module,
  //    so handle it explicitly before bailing out.
  if (fromParts.length === 1 && fromParts[0] === 'temporalio') {
    if (imported === 'workflow') { ctx.moduleAliases.set(alias, 'workflow'); return; }
    if (imported === 'activity') { ctx.moduleAliases.set(alias, 'activity'); return; }
    return;
  }

  if (!fromModule) { return; }

  // 3. `from temporalio.workflow import unsafe [as u]` — the import is itself a
  //    submodule. Bind alias → "workflow.unsafe" as a module alias.
  if (fromModule === 'workflow' && imported === 'unsafe') {
    ctx.moduleAliases.set(alias, 'workflow.unsafe');
    return;
  }

  // 4. `from temporalio.workflow import sleep [as s]` / `from asyncio import gather`
  //    The imported symbol is a primitive. Bind alias → "<module>.<name>".
  const canonical = `${fromModule}.${imported}`;
  if (TEMPORAL_SDK_BY_QUALIFIED_NAME.has(canonical)) {
    ctx.primitiveAliases.set(alias, canonical);
  }
}
