import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { calendarDays, isDateAllowed, shiftDay, shiftMonth } from './calendar-model';
import { defaultDateRange } from './date-range';
import { Icon } from './Icon';

const dateLabel = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return `${year}년 ${month}월 ${day}일`;
};

export function DatePicker({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange(value: string): void;
}) {
  const today = defaultDateRange().to;
  const selected = isDateAllowed(value) ? value : today;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(selected.slice(0, 7));
  const [focusedDate, setFocusedDate] = useState(selected);
  const days = calendarDays(month);
  const allowed = (date: string) => isDateAllowed(date, min, max);
  const monthAvailable = (candidate: string) =>
    calendarDays(candidate).some((day) => day.inMonth && allowed(day.date));

  function positionCalendar() {
    const button = trigger.current;
    const calendar = popup.current;
    if (!button || !calendar?.matches(':popover-open')) return;
    const rect = button.getBoundingClientRect();
    const width = calendar.offsetWidth;
    const height = calendar.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const preferredTop =
      rect.bottom + height + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : rect.top - height - 6;
    calendar.style.left = `${left}px`;
    calendar.style.top = `${Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8))}px`;
  }
  useEffect(() => {
    setMonth(selected.slice(0, 7));
    setFocusedDate(selected);
  }, [selected]);
  useLayoutEffect(() => {
    if (!open) return;
    positionCalendar();
    const calendar = popup.current;
    const focused =
      calendar?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]:not(:disabled)`) ??
      calendar?.querySelector<HTMLButtonElement>('.calendar-day:not(:disabled)');
    (focused ?? calendar)?.focus({ preventScroll: true });
  }, [open, month, focusedDate, min, max]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', positionCalendar);
    window.addEventListener('scroll', positionCalendar, true);
    return () => {
      window.removeEventListener('resize', positionCalendar);
      window.removeEventListener('scroll', positionCalendar, true);
    };
  }, [open]);

  function focusDate(date: string) {
    if (!allowed(date)) return;
    setMonth(date.slice(0, 7));
    setFocusedDate(date);
  }
  function moveMonth(delta: number, day = Number(focusedDate.slice(8))) {
    const next = shiftMonth(month, delta);
    const options = calendarDays(next).filter((item) => item.inMonth && allowed(item.date));
    if (!options.length) return;
    focusDate(options.find((item) => item.day >= day)?.date ?? options[options.length - 1].date);
  }
  function choose(date: string) {
    if (!allowed(date)) return;
    onChange(date);
    popup.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <div className="date-picker">
      <button
        ref={trigger}
        type="button"
        className="date-trigger"
        aria-label={`${label}: ${value ? dateLabel(selected) : '날짜 선택'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onClick={() => {
          if (!open) {
            setMonth(selected.slice(0, 7));
            setFocusedDate(selected);
          }
        }}
      >
        <span>{value ? value.replaceAll('-', '. ') : '날짜 선택'}</span>
        <svg
          className="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M7 3v4m10-4v4M3 11h18" />
        </svg>
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={`${label} 달력`}
        tabIndex={-1}
        className="date-calendar"
        style={{ position: 'fixed', inset: 'auto', margin: 0 }}
        onToggle={(event) => setOpen(event.currentTarget.matches(':popover-open'))}
        onKeyDown={(event) => {
          const date = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-date]')
            ?.dataset.date;
          if (!date) return;
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
          if (step !== undefined) {
            event.preventDefault();
            focusDate(shiftDay(date, step));
          } else if (event.key === 'PageUp' || event.key === 'PageDown') {
            event.preventDefault();
            moveMonth(event.key === 'PageUp' ? -1 : 1, Number(date.slice(8)));
          }
        }}
      >
        <div className="calendar-header">
          <button
            type="button"
            aria-label="이전 달"
            disabled={!monthAvailable(shiftMonth(month, -1))}
            onClick={() => moveMonth(-1)}
          >
            <Icon name="left" />
          </button>
          <strong aria-live="polite">
            {Number(month.slice(0, 4))}년 {Number(month.slice(5))}월
          </strong>
          <button
            type="button"
            aria-label="다음 달"
            disabled={!monthAvailable(shiftMonth(month, 1))}
            onClick={() => moveMonth(1)}
          >
            <Icon name="right" />
          </button>
        </div>
        <div className="calendar-weekdays" aria-hidden="true">
          {['일', '월', '화', '수', '목', '금', '토'].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="calendar-days">
          {days.map((day) => (
            <button
              key={day.date}
              type="button"
              data-date={day.date}
              className={`calendar-day ${day.inMonth ? '' : 'is-outside'} ${day.date === value ? 'is-selected' : ''} ${day.date === today ? 'is-today' : ''}`}
              aria-label={dateLabel(day.date)}
              aria-pressed={day.date === value}
              aria-current={day.date === today ? 'date' : undefined}
              disabled={!allowed(day.date)}
              tabIndex={day.date === focusedDate ? 0 : -1}
              onFocus={() => setFocusedDate(day.date)}
              onClick={() => choose(day.date)}
            >
              {day.day}
            </button>
          ))}
        </div>
        <div className="calendar-footer">
          <button type="button" disabled={!allowed(today)} onClick={() => choose(today)}>
            오늘
          </button>
        </div>
      </div>
    </div>
  );
}
