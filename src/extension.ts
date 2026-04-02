import * as vscode from 'vscode';
import { createParser } from './parsers/parserFactory';
import { WorkflowDiagramPanel } from './webviewPanel';

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
        const parser = createParser(source, filePath);
        if (!parser) {
          vscode.window.showErrorMessage(
            'Unsupported file type. Supported: .go, .java, .py, .ts, .php, .cs'
          );
          return;
        }

        const model = parser.parse();
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
  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!WorkflowDiagramPanel.currentPanel) { return; }
    const filePath = doc.uri.fsPath;
    const parser = createParser(doc.getText(), filePath);
    if (!parser) { return; }
    const model = parser.parse();
    if (model && model.nodes.length > 0) {
      WorkflowDiagramPanel.currentPanel.update(model);
    }
  });

  context.subscriptions.push(command, onSave);
}

export function deactivate(): void {}
