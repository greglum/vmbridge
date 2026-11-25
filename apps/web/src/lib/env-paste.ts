export interface EnvPaste {
  /** In paste order. A name given twice keeps its last value. */
  vars: Map<string, string>;
  /** Names that cannot be environment variables, such as `MY-VAR`. */
  invalidNames: string[];
  /** 1-based numbers of lines that are not `NAME=value`. Only numbers: such a line may be a secret. */
  badLines: number[];
  /** Lines read as `NAME=value`, counting repeated and invalid names. */
  assignments: number;
}

const assignment = /^(?:export\s+)?([^\s=:]+)\s*(?:=|:(?=\s|$))(.*)$/;
const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
// As in dotenv. Any other escape, like `\d` in a regex, keeps its backslash.
const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/**
 * Reads pasted dotenv text: `NAME=value`, `export NAME=value`, `NAME: value`, quoted values and `#` comments.
 * Returns null when no line is an assignment, so a plain value pastes as usual.
 */
export function parseEnvPaste(text: string): EnvPaste | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paste: EnvPaste = { vars: new Map(), invalidNames: [], badLines: [], assignments: 0 };
  for (let index = 0; index < lines.length; index++) {
    // Only the start is trimmed: a quoted value that runs on to the next line keeps its trailing spaces.
    const line = lines[index]!.trimStart();
    if (!line.trim() || line.startsWith("#")) continue;
    const match = assignment.exec(line);
    if (!match) {
      paste.badLines.push(index + 1);
      continue;
    }
    paste.assignments++;
    const [, name = "", rest = ""] = match;
    const read = readValue(rest, lines, index);
    if (!read) {
      paste.badLines.push(index + 1);
      continue;
    }
    index = read.lastLine;
    if (!validName.test(name)) {
      paste.invalidNames.push(name);
      continue;
    }
    paste.vars.set(name, read.value);
  }
  return paste.assignments > 0 ? paste : null;
}

/** The value after the `=` on line `start`. A quoted one may run over later lines. Null when a quote never closes. */
function readValue(rest: string, lines: string[], start: number) {
  const raw = rest.trimStart();
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") {
    // A `#` after a space starts a comment, as in a shell. `URL=http://host/#top` keeps its `#`.
    // Checked before trimming, so `A= # note` is empty rather than `# note`.
    const value = rest.replace(/\s#.*$/, "").trim().replace(/;$/, "").trimEnd();
    return { value, lastLine: start };
  }
  let value = "";
  let text = raw.slice(1);
  for (let line = start; line < lines.length; line++) {
    if (line > start) {
      value += "\n";
      text = lines[line]!;
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      // Whatever follows the closing quote, like `;` or a comment, is dropped.
      if (char === quote) return { value, lastLine: line };
      if (quote === '"' && char === "\\" && i + 1 < text.length) {
        const next = text[++i]!;
        value += escapes[next] ?? `\\${next}`;
      } else value += char;
    }
  }
  return null;
}
