/**
 * Тесты на главы без текста.
 *
 * ─── Почему это важно ──────────────────────────────────────────────────────────
 *
 * В EPUB встречаются файлы, в которых нет ни одного читаемого блока: страница
 * с обложкой, файл с одной картинкой, набор пустых `<p>` от вёрстки. Такая
 * глава рендерится в ПУСТОЙ элемент: страница выглядит сломанной, и
 * единственный способ добраться до текста — жать «Следующая» и гадать.
 *
 * Пользователь на это напоролся при переключении между аудиокнигой и книгой:
 * после возврата открывалась именно такая гла��а, и текст «пропадал».
 */

import { describe, expect, it } from 'vitest';
import { firstVisibleChapter, hasVisibleBlocks, isBlockVisible, type EpubBlock, type EpubChapter } from '@rd/library';

function block(kind: EpubBlock['kind'], text: string, index = 0): EpubBlock {
  return {
    index,
    kind,
    node: { name: kind === 'hr' ? 'hr' : 'p', attrs: {}, children: [{ name: '#text', text, attrs: {}, children: [] }] },
    text,
  };
}

function chapter(blocks: EpubBlock[], index = 0): EpubChapter {
  return { index, id: `c${index}`, href: `c${index}.xhtml`, blocks };
}

/** Глава-обложка: пустой абзац и картинка без подписи. */
function coverChapter(index = 0): EpubChapter {
  return chapter([block('p', '', 0), block('p', '', 1)], index);
}

describe('видимость блока', () => {
  it('текстовый блок виден', () => {
    expect(isBlockVisible(block('p', 'Текст'))).toBe(true);
    expect(isBlockVisible(block('h1', 'Глава'))).toBe(true);
  });

  it('пустой блок не виден', () => {
    // Такой блок рендерится в null и занимает на экране ничего.
    expect(isBlockVisible(block('p', ''))).toBe(false);
    expect(isBlockVisible(block('p', '   '))).toBe(false);
    expect(isBlockVisible(block('p', '\n\t '))).toBe(false);
  });

  it('разделитель виден всегда', () => {
    // У `<hr>` нет текста, но он рисуется, поэтому главу с одним разделителем
    // пустой считать нельзя.
    expect(isBlockVisible(block('hr', ''))).toBe(true);
  });
});

describe('глава без текста', () => {
  it('определяется как пустая', () => {
    expect(hasVisibleBlocks(coverChapter())).toBe(false);
    expect(hasVisibleBlocks(chapter([block('p', 'Есть текст')]))).toBe(true);
    expect(hasVisibleBlocks(undefined)).toBe(false);
  });

  it('пустая глава состоит только из пустых абзацев', () => {
    const ch = chapter([block('p', '', 0), block('p', '', 1), block('p', '\n', 2)]);
    expect(hasVisibleBlocks(ch)).toBe(false);
  });
});

describe('выбор главы с текстом', () => {
  const book = {
    chapters: [coverChapter(0), chapter([block('p', 'Первая', 0)], 1), chapter([block('p', 'Вторая', 0)], 2)],
  };

  it('остаётся на текущей, если в ней есть текст', () => {
    expect(firstVisibleChapter(book, 1)).toBe(1);
    expect(firstVisibleChapter(book, 2)).toBe(2);
  });

  it('перепрыгивает пустую главу вперёд', () => {
    // Именно этот случай и ломал интерфейс: открывали обложку и показывали
    // пустую страницу.
    expect(firstVisibleChapter(book, 0)).toBe(1);
  });

  it('зажимает индекс в пределах книги, если текста нет нигде', () => {
    // Когда пусты ВСЕ главы, правильного ответа нет — важно лишь не отдать
    // индекс за пределами массива: вызывающий код получил бы undefined и
    // упал бы при обращении к chapters[at].
    const empty = { chapters: [coverChapter(0), coverChapter(1)] };
    expect(firstVisibleChapter(empty, 0)).toBe(0);
    expect(firstVisibleChapter(empty, 1)).toBe(1);
    // Просим дальше конца: остаёмся на последней.
    expect(firstVisibleChapter(empty, 5)).toBe(1);
    // Просим до начала: остаёмся на первой.
    expect(firstVisibleChapter(empty, -3)).toBe(0);
  });

  it('переживает книгу без глав', () => {
    expect(firstVisibleChapter({ chapters: [] }, 0)).toBe(0);
  });

  it('пропускает несколько пустых глав подряд', () => {
    const many = {
      chapters: [coverChapter(0), coverChapter(1), coverChapter(2), chapter([block('p', 'Есть')], 3)],
    };
    expect(firstVisibleChapter(many, 0)).toBe(3);
  });
});