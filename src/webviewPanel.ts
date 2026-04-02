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
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Header ── */
    #header {
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 10px;
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

    /* Zoom buttons */
    .zoom-btn {
      width: 26px; height: 26px;
      border: 1px solid var(--vscode-button-border, #555);
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border-radius: 4px;
      cursor: pointer;
      font-size: 15px;
      display: flex; align-items: center; justify-content: center;
      user-select: none;
      flex-shrink: 0;
    }
    .zoom-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    #zoom-level {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 34px;
      text-align: center;
    }

    /* ── Main split layout ── */
    #main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* ── Diagram pane ── */
    #diagram-pane {
      flex: 1;
      overflow: auto;
      padding: 24px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }
    #diagram-wrap {
      display: inline-block;
      transform-origin: top center;
      transition: transform 0.15s ease;
    }
    .mermaid { display: block; }
    svg .node { cursor: pointer; }
    svg .node.node--selected rect,
    svg .node.node--selected circle,
    svg .node.node--selected ellipse,
    svg .node.node--selected polygon {
      filter: brightness(1.25) drop-shadow(0 0 5px rgba(99,179,237,0.7));
    }

    /* ── Details sidebar ── */
    #details-pane {
      width: 0;
      overflow: hidden;
      border-left: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, #252526);
      display: flex;
      flex-direction: column;
      transition: width 0.18s ease;
      flex-shrink: 0;
    }
    #details-pane.open { width: 280px; }

    #details-header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      flex-shrink: 0;
    }
    #details-title {
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #details-close {
      cursor: pointer;
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 16px;
      line-height: 1;
      padding: 0 2px;
      flex-shrink: 0;
    }
    #details-close:hover { color: var(--vscode-foreground, #ccc); }

    #details-body {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }

    /* Property sections */
    .prop-section {
      border-bottom: 1px solid var(--vscode-panel-border);
      overflow: hidden;
    }
    .prop-section-title {
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground, #888);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .prop-section-title:hover { color: var(--vscode-foreground, #ccc); }
    .prop-section-title .chevron { font-size: 9px; transition: transform 0.12s; }
    .prop-section.collapsed .chevron { transform: rotate(-90deg); }
    .prop-section-body {
      padding: 8px 12px;
    }
    .prop-section.collapsed .prop-section-body { display: none; }

    .prop-row {
      display: flex;
      gap: 8px;
      margin-bottom: 5px;
      font-size: 12px;
      line-height: 1.5;
    }
    .prop-key {
      color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe);
      font-weight: 600;
      flex-shrink: 0;
      min-width: 60px;
    }
    .prop-val {
      color: var(--vscode-editor-foreground, #d4d4d4);
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    #goto-btn {
      display: block;
      margin: 10px 12px 12px;
      padding: 5px 10px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
      text-align: center;
    }
    #goto-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

    #details-empty {
      padding: 24px 16px;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 12px;
      text-align: center;
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
    <span id="hint">Click any node to inspect it</span>
    <div style="display:flex;align-items:center;gap:4px;margin-left:auto">
      <button class="zoom-btn" id="btn-zoom-out" title="Zoom out">&#8722;</button>
      <span id="zoom-level">100%</span>
      <button class="zoom-btn" id="btn-zoom-in" title="Zoom in">&#43;</button>
      <button class="zoom-btn" id="btn-zoom-reset" title="Reset zoom" style="font-size:11px;width:auto;padding:0 6px">Reset</button>
    </div>
  </div>

  <div id="main">
    <div id="diagram-pane">
      <div id="diagram-wrap">
        <pre class="mermaid" id="twv-diagram"></pre>
        <div id="error-msg"></div>
      </div>
    </div>

    <!-- Persistent details sidebar -->
    <div id="details-pane">
      <div id="details-header">
        <span id="details-title">Node Details</span>
        <button id="details-close" title="Close">&times;</button>
      </div>
      <div id="details-body">
        <div id="details-empty">Select a node to view its properties</div>
      </div>
    </div>
  </div>

  <script>
    var NODE_META    = ${nodeMetaJson};
    var FILE_PATH    = ${filePathJson};
    var DIAGRAM_TEXT = ${mermaidJson};

    const vscode = acquireVsCodeApi();

    // Called by Mermaid click directive — opens sidebar AND navigates to source
    window.temporalNodeClick = function(nodeId) {
      const meta = NODE_META[nodeId];
      if (!meta) { return; }
      // Open the details sidebar (defined in the ES module below)
      if (window.selectNode) { window.selectNode(nodeId); }
      vscode.postMessage({ command: 'navigateTo', line: meta.line, filePath: FILE_PATH });
    };

    window.getNodeIdFromElement = function(el) {
      const prefix = 'twv-diagram-flowchart-';
      let cur = el;
      while (cur && cur !== document.body) {
        const rawId = cur.getAttribute('id') || '';
        if (rawId.startsWith(prefix)) {
          const inner  = rawId.slice(prefix.length);
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

    const diagramPre  = document.getElementById('twv-diagram');
    const diagramWrap = document.getElementById('diagram-wrap');
    const errorMsg    = document.getElementById('error-msg');
    const detailsPane  = document.getElementById('details-pane');
    const detailsTitle = document.getElementById('details-title');
    const detailsBody  = document.getElementById('details-body');
    const detailsClose = document.getElementById('details-close');

    const isDark = document.body.classList.contains('vscode-dark') ||
                   document.body.classList.contains('vscode-high-contrast');

    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      flowchart: { useMaxWidth: false, htmlLabels: false, curve: 'basis' },
      securityLevel: 'loose',
    });

    diagramPre.textContent = DIAGRAM_TEXT;

    try {
      await mermaid.run({ nodes: [diagramPre] });
    } catch (e) {
      errorMsg.style.display = 'block';
      errorMsg.textContent = 'Diagram render error: ' + (e.message || e);
      console.error('Mermaid error:', e);
      throw e;
    }

    // ── Zoom ─────────────────────────────────────────────────────────────────

    let zoom = 1.0;
    const ZOOM_STEP = 0.15, ZOOM_MIN = 0.3, ZOOM_MAX = 3.0;

    function applyZoom() {
      diagramWrap.style.transform = 'scale(' + zoom + ')';
      document.getElementById('zoom-level').textContent = Math.round(zoom * 100) + '%';
    }

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      zoom = Math.min(ZOOM_MAX, parseFloat((zoom + ZOOM_STEP).toFixed(2)));
      applyZoom();
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      zoom = Math.max(ZOOM_MIN, parseFloat((zoom - ZOOM_STEP).toFixed(2)));
      applyZoom();
    });
    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
      zoom = 1.0; applyZoom();
    });

    // ── Details sidebar ───────────────────────────────────────────────────────

    function escHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    let selectedNodeId = null;

    // Exposed on window so temporalNodeClick (classic script) can call it
    window.selectNode = function(nodeId) {
      const meta = NODE_META[nodeId];
      if (!meta) { return; }

      // Deselect previous highlight
      if (selectedNodeId) {
        const prev = diagramWrap.querySelector('[id^="twv-diagram-flowchart-' + selectedNodeId + '-"]');
        if (prev) { prev.classList.remove('node--selected'); }
      }
      selectedNodeId = nodeId;
      const cur = diagramWrap.querySelector('[id^="twv-diagram-flowchart-' + nodeId + '-"]');
      if (cur) { cur.classList.add('node--selected'); }

      // Build sidebar
      detailsBody.innerHTML = '';
      detailsTitle.textContent = meta.tooltip.split('\\n')[0] || nodeId;

      // Render all tooltip lines as plain rows
      const lines = meta.tooltip.split('\\n');
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) { return; }
        const row = document.createElement('div');
        row.className = 'prop-row';
        const colon = trimmed.indexOf(':');
        if (colon > 0 && colon < 32) {
          row.innerHTML =
            '<span class="prop-key">' + escHtml(trimmed.slice(0, colon).trim()) + '</span>' +
            '<span class="prop-val">'  + escHtml(trimmed.slice(colon + 1).trim()) + '</span>';
        } else {
          row.innerHTML = '<span class="prop-val">' + escHtml(trimmed) + '</span>';
        }
        detailsBody.appendChild(row);
      });

      detailsPane.classList.add('open');
    };

    detailsClose.addEventListener('click', () => {
      detailsPane.classList.remove('open');
      if (selectedNodeId) {
        const el = diagramWrap.querySelector('[id^="twv-diagram-flowchart-' + selectedNodeId + '-"]');
        if (el) { el.classList.remove('node--selected'); }
        selectedNodeId = null;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { detailsClose.click(); }
    });
  </script>
</body>
</html>\`;
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
