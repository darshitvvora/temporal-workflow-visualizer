import * as vscode from 'vscode';
import { WorkflowModel } from './types';
import { generateMermaid, buildNodeMetadata, NodeMeta } from './diagramGenerator';

export class WorkflowDiagramPanel {
  public static currentPanel: WorkflowDiagramPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(model: WorkflowModel, _extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (WorkflowDiagramPanel.currentPanel) {
      WorkflowDiagramPanel.currentPanel._update(model);
      WorkflowDiagramPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'temporalWorkflowDiagram',
      `Workflow: ${model.name}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // No local resources needed — Mermaid loaded from CDN
      }
    );

    WorkflowDiagramPanel.currentPanel = new WorkflowDiagramPanel(panel, model);
  }

  private constructor(panel: vscode.WebviewPanel, model: WorkflowModel) {
    this._panel = panel;
    this._update(model);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message: { command: string; line: number; filePath: string }) => {
        if (message.command === 'navigateTo') {
          try {
            const uri = vscode.Uri.file(message.filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
            const position = new vscode.Position(message.line - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
              new vscode.Range(position, position),
              vscode.TextEditorRevealType.InCenter
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Could not navigate to line ${message.line}: ${err}`);
          }
        }
      },
      null,
      this._disposables
    );
  }

  public update(model: WorkflowModel): void {
    this._update(model);
    this._panel.title = `Workflow: ${model.name}`;
  }

  private _update(model: WorkflowModel): void {
    this._panel.title = `Workflow: ${model.name}`;
    const mermaidSyntax = generateMermaid(model);
    const nodeMeta = buildNodeMetadata(model);
    this._panel.webview.html = this._getHtml(mermaidSyntax, nodeMeta, model.filePath, model.name, model.language);
  }

  private _getHtml(
    mermaidSyntax: string,
    nodeMeta: Record<string, NodeMeta>,
    filePath: string,
    workflowName: string,
    language: string
  ): string {
    const nodeMetaJson = JSON.stringify(nodeMeta);
    const filePathJson = JSON.stringify(filePath);
    // Escape backticks in mermaid syntax for JS template literal
    const mermaidEscaped = mermaidSyntax.replace(/`/g, '\\`').replace(/\$/g, '\\$');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${workflowName} Workflow</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    #header {
      padding: 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      flex-shrink: 0;
    }

    #header h2 {
      font-size: 13px;
      font-weight: 600;
      flex: 1;
    }

    #lang-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    #hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    #diagram-container {
      flex: 1;
      overflow: auto;
      padding: 24px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }

    #diagram {
      max-width: 100%;
    }

    .mermaid {
      display: flex;
      justify-content: center;
    }

    /* Make Mermaid nodes look clickable */
    .mermaid .node rect,
    .mermaid .node circle,
    .mermaid .node ellipse,
    .mermaid .node polygon,
    .mermaid .node path {
      cursor: pointer;
      transition: filter 0.15s ease, opacity 0.15s ease;
    }
    .mermaid .node:hover rect,
    .mermaid .node:hover circle,
    .mermaid .node:hover ellipse,
    .mermaid .node:hover polygon {
      filter: brightness(1.2);
      opacity: 0.9;
    }

    /* Tooltip */
    #tooltip {
      position: fixed;
      padding: 10px 14px;
      background: var(--vscode-editorHoverWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 6px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      line-height: 1.5;
      white-space: pre;
      pointer-events: none;
      display: none;
      z-index: 9999;
      color: var(--vscode-editorHoverWidget-foreground, #d4d4d4);
      max-width: 360px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }

    #error-msg {
      color: var(--vscode-errorForeground);
      padding: 24px;
      text-align: center;
      display: none;
    }
  </style>
</head>
<body>
  <div id="header">
    <h2>⚡ ${workflowName}</h2>
    <span id="lang-badge">${language}</span>
    <span id="hint">Click a node to jump to source · Hover for options</span>
  </div>

  <div id="diagram-container">
    <div id="diagram">
      <pre class="mermaid" id="mermaid-pre"></pre>
    </div>
    <div id="error-msg"></div>
  </div>

  <div id="tooltip"></div>

  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

    const vscode = acquireVsCodeApi();
    const NODE_META = ${nodeMetaJson};
    const FILE_PATH = ${filePathJson};
    const tooltip = document.getElementById('tooltip');
    const mermaidPre = document.getElementById('mermaid-pre');
    const errorMsg = document.getElementById('error-msg');

    // Detect VS Code theme
    const isDark = document.body.classList.contains('vscode-dark') ||
                   document.body.classList.contains('vscode-high-contrast');

    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis',
      },
      securityLevel: 'loose', // required for click handlers
      fontFamily: getComputedStyle(document.body).fontFamily,
    });

    // Set diagram text and render
    const diagramText = \`${mermaidEscaped}\`;
    mermaidPre.textContent = diagramText;

    try {
      await mermaid.run({ nodes: [mermaidPre] });
    } catch (e) {
      errorMsg.style.display = 'block';
      errorMsg.textContent = 'Failed to render diagram: ' + e.message;
      console.error(e);
    }

    // ── Click-to-line navigation ────────────────────────────────────────────
    // Mermaid renders click directives as <a href="line:N"> anchors around nodes.
    // We intercept them before the browser can navigate.
    document.getElementById('diagram').addEventListener('click', (e) => {
      const anchor = e.target.closest('a');
      if (!anchor) { return; }
      const href = anchor.getAttribute('href') || '';
      const lineMatch = href.match(/^line:(\\d+)$/);
      if (lineMatch) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({
          command: 'navigateTo',
          line: parseInt(lineMatch[1], 10),
          filePath: FILE_PATH,
        });
      }
    });

    // ── Hover tooltips ────────────────────────────────────────────────────
    // Mermaid annotates each flowchart node with an id like "flowchart-nodeId-N"
    // We normalize that back to our NODE_META keys.
    function extractNodeId(el) {
      // Walk up to find a .node group with an id
      let cur = el;
      while (cur && cur !== document.body) {
        const id = cur.getAttribute('id') || '';
        // Mermaid ids: "flowchart-validate_41-12" → key is "validate_41"
        const m = id.match(/^flowchart-(.+?)-\\d+$/);
        if (m) { return m[1]; }
        // Also check data-id (some versions use this)
        const dataId = cur.getAttribute('data-id');
        if (dataId) { return dataId; }
        cur = cur.parentElement;
      }
      return null;
    }

    const diagramEl = document.getElementById('diagram');

    diagramEl.addEventListener('mouseover', (e) => {
      const nodeId = extractNodeId(e.target);
      if (!nodeId) { return; }
      const meta = NODE_META[nodeId];
      if (!meta) { return; }
      tooltip.textContent = meta.tooltip;
      tooltip.style.display = 'block';
      positionTooltip(e);
    });

    diagramEl.addEventListener('mousemove', (e) => {
      if (tooltip.style.display === 'block') {
        positionTooltip(e);
      }
    });

    diagramEl.addEventListener('mouseout', (e) => {
      const related = e.relatedTarget;
      if (related && (related.closest?.('[id^="flowchart-"]') || related.closest?.('.node'))) {
        return;
      }
      tooltip.style.display = 'none';
    });

    function positionTooltip(e) {
      const tw = tooltip.offsetWidth || 300;
      const th = tooltip.offsetHeight || 100;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = e.clientX + 16;
      let y = e.clientY + 16;
      if (x + tw > vw - 8) { x = e.clientX - tw - 8; }
      if (y + th > vh - 8) { y = e.clientY - th - 8; }
      tooltip.style.left = x + 'px';
      tooltip.style.top  = y + 'px';
    }
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    WorkflowDiagramPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }
}
