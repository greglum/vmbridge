import { expect, test } from "bun:test";
import { parseEnvPaste } from "./env-paste.ts";

const vars = (text: string) => Object.fromEntries(parseEnvPaste(text)?.vars ?? []);

test("reads export lines as separate variables", () => {
  const text = [
    "export R2_ACCESS_ID=abc123",
    "export R2_ACCESS_KEY=def456",
    "export R2_PUBLIC_URL=https://pub-example.r2.dev",
    "export R2_BUCKET_NAME=agent-push",
  ].join("\n");
  expect(parseEnvPaste(text)).toEqual({
    vars: new Map([
      ["R2_ACCESS_ID", "abc123"],
      ["R2_ACCESS_KEY", "def456"],
      ["R2_PUBLIC_URL", "https://pub-example.r2.dev"],
      ["R2_BUCKET_NAME", "agent-push"],
    ]),
    invalidNames: [],
    badLines: [],
    assignments: 4,
  });
});

test("handles spacing, CRLF, semicolons, comments and YAML style", () => {
  const text = "# a comment\r\n\r\nA = 1\r\nB=two words # note\r\nC=3;\r\nD: four\r\nURL=http://host/#top\r\nEMPTY=\r\n  E=5  ";
  expect(vars(text)).toEqual({ A: "1", B: "two words", C: "3", D: "four", URL: "http://host/#top", EMPTY: "", E: "5" });
});

test("a blank value with a comment is empty", () => {
  expect(vars('A= # intentionally empty\nB=" # kept"\nURL=http://host/#top')).toEqual({ A: "", B: " # kept", URL: "http://host/#top" });
});

test("unquotes values", () => {
  const text = [`A="say \\"hi\\"\\nbye" # note`, `B='$HOME \\n # kept'`, `C="a#b";`].join("\n");
  expect(vars(text)).toEqual({ A: 'say "hi"\nbye', B: "$HOME \\n # kept", C: "a#b" });
});

test("double quotes decode escapes like dotenv and keep unknown ones", () => {
  const text = [String.raw`REGEX="^\d+$"`, String.raw`LINES="a\nb"`, String.raw`QUOTE="say \"hi\""`, String.raw`SLASH="C:\\tmp"`].join("\n");
  expect(vars(text)).toEqual({ REGEX: String.raw`^\d+$`, LINES: "a\nb", QUOTE: 'say "hi"', SLASH: String.raw`C:\tmp` });
});

test("keeps a quoted value that runs over several lines", () => {
  const text = 'KEY="-----BEGIN KEY-----\nMIIabc==\n-----END KEY-----"\nNEXT=1';
  expect(vars(text)).toEqual({ KEY: "-----BEGIN KEY-----\nMIIabc==\n-----END KEY-----", NEXT: "1" });
});

test("reports invalid names and other lines without saving them", () => {
  const paste = parseEnvPaste('GOOD=1\nMY-VAR=2\n1BAD=3\njust some text\nOPEN="never closed\nLAST=4');
  expect(paste?.vars).toEqual(new Map([["GOOD", "1"], ["LAST", "4"]]));
  expect(paste?.invalidNames).toEqual(["MY-VAR", "1BAD"]);
  expect(paste?.badLines).toEqual([4, 5]);
});

test("the last value wins for a repeated name", () => {
  expect(vars("A=1\nB=2\nA=3")).toEqual({ A: "3", B: "2" });
});

test("counts every assignment, so a repeated name still reads as a list", () => {
  expect(parseEnvPaste("TOKEN=first\nTOKEN=second")?.assignments).toBe(2);
  expect(parseEnvPaste("TOKEN=second")?.assignments).toBe(1);
});

test("leaves text with no assignment to paste as usual", () => {
  for (const text of ["sk-plain-token", "https://example.com/path?x=1", "two\nlines", "", "  # only a comment"]) expect(parseEnvPaste(text)).toBeNull();
});
