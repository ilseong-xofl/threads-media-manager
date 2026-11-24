import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { DailyMedia } from '../shared/daily';
import { DailyMediaField } from './DailyMediaField';

const render = (media: DailyMedia[], ready = true) =>
  renderToStaticMarkup(
    createElement(DailyMediaField, {
      media,
      selectionId: null,
      ready,
      disabled: false,
      onChange: vi.fn(),
      onAdd: vi.fn(),
      onImporting: vi.fn(),
    }),
  );
const file = (id: string, change: Partial<DailyMedia> = {}): DailyMedia => ({
  id,
  kind: 'image',
  name: `${id}.jpg`,
  url: `threads-media://file/${id}`,
  ...change,
});

it('starts with the drop box of the collection’s [등록] window', () => {
  const html = render([]);
  expect(html).toContain('이미지·영상 <span>0 / 20</span>');
  expect(html).toContain('class="registration-empty"');
  expect(html).toContain('이미지·영상을 여기에 끌어다 놓거나 파일 선택을 누르세요.');
  expect(html).toContain('선택한 파일은 앱 작업 폴더에 복사해 보관합니다.');
  expect(html).not.toMatch(/<button type="button" disabled=""/);
});

it('shows the first attachment large and each one with its name and order buttons', () => {
  const html = render([file('a'), file('b', { kind: 'video', name: 'clip.mp4' })]);
  expect(html).toContain('<span>2 / 20</span>');
  expect(html).toContain('<img src="threads-media://file/a" alt="a.jpg"');
  expect(html).toContain('<span class="registration-preview-count">1 / 2</span>');
  expect(html).toContain('aria-label="2. clip.mp4"');
  expect(html).toContain('preload="metadata"');
  // The first cannot move forward and the last cannot move back.
  expect(html).toMatch(/aria-label="1번 미디어 앞으로" disabled=""/);
  expect(html).toMatch(/aria-label="2번 미디어 뒤로" disabled=""/);
  expect(html).toContain('aria-label="1번 미디어 제외"');
  expect(html).not.toContain('registration-empty');
});

it('takes no files without a work folder', () => {
  const html = render([], false);
  expect(html).toContain('작업 폴더를 지정하면 이미지·영상을 첨부할 수 있습니다.');
  expect(html).not.toContain('앱 작업 폴더에 복사해 보관합니다.');
  expect(html).toMatch(/<button type="button" disabled="">.*파일 선택<\/button>/);
});

it('marks a file that cannot be found and takes no more past the limit', () => {
  const full = Array.from({ length: 20 }, (_, index) => file(`f${index}`));
  full[0] = file('f0', { url: null });
  const html = render(full);
  expect(html).toContain('<span class="registration-media-missing">파일 없음</span>');
  expect(html).toContain('<span>20 / 20</span>');
  expect(html).toMatch(/<button type="button" disabled="">.*파일 선택<\/button>/);
});
