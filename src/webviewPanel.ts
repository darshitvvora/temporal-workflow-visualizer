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
    // Escape for safe embedding in a <script> JSON assignment
    const mermaidJson = JSON.stringify(mermaidSyntax);

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
    #header h2 { font-size: 13px; font-weight: 600; flex: 1; }
    #lang-badge {
      font-size: 11px; padding: 2px 8px; border-radius: 10px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    #hint { font-size: 11px; color: var(--vscode-descriptionForeground); }

    #diagram-container {
      flex: 1; overflow: auto; padding: 24px;
      display: flex; align-items: flex-start; justify-content: center;
    }
    #diagram { max-width: 100%; }
    .mermaid { display: flex; justify-content: center; }

    /* Clickable cursor on all flowchart nodes */
    svg .node { cursor: pointer; }
    svg .node rect, svg .node circle, svg .node ellipse,
    svg .node polygon, svg .node path {
      transition: filter 0.15s ease;
    }
    svg .node:hover rect, svg .node:hover circle,
    svg .node:hover ellipse, svg .node:hover polygon {
      filter: brightness(1.25) drop-shadow(0 0 4px rgba(0,0,0,0.4));
    }

    #tooltip {
      position: fixed;
      padding: 10px 14px;
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 6px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      line-height: 1.6;
      white-space: pre;
      pointer-events: none;
      display: none;
      z-index: 9999;
      color: var(--vscode-editorHoverWidget-foreground, #d4d4d4);
      max-width: 380px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }

    #error-msg {
      color: var(--vscode-errorForeground);
      padding: 24px; text-align: center; display: none;
    }
  </style>
</head>
<body>
  <div id="header">
    <h2>${workflowName}</h2>
    <span id="lang-badge">${language}</span>
    <span id="hint">Click node to jump to source &middot; Hover for options</span>
  </div>
  <div id="diagram-container">
    <div id="diagram">
      <pre class="mermaid" id="twv-diagram"></pre>
    </div>
    <div id="error-msg"></div>
  </div>
  <div id="tooltip"></div>

  <script>
    // Use var (not const) so these are global and visible inside ES module scripts
    var NODE_META = ${nodeMetaJson};
    var FILE_PATH = ${filePathJson};
    var DIAGRAM_TEXT = ${mermaidJson};

    const vscode = acquireVsCodeApi();

    // ── Click handler ───────────────────────────────────────────────────────
    // Mermaid calls window.temporalNodeClick(nodeId) when securityLevel='loose'
    // and the directive is:  click <nodeId> call temporalNodeClick
    // (NO parentheses — with "()" Mermaid passes "" instead of nodeId)
    window.temporalNodeClick = function(nodeId) {
      const meta = NODE_META[nodeId];
      if (!meta) {
        console.warn('temporalNodeClick: no meta for', nodeId, Object.keys(NODE_META));
        return;
      }
      vscode.postMessage({ command: 'navigateTo', line: meta.line, filePath: FILE_PATH });
    };

    // ── Hover: extract node ID from any SVG child element ──────────────────
    // Mermaid v11 sets element id = "{diagramId}-flowchart-{nodeId}-{counter}"
    // where diagramId = the id of the <pre> element = DIAGRAM_EL_ID.
    // So we strip the known prefix and suffix to recover our nodeId.
    window.getNodeIdFromElement = function(el) {
      const prefix = 'twv-diagram-flowchart-';
      let cur = el;
      while (cur && cur !== document.body) {
        const rawId = cur.getAttribute('id') || '';
        if (rawId.startsWith(prefix)) {
          // rawId = "twv-diagram-flowchart-validate_41-0"
          // strip prefix → "validate_41-0"
          // strip last -digits → "validate_41"
          const inner = rawId.slice(prefix.length);
          const nodeId = inner.replace(/-\\d+$/, '');
          if (NODE_META[nodeId]) { return nodeId; }
        }
        cur = cur.parentElement;
      }
      return null;
    };
  </script>

  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

    // Use the literal id — 'const' in a classic script is not visible inside ES modules
    const diagramPre = document.getElementById('twv-diagram');
    const errorMsg   = document.getElementById('error-msg');
    const tooltip    = document.getElementById('tooltip');

    const isDark = document.body.classList.contains('vscode-dark') ||
                   document.body.classList.contains('vscode-high-contrast');

    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' },
      securityLevel: 'loose',   // required for click callbacks to fire
    });

    diagramPre.textContent = DIAGRAM_TEXT;

    try {
      await mermaid.run({ nodes: [diagramPre] });
    } catch (e) {
      errorMsg.style.display = 'block';
      errorMsg.textContent = 'Diagram render error: ' + (e.message || e);
      console.error('Mermaid error:', e);
    }

    // ── Hover tooltips ──────────────────────────────────────────────────────
    const diagramEl = document.getElementById('diagram');

    diagramEl.addEventListener('mouseover', (e) => {
      const nodeId = window.getNodeIdFromElement(e.target);
      if (!nodeId) { tooltip.style.display = 'none'; return; }
      const meta = NODE_META[nodeId];
      if (!meta) { tooltip.style.display = 'none'; return; }
      tooltip.textContent = meta.tooltip;
      tooltip.style.display = 'block';
      moveTooltip(e);
    });

    diagramEl.addEventListener('mousemove', (e) => {
      if (tooltip.style.display === 'block') { moveTooltip(e); }
    });

    diagramEl.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    diagramEl.addEventListener('mouseout', (e) => {
      if (!window.getNodeIdFromElement(e.relatedTarget)) {
        tooltip.style.display = 'none';
      }
    });

    function moveTooltip(e) {
      const tw = tooltip.offsetWidth  || 300;
      const th = tooltip.offsetHeight || 80;
      let x = e.clientX + 16;
      let y = e.clientY + 16;
      if (x + tw > window.innerWidth  - 8) { x = e.clientX - tw - 8; }
      if (y + th > window.innerHeight - 8) { y = e.clientY - th - 8; }
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
