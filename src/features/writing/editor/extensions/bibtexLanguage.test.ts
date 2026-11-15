import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";
import { bibtexParser } from "./bibtexLanguage";

function tokens(text: string) {
  const state = bibtexParser.startState!(2);
  return text.split("\n").flatMap((line) => {
    const stream = new StringStream(line, 2, 2);
    const result: { text: string; style: string | null }[] = [];
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = bibtexParser.token(stream, state);
      expect(stream.pos).toBeGreaterThan(stream.start);
      result.push({ text: stream.current(), style });
    }
    return result;
  });
}

describe("BibTeX highlighting", () => {
  it("distinguishes entry type, citation key, field, strings and numbers", () => {
    const result = tokens('@article{Smith2024, title={A title}, year=2024}');
    for (const token of [
      { text: '@article', style: 'keyword' }, { text: 'Smith2024', style: 'atom' },
      { text: 'title', style: 'propertyName.definition' }, { text: 'A title}', style: 'string' },
      { text: '2024', style: 'number' },
    ]) expect(result).toContainEqual(token);
  });
  it("keeps nested multiline and quoted values from turning into fields", () => {
    const result = tokens('@book(K, title={A {Nested}\nvalue, @notEntry = ok}, author="Name {X} and \\\"Y\\\"", year=2025)');
    expect(result).toContainEqual({ text: 'value, @notEntry = ok}', style: 'string' });
    expect(result).toContainEqual({ text: 'year', style: 'propertyName.definition' });
    expect(result.filter((item) => item.style === 'keyword')).toHaveLength(1);
  });
  it("supports string macros, concatenation, preambles, comments and incomplete input", () => {
    const result = tokens('@comment{ignored {nested}\ntext}\n@string{pub="Press"}\n@preamble{"x" # pub}\n@misc{Key, title={unclosed');
    expect(result).toContainEqual({ text: 'pub', style: 'propertyName.definition' });
    expect(result).toContainEqual({ text: '#', style: 'operator' });
    expect(result).toContainEqual({ text: 'text}', style: 'comment' });
    expect(result.at(-1)?.style).toBe('string');
  });
});
