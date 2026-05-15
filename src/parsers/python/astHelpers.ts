/**
 * Tree-sitter wrapper + Python-specific AST helpers.
 *
 * The web-tree-sitter API gives us a generic tree. Everything Python-shaped
 * (decorators, attribute paths, call arguments, function bodies) lives here so
 * the recognizer and the future parser can speak in domain terms.
 *
 * All grammar node-type strings come from
 * https://github.com/tree-sitter/tree-sitter-python/blob/master/src/grammar.json
 * and are kept here as named constants so accidental typos surface at the
 * import boundary.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Parser, Language, Tree, Node } from 'web-tree-sitter';

// ─────────────────────────────────────────────────────────────────────────────
// Parser singleton — tree-sitter requires async init exactly once per process.
// ─────────────────────────────────────────────────────────────────────────────

let cachedParser: Parser | null = null;
let cachedPythonLanguage: Language | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Default path resolver for the Python grammar WASM. Walks upward from this
 * file looking for `node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm`.
 *
 * Walking is necessary because the same source compiles to two different
 * on-disk layouts (src/… at dev time, out/src/… post-compile, and someday
 * a webpack/esbuild bundle). Callers can always override via
 * `initPythonParser({ pythonWasmPath })`.
 */
function defaultPythonWasmPath(): string {
  const target = path.join('node_modules', '@vscode', 'tree-sitter-wasm', 'wasm', 'tree-sitter-python.wasm');
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, target);
    if (fs.existsSync(candidate)) { return candidate; }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  throw new Error(
    `Could not locate ${target} relative to ${__dirname}. ` +
    `Pass pythonWasmPath explicitly to initPythonParser().`,
  );
}

/**
 * Initialize the tree-sitter Python parser. Safe to call repeatedly — work
 * is done exactly once.
 *
 * Must be awaited before calling `parsePython`.
 */
export function initPythonParser(opts?: {
  pythonWasmPath?: string;
  locateFile?: (file: string, scriptDir: string) => string;
}): Promise<void> {
  if (initPromise) { return initPromise; }
  initPromise = (async () => {
    await Parser.init(
      opts?.locateFile ? { locateFile: opts.locateFile } : undefined,
    );
    const wasmPath = opts?.pythonWasmPath ?? defaultPythonWasmPath();
    cachedPythonLanguage = await Language.load(wasmPath);
    cachedParser = new Parser();
    cachedParser.setLanguage(cachedPythonLanguage);
  })();
  return initPromise;
}

/**
 * Parse Python source into a tree-sitter Tree.
 *
 * Throws if `initPythonParser` has not been awaited.
 */
export function parsePython(source: string): Tree {
  if (!cachedParser) {
    throw new Error('parsePython called before initPythonParser — await initPythonParser() first');
  }
  const tree = cachedParser.parse(source);
  if (!tree) {
    throw new Error('tree-sitter returned null tree for Python source');
  }
  return tree;
}

/**
 * True when `initPythonParser` has resolved and a parser is ready to use.
 * Callers can use this to fail fast with a meaningful error instead of
 * relying on the lower-level `parsePython` throw.
 */
export function isParserInitialized(): boolean {
  return cachedParser !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Python grammar node-type constants
// ─────────────────────────────────────────────────────────────────────────────

export const PyNodeType = {
  Module:                'module',
  ClassDefinition:       'class_definition',
  FunctionDefinition:    'function_definition',
  DecoratedDefinition:   'decorated_definition',
  Decorator:             'decorator',
  Block:                 'block',
  ExpressionStatement:   'expression_statement',
  Call:                  'call',
  Attribute:             'attribute',
  Identifier:            'identifier',
  ArgumentList:          'argument_list',
  KeywordArgument:       'keyword_argument',
  Await:                 'await',
  IfStatement:           'if_statement',
  ElifClause:            'elif_clause',
  ElseClause:            'else_clause',
  ForStatement:          'for_statement',
  WhileStatement:        'while_statement',
  TryStatement:          'try_statement',
  ExceptClause:          'except_clause',
  FinallyClause:         'finally_clause',
  RaiseStatement:        'raise_statement',
  ReturnStatement:       'return_statement',
  WithStatement:         'with_statement',
  AssertStatement:       'assert_statement',
  AssignmentStatement:   'assignment',
  AugmentedAssignment:   'augmented_assignment',
  ImportStatement:       'import_statement',
  ImportFromStatement:   'import_from_statement',
  AliasedImport:         'aliased_import',
  DottedName:            'dotted_name',
  String:                'string',
  StringContent:         'string_content',
  ConcatenatedString:    'concatenated_string',
  Lambda:                'lambda',
  PassStatement:         'pass_statement',
  Comment:               'comment',
} as const;

export type PyNodeTypeName = (typeof PyNodeType)[keyof typeof PyNodeType];

// ─────────────────────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 1-based line number for the start of a node. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** 1-based line number for the end of a node (inclusive). */
export function endLineOf(node: Node): number {
  return node.endPosition.row + 1;
}

/** Iterate the *named* children of a node. */
export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

/** Walk every descendant, yielding each named node. */
export function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of namedChildren(node)) {
    yield* walk(child);
  }
}

/**
 * Find every descendant matching the predicate. Equivalent to filtering `walk`
 * but kept as a named helper so call sites read like intent.
 */
export function findAll(node: Node, predicate: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  for (const n of walk(node)) {
    if (predicate(n)) { out.push(n); }
  }
  return out;
}

/**
 * Find every descendant of one of the given node types.
 *
 * Slightly faster than `findAll(n => types.includes(n.type))` and reads
 * more naturally at call sites.
 */
export function findAllOfType(node: Node, types: PyNodeTypeName | PyNodeTypeName[]): Node[] {
  const set = new Set(Array.isArray(types) ? types : [types]);
  return findAll(node, n => set.has(n.type as PyNodeTypeName));
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute paths — the central abstraction for recognizing Temporal calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an expression tree to a dotted-name string IF it consists purely of
 * `Identifier` and `Attribute` nodes.
 *
 *   workflow.execute_activity              → "workflow.execute_activity"
 *   workflow.unsafe.is_replaying           → "workflow.unsafe.is_replaying"
 *   wf.execute_activity                    → "wf.execute_activity"
 *   self.workflow.execute_activity         → "self.workflow.execute_activity"
 *   handle.signal                          → "handle.signal"
 *
 * Returns null for anything else (subscript, call result, lambda, etc.).
 * This is intentionally strict: the recognizer only uses the result for
 * exact catalog lookups, so a returned string must be unambiguous.
 */
export function attributePath(node: Node): string | null {
  if (node.type === PyNodeType.Identifier) {
    return node.text;
  }
  if (node.type === PyNodeType.Attribute) {
    const object = node.childForFieldName('object');
    const attr = node.childForFieldName('attribute');
    if (!object || !attr || attr.type !== PyNodeType.Identifier) { return null; }
    const inner = attributePath(object);
    if (inner === null) { return null; }
    return `${inner}.${attr.text}`;
  }
  return null;
}

/**
 * For a Call node, return the dotted name of its callee (e.g. `workflow.sleep`),
 * or null if the callee is not a pure attribute path.
 *
 * NB: this is the *literal source-level* path. To get the canonical
 * Temporal-SDK form, the import context must resolve the head identifier
 * (`wf` → `workflow`, `sleep` → `workflow.sleep`, etc.).
 */
export function callTargetPath(callNode: Node): string | null {
  if (callNode.type !== PyNodeType.Call) { return null; }
  const fn = callNode.childForFieldName('function');
  if (!fn) { return null; }
  return attributePath(fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Decorators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decorators in tree-sitter-python appear as siblings inside a
 * `decorated_definition` node. The decorator node's first named child is
 * either an Identifier, an Attribute, or a Call (when called with arguments).
 *
 * Returns the dotted name of the decorator (without the `@` and without any
 * arguments). Examples:
 *
 *   @workflow.defn                    → "workflow.defn"
 *   @workflow.defn(sandboxed=False)   → "workflow.defn"
 *   @workflow.signal(name="cancel")   → "workflow.signal"
 *   @my_module.helper                 → "my_module.helper"
 *   @custom_func()                    → "custom_func"
 *
 * Returns null for decorators that aren't pure attribute paths.
 */
export function decoratorName(decoratorNode: Node): string | null {
  if (decoratorNode.type !== PyNodeType.Decorator) { return null; }
  // The grammar shape is: `decorator` → "@" expression NEWLINE
  // We want the first named child that holds the expression.
  const expr = namedChildren(decoratorNode)[0];
  if (!expr) { return null; }
  if (expr.type === PyNodeType.Call) {
    return callTargetPath(expr);
  }
  return attributePath(expr);
}

/**
 * Extract the keyword argument value's raw text from a decorator like
 * `@workflow.signal(name="cancel")`. Returns undefined if no such kwarg.
 *
 * Useful for: `name="..."` on signal/query/update decorators (defines the
 * external name used by callers, which may differ from the Python method).
 */
export function decoratorKwarg(decoratorNode: Node, kwargName: string): string | undefined {
  if (decoratorNode.type !== PyNodeType.Decorator) { return undefined; }
  const expr = namedChildren(decoratorNode)[0];
  if (!expr || expr.type !== PyNodeType.Call) { return undefined; }
  const args = expr.childForFieldName('arguments');
  if (!args) { return undefined; }
  for (const child of namedChildren(args)) {
    if (child.type !== PyNodeType.KeywordArgument) { continue; }
    const name = child.childForFieldName('name');
    if (name?.text === kwargName) {
      const value = child.childForFieldName('value');
      return value ? value.text : undefined;
    }
  }
  return undefined;
}

/**
 * Return the (decorator names, definition node) for a decorated definition.
 *
 * `decoratorNames` is in source order (top-down).
 * For an undecorated definition, returns `{ decoratorNames: [], definition: node }`
 * when called with a plain `function_definition` or `class_definition`.
 */
export function unwrapDecorated(node: Node): { decoratorNames: string[]; definition: Node } | null {
  if (node.type === PyNodeType.DecoratedDefinition) {
    const decoratorNames: string[] = [];
    let definition: Node | null = null;
    for (const child of namedChildren(node)) {
      if (child.type === PyNodeType.Decorator) {
        const n = decoratorName(child);
        if (n) { decoratorNames.push(n); }
      } else if (child.type === PyNodeType.FunctionDefinition || child.type === PyNodeType.ClassDefinition) {
        definition = child;
      }
    }
    if (!definition) { return null; }
    return { decoratorNames, definition };
  }
  if (node.type === PyNodeType.FunctionDefinition || node.type === PyNodeType.ClassDefinition) {
    return { decoratorNames: [], definition: node };
  }
  return null;
}

/**
 * Yield every decorator NODE for a decorated definition, preserving order.
 * Each yielded node is a `decorator` AST node (use `decoratorName` /
 * `decoratorKwarg` to inspect it).
 */
export function* decorators(node: Node): Generator<Node> {
  if (node.type !== PyNodeType.DecoratedDefinition) { return; }
  for (const child of namedChildren(node)) {
    if (child.type === PyNodeType.Decorator) { yield child; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Class / function structure
// ─────────────────────────────────────────────────────────────────────────────

/** The `body` field of a function/class (`block` node), or null. */
export function bodyOf(definitionNode: Node): Node | null {
  return definitionNode.childForFieldName('body');
}

/** The `name` field of a function/class as text, or null. */
export function nameOf(definitionNode: Node): string | null {
  const n = definitionNode.childForFieldName('name');
  return n ? n.text : null;
}

/**
 * Walk a class body and yield each top-level method (function or async
 * function definition), preserving any decorators on them.
 *
 * Yields the wrapping `decorated_definition` if present, else the bare
 * `function_definition`. Use `unwrapDecorated` on each yield to introspect.
 */
export function* classMethods(classNode: Node): Generator<Node> {
  const body = bodyOf(classNode);
  if (!body) { return; }
  for (const stmt of namedChildren(body)) {
    if (stmt.type === PyNodeType.FunctionDefinition || stmt.type === PyNodeType.DecoratedDefinition) {
      yield stmt;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Calls — argument extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract positional and keyword arguments from a Call node.
 *
 * The returned objects preserve the underlying AST node so the caller can
 * read text, line numbers, or recurse for nested calls.
 */
export interface CallArgs {
  positional: Node[];
  keyword: Map<string, Node>;
}

export function callArgs(callNode: Node): CallArgs {
  const result: CallArgs = { positional: [], keyword: new Map() };
  if (callNode.type !== PyNodeType.Call) { return result; }
  const args = callNode.childForFieldName('arguments');
  if (!args) { return result; }
  for (const child of namedChildren(args)) {
    if (child.type === PyNodeType.KeywordArgument) {
      const name = child.childForFieldName('name');
      const value = child.childForFieldName('value');
      if (name && value) { result.keyword.set(name.text, value); }
    } else {
      result.positional.push(child);
    }
  }
  return result;
}

/**
 * Read a string literal's content (without quotes). Returns the value if the
 * node is a string literal that consists of a single static segment;
 * returns undefined for f-strings with interpolations, byte strings, or
 * non-string nodes.
 *
 * Used for things like extracting `"transfer_funds"` from
 * `execute_activity("transfer_funds", ...)`.
 */
export function stringLiteralValue(node: Node): string | undefined {
  if (node.type !== PyNodeType.String) { return undefined; }
  // tree-sitter-python represents string contents as one or more
  // `string_content` children sandwiched between `string_start` and `string_end`.
  // For our purposes we accept a single string_content child.
  const contents = namedChildren(node).filter(c => c.type === PyNodeType.StringContent);
  if (contents.length !== 1) { return undefined; }
  return contents[0].text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Awaited-call helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Call node that is the operand of an `await` expression,
 * or null if `awaitNode` isn't an await of a call.
 *
 *   await workflow.execute_activity(...)
 *         └─── this Call node returned ───┘
 */
export function awaitedCall(awaitNode: Node): Node | null {
  if (awaitNode.type !== PyNodeType.Await) { return null; }
  const inner = namedChildren(awaitNode)[0];
  if (!inner) { return null; }
  if (inner.type === PyNodeType.Call) { return inner; }
  return null;
}

/**
 * Whether `callNode` is the direct operand of an `await` expression in the
 * source. Used by the recognizer to distinguish `await workflow.execute_activity(...)`
 * from a bare reference such as `handle = workflow.start_activity(...)`.
 */
export function isAwaited(callNode: Node): boolean {
  const parent = callNode.parent;
  return !!parent && parent.type === PyNodeType.Await;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comment / blank filtering — useful when reasoning about a method body
// ─────────────────────────────────────────────────────────────────────────────

/** True if a node is a comment or pass statement (no flow significance). */
export function isTrivialStatement(node: Node): boolean {
  return node.type === PyNodeType.Comment || node.type === PyNodeType.PassStatement;
}
