/**
 * Разбор XML/XHTML в компактное дерево.
 *
 * Зачем своя нормализация поверх fast-xml-parser: режим `preserveOrder` даёт
 * неудобный формат (массивы объектов с одним ключом), а нам нужно дерево,
 * которым удобно и тестировать, и безопасно рендерить.
 *
 * Важно: это ДАННЫЕ, а не DOM. Ни одна строка из книги не попадает в
 * `innerHTML` (см. reader.ts), поэтому скрипты и CSS из недоверенного EPUB
 * физически не могут выполниться. Это надёжнее, чем «вычистить HTML
 * регулярками» или довериться санитайзеру: здесь просто нет пути для кода.
 */

export interface XmlText {
  name: '#text';
  text: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | XmlText;

export function isText(node: XmlNode): node is XmlText {
  return node.name === '#text';
}

export function isElement(node: XmlNode): node is XmlElement {
  return node.name !== '#text';
}

/**
 * Формат fast-xml-parser в режиме preserveOrder: массив «записей», где запись —
 * объект с ключом-именем элемента и значением-массивом записей-потомков, плюс
 * ключ `:@` с атрибутами того же элемента:
 *
 *   {"rootfiles": [ {"rootfile": [], ":@": {"@_full-path": "OEBPS/content.opf"}} ]}
 *
 * Обратите внимание: атрибуты лежат в объекте ЗАПИСИ, а не отдельным элементом
 * массива. Если искать `:@` среди потомков, атрибуты потеряются, и `full-path`
 * покажется пустым — то есть разбор молча превратится в «нет rootfile».
 */
export function normalizePreserved(parsed: unknown): XmlNode[] {
  if (!Array.isArray(parsed)) return [];
  const out: XmlNode[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const attrs = readAttrs(obj);
    for (const key of Object.keys(obj)) {
      if (key === ':@') continue;
      if (key === '#text') {
        pushText(out, obj['#text']);
        continue;
      }
      if (isInstruction(key)) continue;
      out.push(parseElement(key, obj[key], attrs));
    }
  }
  return out;
}

function parseElement(name: string, raw: unknown, attrs: Record<string, string>): XmlElement {
  const el: XmlElement = { name: name.toLowerCase(), attrs, children: [] };
  if (!Array.isArray(raw)) {
    pushText(el.children, raw);
    return el;
  }
  for (const child of raw) {
    if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '#text') {
      pushText(el.children, obj['#text']);
      continue;
    }
    const childAttrs = readAttrs(obj);
    for (const key of keys) {
      if (key === ':@' || key === '#text') continue;
      if (isInstruction(key)) continue;
      el.children.push(parseElement(key, obj[key], childAttrs));
    }
  }
  return el;
}

/** XML-объявление, комментарии и инструкции нам не нужны. */
function isInstruction(name: string): boolean {
  return name.startsWith('?') || name.startsWith('!');
}

function readAttrs(obj: Record<string, unknown>): Record<string, string> {
  const raw = obj[':@'];
  if (raw === null || typeof raw !== 'object') return {};
  return toPlainAttrs(raw as Record<string, unknown>);
}

function pushText(target: XmlNode[], raw: unknown): void {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || text === '') return;
  target.push({ name: '#text', text, attrs: {}, children: [] });
}

function toPlainAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const name = key.startsWith('@_') ? key.slice(2) : key;
    if (typeof value === 'string') out[name.toLowerCase()] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[name.toLowerCase()] = String(value);
  }
  return out;
}

/** Весь текст поддерева без разделителей. */
export function textOf(node: XmlNode): string {
  if (isText(node)) return node.text;
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

export function findElement(node: XmlNode, name: string): XmlElement | null {
  if (isText(node)) return null;
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findElement(child, name);
    if (found !== null) return found;
  }
  return null;
}

export function findElements(node: XmlNode, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (n: XmlNode): void => {
    if (isText(n)) return;
    if (n.name === name) out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

export function findByAttr(node: XmlNode, attr: string, value: string): XmlElement | null {
  let found: XmlElement | null = null;
  const walk = (n: XmlNode): void => {
    if (found !== null || isText(n)) return;
    if (n.attrs[attr] === value) {
      found = n;
      return;
    }
    for (const child of n.children) walk(child);
  };
  walk(node);
  return found;
}

/** Первый дочерний элемент с указанным именем. */
export function firstChildElement(el: XmlElement, name: string): XmlElement | null {
  for (const child of el.children) {
    if (isElement(child) && child.name === name) return child;
  }
  return null;
}

/** Первый элемент с указанным именем среди потомков (включая сам узел). */
export function descendant(el: XmlElement, name: string): XmlElement | null {
  return findElement(el, name);
}

/** Элементы с указанным именем среди потомков, в порядке документа. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  return findElements(el, name);
}
