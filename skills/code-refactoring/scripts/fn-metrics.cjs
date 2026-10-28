// Usage (from the repo root): node skills/code-refactoring/scripts/fn-metrics.cjs <file.ts|tsx...>
// Lists functions longer than 60 lines or with control-flow nesting depth >= 5, longest first.
// `else if` chains count as one level; nested functions are measured on their own.
const fs = require("fs");
const path = require("path");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../../../backend")] }));

const NESTING = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ConditionalExpression,
]);

function nestingDepth(fn) {
  let max = 0;
  const walk = (node, depth) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    const isElseIf = ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
    const next = NESTING.has(node.kind) && !isElseIf ? depth + 1 : depth;
    max = Math.max(max, next);
    ts.forEachChild(node, (child) => walk(child, next));
  };
  walk(fn, 0);
  return max;
}

function functionName(node) {
  if (node.name) return node.name.getText();
  return ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : "<anonymous>";
}

const rows = [];
for (const file of process.argv.slice(2)) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const isFunction =
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
    if (isFunction && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const lines = source.getLineAndCharacterOfPosition(node.getEnd()).line + 2 - start;
      const depth = nestingDepth(node);
      if (lines > 60 || depth >= 5) rows.push({ lines, depth, where: `${file}:${start}`, name: functionName(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

console.log("lines\tdepth\tlocation\tname");
for (const row of rows.sort((a, b) => b.lines - a.lines)) {
  console.log(`${row.lines}\t${row.depth}\t${row.where}\t${row.name}`);
}
