type RewriteMap = Map<string, string>;

export function rewriteIdentifiersOutsideTrivia(text: string, replacements: RewriteMap): string {
  if (replacements.size === 0 || !text) return text;
  let output = "";
  let index = 0;

  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1] ?? "";

    if (current === "'" || current === '"') {
      const consumed = consumeQuoted(text, index, current);
      output += consumed.text;
      index = consumed.end;
      continue;
    }

    if (current === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      if (end < 0) return output + text.slice(index);
      output += text.slice(index, end);
      index = end;
      continue;
    }

    if (current === "(" && next === "*") {
      const consumed = consumeNestedComment(text, index);
      output += consumed.text;
      index = consumed.end;
      continue;
    }

    if (isIdentifierStart(current)) {
      const consumed = consumeQualifiedIdentifier(text, index);
      const replacement = replacements.get(consumed.text);
      output += replacement ?? consumed.text;
      index = consumed.end;
      continue;
    }

    output += current;
    index++;
  }

  return output;
}

export function stripTrivia(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1] ?? "";
    if (current === "'" || current === '"') {
      const consumed = consumeQuoted(text, index, current);
      output += maskTrivia(consumed.text);
      index = consumed.end;
      continue;
    }
    if (current === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      if (end < 0) return output + maskTrivia(text.slice(index));
      output += maskTrivia(text.slice(index, end));
      index = end;
      continue;
    }
    if (current === "(" && next === "*") {
      const consumed = consumeNestedComment(text, index);
      output += maskTrivia(consumed.text);
      index = consumed.end;
      continue;
    }
    output += current;
    index++;
  }
  return output;
}

function maskTrivia(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function consumeQuoted(text: string, start: number, quote: string): { text: string; end: number } {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return { text: text.slice(start, index + 1), end: index + 1 };
    }
    index++;
  }
  return { text: text.slice(start), end: text.length };
}

function consumeNestedComment(text: string, start: number): { text: string; end: number } {
  let index = start + 2;
  let depth = 1;
  while (index < text.length && depth > 0) {
    if (text[index] === "(" && text[index + 1] === "*") {
      depth++;
      index += 2;
      continue;
    }
    if (text[index] === "*" && text[index + 1] === ")") {
      depth--;
      index += 2;
      continue;
    }
    index++;
  }
  return { text: text.slice(start, index), end: index };
}

function consumeQualifiedIdentifier(text: string, start: number): { text: string; end: number } {
  let index = start;
  while (index < text.length) {
    if (isIdentifierPart(text[index])) {
      index++;
      continue;
    }
    if (text[index] === "." && isIdentifierStart(text[index + 1] ?? "")) {
      index++;
      continue;
    }
    break;
  }
  return { text: text.slice(start, index), end: index };
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
