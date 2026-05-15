import * as path from 'path';
import * as vscode from 'vscode';
import { createParser } from './parsers/parserFactory';
import { initPythonParser } from './parsers/python/astHelpers';
import { WorkflowDiagramPanel } from './webviewPanel';

/**
 * Resolve the Python tree-sitter WASM relative to the extension install
 * directory rather than relying on `__dirname` walking. The WASM ships under
 * `node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm` and
 * its location relative to the compiled `extension.js` is stable.
 */
function pythonWasmPathFor(extensionUri: vscode.Uri): string {
  return path.join(
    extensionUri.fsPath,
    'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm', 'tree-sitter-python.wasm',
  );
}

/**
 * Initialize the Python tree-sitter runtime. Triggered lazily the first time
 * a `.py` file is parsed so we don't pay the WASM-load cost for users who
 * only work in Go/TS/Java/etc.
 *
 * The returned promise is cached — concurrent callers share the same init.
 */
let pythonInitPromise: Promise<void> | null = null;
function ensurePythonReady(extensionUri: vscode.Uri): Promise<void> {
  if (!pythonInitPromise) {
    pythonInitPromise = initPythonParser({ pythonWasmPath: pythonWasmPathFor(extensionUri) });
  }
  return pythonInitPromise;
}

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('temporalVisualizer.showDiagram', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor. Open a Temporal workflow file first.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const source = editor.document.getText();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Parsing Temporal workflow…',
        cancellable: false,
      },
      async () => {
        if (filePath.toLowerCase().endsWith('.py')) {
          await ensurePythonReady(context.extensionUri);
        }

        const parser = createParser(source, filePath);
        if (!parser) {
          vscode.window.showErrorMessage(
            'Unsupported file type. Supported: .go, .java, .py, .ts, .php, .cs'
          );
          return;
        }

        const model = await parser.parse();
        if (!model || model.nodes.length === 0) {
          vscode.window.showWarningMessage(
            'No Temporal workflow detected. Make sure this file contains a workflow definition.'
          );
          return;
        }

        WorkflowDiagramPanel.createOrShow(model, context.extensionUri);
      }
    );
  });

  // Auto-refresh on save: update the diagram if the panel is open
  const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!WorkflowDiagramPanel.currentPanel) { return; }
    const filePath = doc.uri.fsPath;
    if (filePath.toLowerCase().endsWith('.py')) {
      await ensurePythonReady(context.extensionUri);
    }
    const parser = createParser(doc.getText(), filePath);
    if (!parser) { return; }
    const model = await parser.parse();
    if (model && model.nodes.length > 0) {
      WorkflowDiagramPanel.currentPanel.update(model);
    }
  });

  context.subscriptions.push(command, onSave);
}

export function deactivate(): void {}
