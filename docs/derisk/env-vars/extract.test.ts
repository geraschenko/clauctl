import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChunks, inventory } from "./extract.ts";

test("literal environment names, const aliases, destructuring, and lexical shadowing", () => {
  const result = inventory([
    {
      byteOffset: 0,
      text: `
    const environment = process.env;
    const alias = environment;
    alias.ANTHROPIC_BASE_URL;
    alias["OTHER_NAME"];
    const { HOME: home, ["PATH"]: path, ...rest } = environment;
    const { NESTED_NAME: { child } } = environment;
    process.env.WRITTEN_NAME = "value";
    delete process.env.DELETED_NAME;
    function shadow(environment, process) {
      environment.NOT_AN_ENV_VAR;
      process.env.NOT_AN_ENV_EITHER;
    }
    function shadowAlias() {
      const alias = {};
      alias.ALSO_NOT_AN_ENV;
    }
    const dynamicKey = "DYNAMIC_KEY";
    environment[dynamicKey];
    let mutable = environment;
    mutable.UNSUPPORTED_ALIAS;
  `,
    },
  ]);
  assert.deepEqual(result.names, [
    "ANTHROPIC_BASE_URL",
    "DELETED_NAME",
    "HOME",
    "NESTED_NAME",
    "OTHER_NAME",
    "PATH",
    "WRITTEN_NAME",
  ]);
  assert.deepEqual(result.registrations, []);
  assert.ok(result.uppercaseCandidates.includes("NOT_AN_ENV_VAR"));
  assert.ok(!result.uppercaseCandidates.includes("ANTHROPIC_BASE_URL"));
});

test("cyclic aliases terminate without inventing names", () => {
  const result = inventory([
    {
      byteOffset: 0,
      text: "const first = second; const second = first; first.NOT_ENV;",
    },
  ]);
  assert.deepEqual(result.names, []);
});

test("schema roots, getter maps, parser bindings, spreads, and empty accessors", () => {
  const result = inventory([
    {
      byteOffset: 0,
      text: `
    var boolParser = parsers.bool(), enumParser = parsers.enum(["strict", "relaxed"]);
    var group = {};
    exportGetters(group, { REGISTERED_BOOL: () => boolParser, MixedCase: () => enumParser });
    var unrelated = {};
    exportGetters(unrelated, { UNRELATED_GETTER: () => boolParser });
    var schema = { ...group, DIRECT_SCHEMA: parsers.int({ min: 1 }) };
    function makeAccessor(entries, prototype) {
      const accessor = Object.create(prototype);
      for (const [name, parser] of Object.entries(entries)) {
        Object.defineProperty(accessor, name, { get: () => parser.parse(process.env[name]) });
      }
      return accessor;
    }
    var accessor = makeAccessor(schema, null);
    var empty = makeAccessor({}, null);
    empty.INERT_ENV_REFERENCE;
    function otherScope() {
      const boolParser = somethingElse();
      return boolParser;
    }
  `,
    },
  ]);
  assert.deepEqual(result.names, [
    "DIRECT_SCHEMA",
    "MixedCase",
    "REGISTERED_BOOL",
  ]);
  assert.deepEqual(
    result.registrations.map(({ name, parser }) => ({ name, parser })),
    [
      { name: "REGISTERED_BOOL", parser: "parsers.bool()" },
      { name: "MixedCase", parser: 'parsers.enum(["strict", "relaxed"])' },
      { name: "DIRECT_SCHEMA", parser: "parsers.int({ min: 1 })" },
    ],
  );
  assert.ok(result.uppercaseCandidates.includes("INERT_ENV_REFERENCE"));
});

test("candidate threshold covers identifiers and whole string literals, not arbitrary prose", () => {
  const result = inventory([
    {
      byteOffset: 0,
      text: `const LONG_CONSTANT_NAME = "ANOTHER_LONG_NAME"; const SHORT = "prose with NOT_AN_ENV_NAME";`,
    },
  ]);
  assert.deepEqual(result.uppercaseCandidates, [
    "ANOTHER_LONG_NAME",
    "LONG_CONSTANT_NAME",
  ]);
  assert.deepEqual(result.names, []);
});

test("native extraction and evidence offsets use bytes, not UTF-16 positions", () => {
  const source =
    "// @bun @bytecode\n// Claude Code\nconst label = 'é😀'; process.env.TEST_NAME;";
  const prefix = Buffer.from([0xff, 0x00, 0x01]);
  const binary = Buffer.concat([
    prefix,
    Buffer.from(source),
    Buffer.from([0]),
    Buffer.from("ignored"),
  ]);
  const chunks = extractChunks(binary);
  assert.deepEqual(chunks, [{ text: source, byteOffset: prefix.length }]);
  const result = inventory(chunks);
  assert.equal(
    result.references[0].byteOffset,
    binary.indexOf("process.env.TEST_NAME"),
  );
  assert.deepEqual(result.names, ["TEST_NAME"]);
  assert.throws(
    () => extractChunks(Buffer.from("not a binary")),
    /No embedded/,
  );
  assert.throws(() => extractChunks(Buffer.from(source)), /Unterminated/);
});

test("parse failures are explicit, not silently omitted", () => {
  assert.throws(
    () => inventory([{ text: "const broken = ;", byteOffset: 123 }]),
    /Parse error in chunk at 123/,
  );
});
