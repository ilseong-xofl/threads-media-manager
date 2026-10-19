import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  cancelManagedThreadsDialog,
  ManagedThreadsActionDialog,
} from './ManagedThreadsActionDialog';
import { ManagedThreadsAccountFields } from './ManagedThreadsAccountSettings';

it('renders only the add form in its own native dialog, leaving the table in its parent', () => {
  const html = renderToStaticMarkup(
    createElement(ManagedThreadsActionDialog, {
      title: 'Threads 계정 추가',
      busy: false,
      onClose: vi.fn(),
      children: createElement(ManagedThreadsAccountFields, {
        id: 'new-account',
        appName: '',
        label: '',
        token: '',
        registering: true,
        disabled: false,
        onAppNameChange: vi.fn(),
        onLabelChange: vi.fn(),
        onTokenChange: vi.fn(),
      }),
    }),
  );
  expect(html).toContain('<dialog');
  expect(html).toContain('aria-label="Threads 계정 추가 닫기"');
  expect(html).toContain('Meta 앱 이름');
  expect(html).toContain('Threads 계정 이름');
  expect(html).toContain('type="password"');
  expect(html).not.toContain('<table');
  expect(html).not.toContain('서버와 동기화');
});

it('consumes Escape without propagating it to the parent table and only closes the child', () => {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  const close = vi.fn();
  cancelManagedThreadsDialog(event, false, close);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('consumes Escape during a save or delete without closing either dialog', () => {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  const close = vi.fn();
  cancelManagedThreadsDialog(event, true, close);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});
