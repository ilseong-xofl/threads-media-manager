import { afterEach, expect, it, vi } from 'vitest';
import { createToastStore } from './toast-store';

afterEach(() => vi.useRealTimers());

it('expires success and failure notices independently', () => {
  vi.useFakeTimers();
  const store = createToastStore();
  store.notify({ message: '저장 완료' });
  store.notify({ message: '저장 실패', error: true });
  vi.advanceTimersByTime(3500);
  expect(store.getSnapshot().map((notice) => notice.message)).toEqual(['저장 실패']);
  vi.advanceTimersByTime(3500);
  expect(store.getSnapshot()).toEqual([]);
  store.dispose();
});

it('coalesces an error reported by multiple panels while restarting its timer', () => {
  vi.useFakeTimers();
  const store = createToastStore();
  store.notify({ message: '토큰 확인 실패', error: true });
  const id = store.getSnapshot()[0].id;
  vi.advanceTimersByTime(6000);
  store.notify({ message: '토큰 확인 실패', error: true });
  expect(store.getSnapshot()).toHaveLength(1);
  expect(store.getSnapshot()[0].id).toBe(id);
  vi.advanceTimersByTime(1000);
  expect(store.getSnapshot()).toHaveLength(1);
  vi.advanceTimersByTime(6000);
  expect(store.getSnapshot()).toEqual([]);
  store.dispose();
});

it('keeps a fresh timer when a keyed notice is replaced', () => {
  vi.useFakeTimers();
  const store = createToastStore();
  store.notify({ key: 'operation', message: '이전 오류', error: true });
  vi.advanceTimersByTime(6500);
  store.notify({ key: 'operation', message: '복구 완료' });
  vi.advanceTimersByTime(500);
  expect(store.getSnapshot().map((notice) => notice.message)).toEqual(['복구 완료']);
  vi.advanceTimersByTime(3000);
  expect(store.getSnapshot()).toEqual([]);
  store.dispose();
});

it('bounds the visible stack and cancels timers for dismissed or removed notices', () => {
  vi.useFakeTimers();
  const store = createToastStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  for (let n = 0; n < 4; n++) store.notify({ message: `안내 ${n}` });
  expect(store.getSnapshot().map((notice) => notice.message)).toEqual([
    '안내 1',
    '안내 2',
    '안내 3',
  ]);
  expect(vi.getTimerCount()).toBe(3);
  store.dismiss(store.getSnapshot()[0].id);
  expect(vi.getTimerCount()).toBe(2);
  unsubscribe();
  listener.mockClear();
  store.notify({ message: '구독 해제 뒤 안내' });
  expect(listener).not.toHaveBeenCalled();
  store.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
