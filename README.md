# Temporal Workflow Visualizer

A VS Code extension that visualizes [Temporal.io](https://temporal.io) workflows as interactive Mermaid flowcharts — directly inside your editor.

## Demo

<video src="demo_video/demo_video.mp4" controls width="100%"></video>

---

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

### Parser Architecture

Two parser strategies live side by side:

| Language | Strategy | Backed by |
|---|---|---|
| **Python** | AST-based | [tree-sitter](https://tree-sitter.github.io/) + a Temporal-aware primitive recognizer + structured CFG builder |
| Go, TypeScript, Java, PHP, C# (.NET) | Regex / line scanning | Hand-written patterns in each parser file |

The Python parser walks a real syntax tree, so it sees actual control flow: `if/elif/else` becomes branched decisions, `try/except` produces typed error edges, `for`/`while` loops emit back-edges around their real bodies, and `asyncio.gather` fans out into parallel arms. Import aliases (`from temporalio import workflow as wf`, `from temporalio.workflow import sleep`) are resolved through an import-context layer, so the same `wf.execute_activity(…)` is recognized regardless of how it was imported.

The other languages still use the original regex approach. They work for common patterns but approximate control flow by line-sorting recognized calls. Porting them to tree-sitter is on the roadmap — see [Contributing](#contributing).

### Recognized Primitives

| Type | Description |
|---|---|
| Activities | Regular and local activity calls |
| Signals | Signal channel handlers |
| Queries | Query handler definitions |
| Updates | `@workflow.update` handlers and `@<update>.validator` validators (Python AST parser) |
| Timers | Sleep and timer calls |
| Side Effects | Non-deterministic side effect wrappers, `continue_as_new`, versioning patches |
| Child Workflows | Nested workflow executions + external workflow handles |
| Nexus | `workflow.create_nexus_client` calls |
| Parallel Waits | `asyncio.gather` / `workflow.wait` rendered as fan-out → fan-in (Python AST parser) |
| Error Branches | try/catch and saga compensation flows |
| Loops | `for` / `while` constructs with their bodies rendered inside the loop (Python AST parser) |

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
├── extension.ts              # Extension entry point + lazy tree-sitter init
├── types.ts                  # Shared type definitions (WorkflowModel, WorkflowNode, etc.)
├── diagramGenerator.ts       # Converts WorkflowModel → Mermaid diagram syntax
├── webviewPanel.ts           # VS Code webview panel with Mermaid rendering + click-to-navigate
└── parsers/
    ├── baseParser.ts         # Abstract base parser with shared utilities
    ├── parserFactory.ts      # Selects correct parser by file extension
    │
    ├── pythonParser.ts       # Python SDK parser  ── AST-based (tree-sitter)
    ├── python/
    │   ├── temporalSdk.ts       # Catalog of every Temporal Python SDK primitive
    │   ├── astHelpers.ts        # tree-sitter wrapper + Python-specific AST queries
    │   ├── importContext.ts     # Resolves `wf.X`, `from temporalio.workflow import sleep`, etc.
    │   ├── primitiveRecognizer.ts  # AST node → catalog primitive
    │   ├── cfgTypes.ts          # FlowSequence / FlowIf / FlowTry / FlowFor / …
    │   ├── cfgBuilder.ts        # Walks AST into a structured CFG
    │   └── cfgToModel.ts        # Translates CFG → existing WorkflowModel shape
    │
    ├── goParser.ts           # Go SDK parser           ── regex-based
    ├── typescriptParser.ts   # TypeScript SDK parser   ── regex-based
    ├── javaParser.ts         # Java SDK parser         ── regex-based
    ├── phpParser.ts          # PHP SDK parser          ── regex-based
    └── dotnetParser.ts       # C# .NET SDK parser      ── regex-based

test/python/
├── fixtures/                 # Python workflow fixtures covering common patterns
└── *.smoke.ts                # Recognizer / CFG / parser / mermaid-pipeline checks
```

### Running the Python parser tests

```bash
npm run test:python
```

This runs four pass-through checks against the fixtures: primitive recognition, CFG structure, end-to-end `WorkflowModel`, and Mermaid generation.

---

## Status

> **This project is under active development.**
>
> - Python parser has fixture-based tests (`npm run test:python`); other languages have none yet
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

Each language parser lives in [src/parsers/](src/parsers/) and extends `BaseParser`. There are **two** parser strategies in this repo, and the steps to extend each one differ.

#### Python (AST-based)

The Python parser is structured as: catalog → recognizer → CFG → model translator.

1. **Add a new SDK primitive** — edit [src/parsers/python/temporalSdk.ts](src/parsers/python/temporalSdk.ts). Add an entry with the canonical `qualifiedName` (e.g. `workflow.new_primitive`), a `kind`, the `awaitable` flag, and a one-line description. The recognizer picks it up automatically.
2. **Surface it in the diagram** — if the new primitive should produce a node, ensure `nodeKindForPrimitive` in [src/parsers/python/cfgToModel.ts](src/parsers/python/cfgToModel.ts) maps its `PrimitiveKind` to an existing `NodeKind`. Add a label/ID case to `idAndLabelFor` if it needs custom formatting.
3. **Add a fixture** — drop a Python file under [test/python/fixtures/](test/python/fixtures/) that exercises the new pattern, then add an assertion in the relevant `*.smoke.ts` test.
4. **Run** `npm run test:python` to verify.

#### Regex-based parsers (Go, TS, Java, PHP, C#)

1. Find the relevant parser file (e.g. [src/parsers/goParser.ts](src/parsers/goParser.ts))
2. Add a regex pattern to detect the new call site
3. Map it to the appropriate `WorkflowNode` type defined in [src/types.ts](src/types.ts)
4. Test it by opening a file with that pattern and running the visualizer

#### Adding a new language

- **AST path (recommended)**: model it after `src/parsers/python/`. The Python module structure (catalog + alias-aware import context + recognizer + CFG builder + model translator) is intentionally language-agnostic in shape; only the SDK catalog and grammar are language-specific. The [`@vscode/tree-sitter-wasm`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm) package already bundles grammars for Go, TypeScript, Java, PHP, and C#.
- **Regex path**: create a new file in `src/parsers/`, extend `BaseParser`, and register it in [src/parsers/parserFactory.ts](src/parsers/parserFactory.ts). Reuse helpers like `findAllLines`, `findTryCatchBlocks`, and `findBraceFunctionBounds` from `BaseParser` where you can.

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
