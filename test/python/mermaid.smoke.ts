/**
 * End-to-end pipeline smoke: source.py → PythonParser → generateMermaid → string.
 *
 * We don't assert on the exact Mermaid text (too fragile), only that:
 *  - parse + generate complete without throwing
 *  - the output contains a `flowchart TD` header
 *  - every recognized primitive's label appears at least once in the output
 *
 * Run via `node out/test/python/mermaid.smoke.js` after compile.
 */

import * as fs from 'fs';
import * as path from 'path';

import { initPythonParser } from '../../src/parsers/python/astHelpers';
import { PythonParser } from '../../src/parsers/pythonParser';
import { generateMermaid } from '../../src/diagramGenerator';

async function main(): Promise<void> {
  const fixturesDir = path.resolve(__dirname, '..', '..', '..', 'test', 'python', 'fixtures');
  await initPythonParser();

  const files = ['basic_workflow.py', 'aliased_imports.py', 'signals_queries_updates.py', 'child_and_external.py', 'saga_workflow.py'];

  let failures = 0;
  for (const file of files) {
    try {
      const src = fs.readFileSync(path.join(fixturesDir, file), 'utf-8');
      const parser = new PythonParser(src, path.join(fixturesDir, file));
      const model = await parser.parse();
      if (!model) { throw new Error('parser returned null'); }
      const mermaid = generateMermaid(model);
      if (!mermaid.startsWith('flowchart TD')) {
        throw new Error('mermaid output does not start with `flowchart TD`');
      }
      // Spot-check: every flow-node label appears in the output.
      for (const node of model.nodes) {
        if (!mermaid.includes(node.id)) {
          throw new Error(`node id "${node.id}" not present in mermaid output`);
        }
      }
      process.stdout.write(`✓ ${file}  (${model.nodes.length} nodes, ${mermaid.split('\n').length} mermaid lines)\n`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`✗ ${file}\n  ${msg.split('\n').join('\n  ')}\n`);
    }
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} mermaid pipeline check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${files.length} mermaid pipeline checks passed.\n`);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
