import { createHash } from "node:crypto";
import {
  Diagnostic,
  SourceFile,
  SourceSpan,
  TcGenDocument,
  TcGenObject,
  TcGenObjectKind,
  diagnostic
} from "../domain/models.js";

type HeaderMatch = {
  kind: TcGenObjectKind;
  name: string;
  terminator: string;
  ownerName?: string;
  access?: TcGenObject["access"];
  modifiers?: string[];
  extendsType?: string;
  implementsTypes?: string[];
  language?: TcGenObject["implementationLanguage"];
};

type Block = {
  header: HeaderMatch;
  attributes: string[];
  start: number;
  end: number;
  lines: string[];
};

const accessWords = new Set(["PUBLIC", "PRIVATE", "PROTECTED", "INTERNAL"]);
const fbModifierWords = new Set(["PUBLIC", "INTERNAL", "ABSTRACT", "FINAL"]);
const languages = new Set(["ST", "FBD", "LD", "SFC", "IL"]);

export class TcGenBundleParser {
  parseSources(sources: SourceFile[], options: { autoClose?: boolean } = {}): TcGenDocument {
    const objects: TcGenObject[] = [];
    const diagnostics: Diagnostic[] = [];
    const files: SourceFile[] = [];

    for (const source of sources) {
      const normalized = normalizeSource(source);
      files.push(normalized);
      const parsed = this.parseSource(normalized, options);
      objects.push(...parsed.objects);
      diagnostics.push(...parsed.diagnostics);
    }

    const byQualifiedName = new Map<string, TcGenObject>();
    for (const object of objects) {
      const key = `${object.kind}:${object.qualifiedName.toLowerCase()}`;
      const existing = byQualifiedName.get(key);
      if (existing) {
        diagnostics.push(
          diagnostic("error", "TCPARSE_DUPLICATE_OBJECT", `Duplicate ${object.kind} definition '${object.qualifiedName}'.`, {
            original: object.sourceSpan,
            object: object.qualifiedName
          })
        );
      } else {
        byQualifiedName.set(key, object);
      }
    }

    const byOwner = new Map<string, TcGenObject[]>();
    for (const object of objects) {
      if (object.ownerName) {
        const key = object.ownerName.toLowerCase();
        const children = byOwner.get(key) ?? [];
        children.push(object);
        byOwner.set(key, children);
      }
    }
    for (const object of objects) {
      const children = byOwner.get(object.qualifiedName.toLowerCase()) ?? [];
      object.childIds.push(...children.map(child => child.id));
    }

    return {
      schemaVersion: 1,
      files,
      objects,
      diagnostics
    };
  }

  private parseSource(source: SourceFile, options: { autoClose?: boolean }): { objects: TcGenObject[]; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const lines = source.content.split("\n");
    const scanLines = options.autoClose ? autoCloseTopLevel(lines) : lines;
    const blocks: Block[] = [];
    let cursor = 0;
    let pendingAttributes: { text: string; line: number }[] = [];

    while (cursor < scanLines.length) {
      const line = scanLines[cursor] ?? "";
      const trimmed = line.trim();
      if (!trimmed || isCommentLine(trimmed)) {
        cursor++;
        continue;
      }

      if (isAttributeLine(trimmed)) {
        pendingAttributes.push({ text: line, line: cursor + 1 });
        cursor++;
        continue;
      }

      const header = matchHeader(trimmed);
      if (!header) {
        pendingAttributes = [];
        cursor++;
        continue;
      }

      const end = findBlockEnd(scanLines, cursor + 1, header.terminator);
      if (end < 0) {
        diagnostics.push(
          diagnostic("error", "TCPARSE_MISSING_TERMINATOR", `${header.kind} '${qualifiedName(header)}' is missing ${header.terminator}.`, {
            original: span(source.path, cursor + 1, cursor + 1),
            object: qualifiedName(header)
          })
        );
        pendingAttributes = [];
        cursor++;
        continue;
      }

      blocks.push({
        header,
        attributes: pendingAttributes.map(item => item.text),
        start: pendingAttributes.length > 0 ? pendingAttributes[0].line - 1 : cursor,
        end,
        lines: scanLines.slice(cursor, end + 1)
      });
      pendingAttributes = [];
      cursor = end + 1;
    }

    const objects: TcGenObject[] = [];
    for (const block of blocks) {
      const created = createObject(source.path, block);
      objects.push(created.object);
      if (block.header.kind === "functionBlock" || block.header.kind === "program" || block.header.kind === "interface") {
        const nested = extractNestedChildren(source.path, created.object);
        objects.push(...nested.objects);
        diagnostics.push(...nested.diagnostics);
        created.object.implementationText = nested.ownerImplementation;
      }
    }

    return { objects, diagnostics };
  }
}

function normalizeSource(source: SourceFile): SourceFile {
  return {
    path: source.path,
    content: source.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  };
}

function matchHeader(line: string): HeaderMatch | undefined {
  const withoutLanguage = stripTrailingLanguage(line);
  const language = parseLanguage(line);
  let match = /^TYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/i.exec(line);
  if (match) return { kind: "type", name: match[1], terminator: "END_TYPE", language: "ST" };

  match = /^FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/i.exec(withoutLanguage);
  if (match) return { kind: "function", name: match[1], terminator: "END_FUNCTION", language };

  match = /^INTERFACE\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+EXTENDS\s+(.+?))?\s*$/i.exec(line);
  if (match) return { kind: "interface", name: match[1], terminator: "END_INTERFACE", extendsType: trimOrUndefined(match[2]), language: "ST" };

  match = /^FUNCTION_BLOCK\s+(.+?)\s*$/i.exec(withoutLanguage);
  if (match) {
    const parsed = parsePouHeaderTail(match[1], fbModifierWords);
    if (parsed) {
      return { kind: "functionBlock", name: parsed.name, terminator: "END_FUNCTION_BLOCK", modifiers: parsed.modifiers, extendsType: parsed.extendsType, implementsTypes: parsed.implementsTypes, language };
    }
  }

  match = /^PROGRAM\s+(.+?)\s*$/i.exec(withoutLanguage);
  if (match) {
    const parsed = parsePouHeaderTail(match[1], new Set());
    if (parsed) {
      return { kind: "program", name: parsed.name, terminator: "END_PROGRAM", modifiers: parsed.modifiers, extendsType: parsed.extendsType, implementsTypes: parsed.implementsTypes, language };
    }
  }

  match = /^GVL\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(line);
  if (match) return { kind: "gvl", name: match[1], terminator: "END_GVL", language: "ST" };

  match = /^PARAMETER_LIST\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(line);
  if (match) return { kind: "parameterList", name: match[1], terminator: "END_PARAMETER_LIST", language: "ST" };

  match = /^VISUALIZATION\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(line);
  if (match) return { kind: "visualization", name: match[1], terminator: "END_VISUALIZATION", language: "unknown" };

  match = /^METHOD(?:\s+(PUBLIC|PRIVATE|PROTECTED|INTERNAL))?\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*(.+?))?\s*$/i.exec(withoutLanguage);
  if (match) return { kind: "method", ownerName: match[2], name: match[3], access: parseAccess(match[1]), terminator: "END_METHOD", language };

  match = /^PROPERTY(?:\s+(PUBLIC|PRIVATE|PROTECTED|INTERNAL))?\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*(.+?))?\s*$/i.exec(withoutLanguage);
  if (match) return { kind: "property", ownerName: match[2], name: match[3], access: parseAccess(match[1]), terminator: "END_PROPERTY", language };

  match = /^ACTION\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(withoutLanguage);
  if (match) return { kind: "action", ownerName: match[1], name: match[2], terminator: "END_ACTION", language };

  match = /^TRANSITION\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(withoutLanguage);
  if (match) return { kind: "transition", ownerName: match[1], name: match[2], terminator: "END_TRANSITION", language };

  return undefined;
}

function parsePouHeaderTail(text: string, allowedModifiers: Set<string>): { name: string; modifiers: string[]; extendsType?: string; implementsTypes: string[] } | undefined {
  const tokens = text.trim().split(/\s+/);
  const modifiers: string[] = [];
  while (tokens.length > 0 && allowedModifiers.has(tokens[0].toUpperCase())) {
    modifiers.push(tokens.shift()!.toUpperCase());
  }
  const name = tokens.shift();
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;

  let extendsType: string | undefined;
  let implementsTypes: string[] = [];
  const rest = tokens.join(" ");
  const extendsMatch = /\bEXTENDS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(rest);
  if (extendsMatch) extendsType = extendsMatch[1];
  const implementsMatch = /\bIMPLEMENTS\s+(.+?)\s*$/i.exec(rest);
  if (implementsMatch) implementsTypes = splitCsv(implementsMatch[1]);
  return { name, modifiers, extendsType, implementsTypes };
}

function createObject(path: string, block: Block): { object: TcGenObject } {
  const body = block.lines.slice(1, -1);
  const split = splitDeclarationAndImplementation(body);
  const qn = qualifiedName(block.header);
  const declarationHeader = rewriteExternalChildHeader(block.lines[0], block.header);
  const declarationText = joinLines([...block.attributes, declarationHeader, ...split.declarationLines]);
  const implementationText = joinLines(stripStandaloneLanguageDirective(split.implementationLines));

  return {
    object: {
      id: objectId(path, block.header.kind, qn),
      kind: block.header.kind,
      name: block.header.name,
      qualifiedName: qn,
      ownerName: block.header.ownerName,
      access: block.header.access,
      modifiers: block.header.modifiers ?? [],
      extendsType: block.header.extendsType,
      implementsTypes: block.header.implementsTypes ?? [],
      implementationLanguage: block.header.language ?? "ST",
      declarationText,
      implementationText,
      attributes: block.attributes,
      sourceSpan: span(path, block.start + 1, block.end + 1),
      childIds: []
    }
  };
}

function extractNestedChildren(path: string, owner: TcGenObject): { objects: TcGenObject[]; diagnostics: Diagnostic[]; ownerImplementation: string } {
  const diagnostics: Diagnostic[] = [];
  const lines = owner.implementationText ? owner.implementationText.split("\n") : [];
  const objects: TcGenObject[] = [];
  const retained: string[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const trimmed = lines[cursor]?.trim() ?? "";
    const method = /^METHOD(?:\s+(PUBLIC|PRIVATE|PROTECTED|INTERNAL))?\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*(.+?))?\s*$/i.exec(trimmed);
    const property = /^PROPERTY(?:\s+(PUBLIC|PRIVATE|PROTECTED|INTERNAL))?\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*(.+?))?\s*$/i.exec(trimmed);
    const nestedKind: "method" | "property" | undefined = method ? "method" : property ? "property" : undefined;
    if (!nestedKind) {
      retained.push(lines[cursor]);
      cursor++;
      continue;
    }

    const headerMatch = method ?? property!;
    const terminator = nestedKind === "method" ? "END_METHOD" : "END_PROPERTY";
    const end = findBlockEnd(lines, cursor + 1, terminator);
    if (end < 0) {
      diagnostics.push(
        diagnostic("error", "TCPARSE_MISSING_NESTED_TERMINATOR", `Nested ${nestedKind} '${owner.qualifiedName}.${headerMatch[2]}' is missing ${terminator}.`, {
          original: span(path, owner.sourceSpan.startLine + cursor, owner.sourceSpan.startLine + cursor),
          object: `${owner.qualifiedName}.${headerMatch[2]}`
        })
      );
      retained.push(lines[cursor]);
      cursor++;
      continue;
    }

    const nestedLines = lines.slice(cursor, end + 1);
    const split = splitDeclarationAndImplementation(nestedLines.slice(1, -1));
    const qn = `${owner.qualifiedName}.${headerMatch[2]}`;
    objects.push({
      id: objectId(path, nestedKind, qn),
      kind: nestedKind,
      name: headerMatch[2],
      qualifiedName: qn,
      ownerName: owner.qualifiedName,
      access: parseAccess(headerMatch[1]),
      modifiers: [],
      implementsTypes: [],
      implementationLanguage: "ST",
      declarationText: joinLines([nestedLines[0], ...split.declarationLines]),
      implementationText: joinLines(split.implementationLines),
      attributes: [],
      sourceSpan: span(path, owner.sourceSpan.startLine + cursor, owner.sourceSpan.startLine + end),
      childIds: []
    });
    cursor = end + 1;
  }

  return { objects, diagnostics, ownerImplementation: joinLines(retained) };
}

function splitDeclarationAndImplementation(lines: string[]): { declarationLines: string[]; implementationLines: string[] } {
  const declarationLines: string[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const trimmed = lines[cursor]?.trim() ?? "";
    if (!/^VAR(?:_|$)/i.test(trimmed) && !/^VAR$/i.test(trimmed)) break;
    const end = findBlockEnd(lines, cursor + 1, "END_VAR");
    if (end < 0) break;
    declarationLines.push(...lines.slice(cursor, end + 1));
    cursor = end + 1;
    while (cursor < lines.length && !lines[cursor].trim()) {
      declarationLines.push(lines[cursor]);
      cursor++;
    }
  }
  return {
    declarationLines,
    implementationLines: lines.slice(cursor)
  };
}

function rewriteExternalChildHeader(line: string, header: HeaderMatch): string {
  if (!header.ownerName || !["method", "property", "action", "transition"].includes(header.kind)) return line;
  return line.replace(`${header.ownerName}.${header.name}`, header.name);
}

function findBlockEnd(lines: string[], start: number, terminator: string): number {
  for (let index = start; index < lines.length; index++) {
    if ((lines[index] ?? "").trim().toUpperCase() === terminator) return index;
  }
  return -1;
}

function stripTrailingLanguage(line: string): string {
  return line.replace(/\s+LANGUAGE\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i, "").trimEnd();
}

function parseLanguage(line: string): TcGenObject["implementationLanguage"] {
  const match = /\bLANGUAGE\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(line);
  if (!match) return "ST";
  const upper = match[1].toUpperCase();
  return languages.has(upper) ? (upper as TcGenObject["implementationLanguage"]) : "unknown";
}

function stripStandaloneLanguageDirective(lines: string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && !result[0].trim()) result.shift();
  if (result.length > 0 && /^LANGUAGE\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i.test(result[0].trim())) {
    result.shift();
  }
  return result;
}

function autoCloseTopLevel(lines: string[]): string[] {
  const result: string[] = [];
  let open: HeaderMatch | undefined;
  for (const line of lines) {
    const header = matchHeader(line.trim());
    if (header && open) {
      result.push(open.terminator);
      open = undefined;
    }
    result.push(line);
    if (header) open = header;
    if (open && line.trim().toUpperCase() === open.terminator) open = undefined;
  }
  if (open) result.push(open.terminator);
  return result;
}

function qualifiedName(header: HeaderMatch): string {
  return header.ownerName ? `${header.ownerName}.${header.name}` : header.name;
}

function objectId(path: string, kind: TcGenObjectKind, qn: string): string {
  const digest = createHash("sha256").update(`${path}\n${kind}\n${qn}`).digest("hex").slice(0, 16);
  return `${kind}:${qn}:${digest}`;
}

function span(path: string, startLine: number, endLine: number): SourceSpan {
  return { path, startLine, endLine };
}

function joinLines(lines: string[]): string {
  return lines.join("\n").trimEnd();
}

function splitCsv(text: string): string[] {
  return text.split(",").map(part => part.trim()).filter(Boolean);
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function parseAccess(value: string | undefined): TcGenObject["access"] | undefined {
  const upper = (value ?? "").toUpperCase();
  if (!accessWords.has(upper)) return undefined;
  return upper.toLowerCase() as TcGenObject["access"];
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("(*");
}

function isAttributeLine(trimmed: string): boolean {
  return /^\{attribute\s+'[^']+'.*\}$/i.test(trimmed);
}
