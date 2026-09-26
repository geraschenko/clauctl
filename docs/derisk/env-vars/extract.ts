import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface SourceChunk {
  text: string;
  byteOffset: number;
}

interface Reference {
  name: string;
  byteOffset: number;
}

interface Registration extends Reference {
  parser: string;
}

export interface Inventory {
  names: string[];
  references: Reference[];
  registrations: Registration[];
  uppercaseCandidates: string[];
}

/** Extract embedded source without loading or executing the executable. */
export function extractChunks(binary: Buffer): SourceChunk[] {
  const marker = Buffer.from("// @bun @bytecode\n// Claude Code");
  const chunks: SourceChunk[] = [];
  let cursor = 0;
  for (;;) {
    const start = binary.indexOf(marker, cursor);
    if (start === -1) break;
    const end = binary.indexOf(0, start);
    if (end === -1) throw new Error(`Unterminated source chunk at ${start}`);
    chunks.push({
      text: binary.toString("utf8", start, end),
      byteOffset: start,
    });
    cursor = end + 1;
  }
  if (chunks.length === 0)
    throw new Error("No embedded Claude JavaScript found");
  return chunks;
}

function literalName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function member(
  node: ts.Node,
): { object: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return { object: node.expression, name: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { object: node.expression, name: node.argumentExpression.text };
  }
  return undefined;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

/** Local binding analysis only; this does not resolve imports or arbitrary value flow. */
export function inspectChunk(chunk: SourceChunk): Omit<Inventory, "names"> {
  const filename = "/env-inventory-input.js";
  const source = ts.createSourceFile(
    filename,
    chunk.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === filename ? source : undefined);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = program.getSyntacticDiagnostics(source);
  if (diagnostics.length) {
    throw new Error(
      `Parse error in chunk at ${chunk.byteOffset}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`,
    );
  }
  const checker = program.getTypeChecker();
  const references: Reference[] = [];
  const registrations: Registration[] = [];
  const uppercaseCandidates = new Set<string>();
  const calls: ts.CallExpression[] = [];
  const factories = new Set<ts.Symbol>();
  const getterMaps = new Map<ts.Symbol, ts.ObjectLiteralExpression[]>();

  function symbol(node: ts.Node): ts.Symbol | undefined {
    return checker.getSymbolAtLocation(node);
  }

  function globalName(node: ts.Node, name: string): boolean {
    if (!ts.isIdentifier(node) || node.text !== name) return false;
    // JS property writes can give an otherwise undeclared global an expando symbol.
    return (symbol(node)?.declarations ?? []).every(ts.isIdentifier);
  }

  function initializer(
    node: ts.Node,
    constantsOnly: boolean,
  ): ts.Expression | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const declaration = symbol(node)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration))
      return undefined;
    if (constantsOnly && !(declaration.parent.flags & ts.NodeFlags.Const))
      return undefined;
    return declaration.initializer;
  }

  function environment(node: ts.Node, seen = new Set<ts.Symbol>()): boolean {
    if (ts.isParenthesizedExpression(node))
      return environment(node.expression, seen);
    const access = member(node);
    if (access?.name === "env" && globalName(access.object, "process"))
      return true;
    if (!ts.isIdentifier(node)) return false;
    const binding = symbol(node);
    if (!binding || seen.has(binding)) return false;
    seen.add(binding);
    const value = initializer(node, true);
    return value !== undefined && environment(value, seen);
  }

  function offset(node: ts.Node): number {
    return (
      chunk.byteOffset +
      Buffer.byteLength(chunk.text.slice(0, node.getStart(source)))
    );
  }

  // The compiled schema factory enumerates its parameter and reads process.env[key].
  // This structural match avoids depending on its minified name.
  function schemaFactory(node: ts.FunctionDeclaration): boolean {
    if (!node.body || !node.parameters[0]) return false;
    const parameter = symbol(node.parameters[0].name);
    let enumeratesParameter = false;
    let readsEnvironment = false;
    visit(node.body, (child) => {
      if (ts.isElementAccessExpression(child) && environment(child.expression))
        readsEnvironment = true;
      if (!ts.isCallExpression(child) || !child.arguments[0]) return;
      const access = member(child.expression);
      if (
        access?.name === "entries" &&
        globalName(access.object, "Object") &&
        symbol(child.arguments[0]) === parameter
      )
        enumeratesParameter = true;
    });
    return enumeratesParameter && readsEnvironment;
  }

  visit(source, (node) => {
    const name = literalName(node);
    if (name && name.length >= 12 && /^[A-Z][A-Z0-9_]*$/.test(name))
      uppercaseCandidates.add(name);
    const access = member(node);
    if (access && environment(access.object))
      references.push({ name: access.name, byteOffset: offset(node) });
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      environment(node.initializer)
    ) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) continue;
        const key = element.propertyName ?? element.name;
        const name = ts.isComputedPropertyName(key)
          ? ts.isStringLiteralLike(key.expression)
            ? key.expression.text
            : undefined
          : literalName(key);
        if (name) references.push({ name, byteOffset: offset(element) });
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && schemaFactory(node)) {
      const binding = symbol(node.name);
      if (binding) factories.add(binding);
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      const [target, getters] = node.arguments;
      const binding =
        target && ts.isIdentifier(target) ? symbol(target) : undefined;
      if (
        binding &&
        getters &&
        ts.isObjectLiteralExpression(getters) &&
        getters.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isArrowFunction(property.initializer) &&
            property.initializer.parameters.length === 0,
        )
      ) {
        const maps = getterMaps.get(binding) ?? [];
        maps.push(getters);
        getterMaps.set(binding, maps);
      }
    }
  });

  function parserExpression(
    node: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): ts.Expression {
    const binding = ts.isIdentifier(node) ? symbol(node) : undefined;
    if (!binding || seen.has(binding)) return node;
    seen.add(binding);
    const value = initializer(node, false);
    return value ? parserExpression(value, seen) : node;
  }

  function schema(node: ts.Expression, seen: Set<ts.Symbol>): void {
    if (ts.isIdentifier(node)) {
      const binding = symbol(node);
      if (!binding || seen.has(binding)) return;
      seen.add(binding);
      const value = initializer(node, false);
      if (value) schema(value, seen);
      for (const getters of getterMaps.get(binding) ?? [])
        schema(getters, seen);
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        schema(property.expression, seen);
      } else if (ts.isPropertyAssignment(property)) {
        const name = literalName(property.name);
        if (!name) continue;
        const value = property.initializer;
        const parser =
          ts.isArrowFunction(value) && !ts.isBlock(value.body)
            ? value.body
            : value;
        registrations.push({
          name,
          byteOffset: offset(property),
          parser: parserExpression(parser).getText(source),
        });
      }
    }
  }

  for (const call of calls) {
    const binding = ts.isIdentifier(call.expression)
      ? symbol(call.expression)
      : undefined;
    if (binding && factories.has(binding) && call.arguments[0])
      schema(call.arguments[0], new Set());
  }
  return {
    references,
    registrations,
    uppercaseCandidates: [...uppercaseCandidates].sort(),
  };
}

export function inventory(chunks: Iterable<SourceChunk>): Inventory {
  const references: Reference[] = [];
  const registrations: Registration[] = [];
  const candidates = new Set<string>();
  for (const chunk of chunks) {
    const result = inspectChunk(chunk);
    references.push(...result.references);
    registrations.push(...result.registrations);
    for (const name of result.uppercaseCandidates) candidates.add(name);
  }
  const names = new Set(
    [...references, ...registrations].map((entry) => entry.name),
  );
  return {
    names: [...names].sort(),
    references,
    registrations,
    uppercaseCandidates: [...candidates]
      .filter((name) => !names.has(name))
      .sort(),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    console.error(
      "Usage: node docs/derisk/env-vars/extract.ts <claude-binary-or-file.js>\nWrites JSON to stdout; never executes the input.",
    );
    process.exitCode = args[0] === "--help" ? 0 : 1;
  } else {
    const input = readFileSync(args[0]);
    const chunks = /\.[cm]?js$/.test(args[0])
      ? [{ text: input.toString("utf8"), byteOffset: 0 }]
      : extractChunks(input);
    console.log(JSON.stringify(inventory(chunks), null, 2));
  }
}
