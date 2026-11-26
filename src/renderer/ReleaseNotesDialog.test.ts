import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';

it('shows each version, newest first, with only the kinds of change it has', () => {
  const html = renderToStaticMarkup(
    createElement(ReleaseNotesDialog, {
      notes: [
        { version: '0.1.17', added: ['새 창'] },
        { version: '0.1.16', changed: ['바뀐 점'], fixed: ['고친 점'] },
      ],
      onClose: vi.fn(),
    }),
  );
  expect(html).toContain('업데이트 내역');
  expect(html.indexOf('<h4>0.1.17</h4>')).toBeGreaterThan(-1);
  expect(html.indexOf('<h4>0.1.17</h4>')).toBeLessThan(html.indexOf('<h4>0.1.16</h4>'));
  expect(html.match(/새로 생긴 것/g)).toHaveLength(1);
  expect(html.match(/바뀐 것/g)).toHaveLength(1);
  expect(html.match(/고친 것/g)).toHaveLength(1);
  expect(html).toContain('<li>새 창</li>');
  expect(html).toContain('<li>고친 점</li>');
  expect(html).toMatch(/<button type="button" class="primary">확인<\/button>/);
});
