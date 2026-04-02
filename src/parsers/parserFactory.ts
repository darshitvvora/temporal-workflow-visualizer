import * as path from 'path';
import { BaseParser } from './baseParser';
import { GoParser } from './goParser';
import { JavaParser } from './javaParser';
import { PythonParser } from './pythonParser';
import { TypeScriptParser } from './typescriptParser';
import { PhpParser } from './phpParser';
import { DotNetParser } from './dotnetParser';

export function createParser(source: string, filePath: string): BaseParser | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.go':   return new GoParser(source, filePath);
    case '.java': return new JavaParser(source, filePath);
    case '.py':   return new PythonParser(source, filePath);
    case '.ts':   return new TypeScriptParser(source, filePath);
    case '.php':  return new PhpParser(source, filePath);
    case '.cs':   return new DotNetParser(source, filePath);
    default:      return null;
  }
}
