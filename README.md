# Temporal Workflow Visualizer

A VS Code extension that visualizes [Temporal.io](https://temporal.io) workflows as interactive Mermaid flowcharts — directly inside your editor.

## Why This Exists

Temporal is code-first. That's a strength — it scales, it's testable, it's version-controlled. But as workflows grow in complexity, understanding the flow becomes harder. Unlike canvas-based DSL or YAML orchestration tools where the diagram _is_ the definition, in Temporal the diagram lives only in your head.

This creates real friction:

- **New developers** joining a project have to mentally trace async activity chains, signal handlers, error branches, and child workflows across files before they can contribute confidently.
- **Developers iterating** on a workflow have to context-switch between code and a whiteboard to reason about what they're building.

Visualization consistently improves productivity — and the best place to visualize is where you already work: your editor.

This extension solves that. Open any Temporal workflow file, click the icon in the editor title bar, and a side pane renders a live Mermaid diagram of your workflow. It updates on save, lets you click nodes to jump to the source line, and shows activity options and error paths inline.

---

## Features

- **Multi-language support** — Go, Python, TypeScript, Java, PHP, C# (.NET)
- **Auto-detection** — activates automatically when you open a supported file
- **Live updates** — diagram refreshes every time you save
- **Click-to-navigate** — click any node in the diagram to jump to that line in source
- **Hover tooltips** — shows activity options (timeouts, retry policies) on hover
- **Error branch visualization** — renders try/catch and saga compensation paths
- **Side panel** — displays workflow configuration details alongside the diagram

### Recognized Primitives

| Type | Description |
|---|---|
| Activities | Regular and local activity calls |
| Signals | Signal channel handlers |
| Queries | Query handler definitions |
| Timers | Sleep and timer calls |
| Side Effects | Non-deterministic side effect wrappers |
| Child Workflows | Nested workflow executions |
| Error Branches | try/catch and saga compensation flows |

---

## Getting Started

### Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.85.0 or later
- [Node.js](https://nodejs.org/) 18+

### Install from Source

```bash
git clone https://github.com/darshitvvora/temporal-workflow-visualizer
cd temporal-workflow-visualizer
npm install
```

### Run in Development

1. Open the project in VS Code
2. Run `npm run watch` in the terminal to start the TypeScript compiler in watch mode
3. Press **F5** to launch the Extension Development Host (a new VS Code window)
4. Open any `.go`, `.py`, `.ts`, `.java`, `.php`, or `.cs` file that contains Temporal workflow code
5. Click the **$(type-hierarchy)** icon in the editor title bar, or open the Command Palette (`Cmd+Shift+P`) and run **Temporal: Visualize Workflow**

### Build for Distribution

```bash
npm run compile     # compile TypeScript to ./out
npm run package     # package as a .vsix file
```

Install the `.vsix` locally via **Extensions: Install from VSIX...** in the Command Palette.

---

## Usage

Once the extension is active, any time you're editing a Temporal workflow file:

1. **Title bar icon** — click the hierarchy icon (`⊤`) in the top-right of the editor
2. **Right-click** — select **Temporal: Visualize Workflow** from the context menu
3. **Command Palette** — `Cmd+Shift+P` → **Temporal: Visualize Workflow**

A panel opens beside your editor with the rendered flowchart. Nodes are color-coded by type. Click any node to navigate to that line of code.

---

## Project Structure

```
src/
├── extension.ts          # Extension entry point, command registration
├── types.ts              # Shared type definitions (WorkflowModel, WorkflowNode, etc.)
├── diagramGenerator.ts   # Converts WorkflowModel → Mermaid diagram syntax
├── webviewPanel.ts       # VS Code webview panel with Mermaid rendering and click-to-navigate
└── parsers/
    ├── baseParser.ts         # Abstract base parser with shared utilities
    ├── parserFactory.ts      # Selects correct parser by file extension
    ├── goParser.ts           # Go SDK parser
    ├── pythonParser.ts       # Python SDK parser
    ├── typescriptParser.ts   # TypeScript/Node.js SDK parser
    ├── javaParser.ts         # Java SDK parser
    ├── phpParser.ts          # PHP SDK parser
    └── dotnetParser.ts       # C# .NET SDK parser
```

---

## Status

> **This project is under active development.**
>
> - Testing is pending
> - Not yet published on the [VS Code Extension Marketplace](https://marketplace.visualstudio.com/vscode)
> - Publishing to the marketplace is on the roadmap

Expect rough edges. Contributions and bug reports are welcome while the project matures.

---

## Contributing

Contributions are welcome! The project is in early development, so there's plenty of room to help.

### Ways to Contribute

- **Bug reports** — open an issue describing the workflow pattern that wasn't parsed correctly, ideally with a minimal code snippet
- **New language patterns** — if a Temporal SDK call isn't being detected, add or improve the regex patterns in the relevant parser
- **New language support** — add a parser for an unsupported language by extending `BaseParser`
- **UI improvements** — enhancements to the webview panel, diagram layout, or side panel
- **Tests** — test coverage is currently pending; adding unit tests for parsers is a great first contribution

### Development Workflow

1. Fork the repository and clone your fork
2. Install dependencies: `npm install`
3. Start the compiler in watch mode: `npm run watch`
4. Press **F5** in VS Code to open the Extension Development Host
5. Make your changes — the extension reloads automatically on save
6. Open a PR with a clear description of what you changed and why

### Adding or Improving a Parser

Each language parser lives in [src/parsers/](src/parsers/) and extends `BaseParser`. To add support for a new pattern:

1. Find the relevant parser file (e.g. [src/parsers/pythonParser.ts](src/parsers/pythonParser.ts))
2. Add a regex pattern to detect the new call site
3. Map it to the appropriate `WorkflowNode` type defined in [src/types.ts](src/types.ts)
4. Test it by opening a file with that pattern and running the visualizer

To add a new language, create a new file in `src/parsers/`, extend `BaseParser`, and register it in [src/parsers/parserFactory.ts](src/parsers/parserFactory.ts).

---

## Author & Attribution

**Author:** [Darshit Vora](https://github.com/darshitvvora)

Built with:
- [Temporal.io](https://temporal.io) — the durable execution platform this extension is built for
- [Mermaid](https://mermaid.js.org) — diagram rendering
- [VS Code Extension API](https://code.visualstudio.com/api) — editor integration

---

## License

MIT
