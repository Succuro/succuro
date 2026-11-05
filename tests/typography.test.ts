import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Every string a person could read, from the source's syntax tree: comments don't count, and neither do imports. */
function textsIn(file: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push({ text: node.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const sources = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
  const path = join(directory, entry);
  return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : [];
});

/** Words and sentences: an identifier, a class list or a path can't hold these by accident. */
const MISTAKES: [RegExp, string][] = [
  [/[a-z]'[a-z]/i, "a straight apostrophe: use ’"],
  [/\.\.\./, "three dots: use …"],
  [/ -- /, "two hyphens: rewrite the sentence"],
];

const COVERED = ["src/app", "src/application", "src/components", "src/domain", "src/infrastructure/auth", "src/infrastructure/connectors", "src/infrastructure/crypto"];

describe("the words the app says", () => {
  it("use correct typography, in every screen and message", () => {
    const wrong = COVERED.flatMap(sources).flatMap((file) => textsIn(file).flatMap(({ text, line }) => MISTAKES.filter(([pattern]) => pattern.test(text)).map(([, why]) => `${file}:${line} ${why}: ${text.slice(0, 80)}`)));
    expect(wrong).toEqual([]);
  });

  it("find nothing left over in French", () => {
    const FRENCH = /\b(vous|votre|espace|connectez|prospect|ce lien|aucun)\b|[àâçéèêëîïôûùüÿœ]/i;
    const wrong = COVERED.flatMap(sources).flatMap((file) => textsIn(file).filter(({ text }) => FRENCH.test(text)).map(({ text, line }) => `${file}:${line}: ${text.slice(0, 80)}`));
    expect(wrong).toEqual([]);
  });

  it("would catch a mistake", () => {
    expect(MISTAKES.some(([pattern]) => pattern.test("don't"))).toBe(true);
    expect(MISTAKES.some(([pattern]) => pattern.test("Loading..."))).toBe(true);
    expect(MISTAKES.some(([pattern]) => pattern.test("don’t, and Loading…"))).toBe(false);
  });
});
