import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import './app-account-menu.css';

export function AppAccountMenu({
  displayName,
  disabled,
  onAccounts,
  onSettings,
  onChangePassword,
  onSignOut,
}: {
  displayName: string;
  disabled: boolean;
  onAccounts(): void;
  onSettings(): void;
  onChangePassword(): void;
  onSignOut(): void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lastItemOnOpen = useRef(false);
  const visible = open && !disabled;
  const items = [
    { label: '계정 관리', action: onAccounts },
    { label: '설정', action: onSettings },
    { label: '비밀번호 변경', action: onChangePassword },
    { label: '로그아웃', action: onSignOut },
  ];
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!visible) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    buttons?.[lastItemOnOpen.current ? buttons.length - 1 : 0]?.focus();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target))
        setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible]);
  function dismiss() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <div
      ref={container}
      className="app-account-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="app-account-divider" aria-hidden="true" />
      <span className="app-account-nickname" title={displayName}>
        {displayName}
      </span>
      <button
        ref={trigger}
        type="button"
        className="settings-button app-account-trigger"
        aria-label="계정 및 설정 메뉴"
        title="계정 및 설정"
        aria-haspopup="menu"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        disabled={disabled}
        onClick={() => {
          lastItemOnOpen.current = false;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          lastItemOnOpen.current = event.key === 'ArrowUp';
          setOpen(true);
        }}
      >
        <Icon name="settings" />
      </button>
      {visible && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label="계정 및 설정"
          className="app-account-dropdown"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              dismiss();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            );
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={index === items.length - 1 ? 'app-account-signout' : undefined}
              onClick={() => {
                // Keep a connected return-focus target when a menu item opens a dialog.
                dismiss();
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
