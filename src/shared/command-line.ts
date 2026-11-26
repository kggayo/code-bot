/**
 * A command typed on one line, split into the program and its arguments the way a shell would
 * for simple cases: spaces separate words, and double or single quotes keep spaces inside one.
 * Used for the MCP servers in bot settings ("npx @playwright/mcp@latest"). No Node or browser
 * APIs, so the window and the core can both use it.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** The program and its arguments on one line again, quoting the words that need it. */
export function joinCommandLine(words: readonly string[]): string {
  return words.map((word) => (word === '' || /[\s"']/.test(word) ? quoted(word) : word)).join(' ');
}

function quoted(word: string): string {
  return word.includes('"') ? `'${word}'` : `"${word}"`;
}
