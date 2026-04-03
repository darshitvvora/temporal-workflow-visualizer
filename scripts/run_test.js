const fs = require('fs');
const path = require('path');

const parserFactory = require(path.resolve(__dirname, '../out/parsers/parserFactory'));
const diagramGen = require(path.resolve(__dirname, '../out/diagramGenerator'));

function safeRequire(name) {
  try {
    return require(name);
  } catch (e) {
    return null;
  }
}

const createParser = parserFactory.createParser || parserFactory.createParser;
const generateMermaid = diagramGen.generateMermaid || diagramGen.generateMermaid;

const samplePath = path.resolve(__dirname, '../test/sample_workflow.ts');
const source = fs.readFileSync(samplePath, 'utf8');

const parser = createParser(source, samplePath);
if (!parser) {
  console.error('No parser available for the sample file');
  process.exit(2);
}

const model = parser.parse();
console.log('=== MODEL ===');
console.log(JSON.stringify(model, null, 2));

const mermaid = generateMermaid(model);
console.log('\n=== MERMAID ===\n');
console.log(mermaid);
