export function trimRange(start: string, end: string, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0)
    return { error: '영상 길이를 확인하고 있습니다.' } as const;
  const from = Number(start);
  const to = Number(end);
  if (!start.trim() || !end.trim() || !Number.isFinite(from) || !Number.isFinite(to))
    return { error: '시작과 종료 시간을 초 단위로 입력하세요.' } as const;
  if (from < 0 || to > duration) return { error: '영상 길이 안에서 구간을 선택하세요.' } as const;
  if (to <= from) return { error: '종료 시간은 시작 시간보다 뒤여야 합니다.' } as const;
  return { start: from, end: to, length: to - from } as const;
}

export const timeInput = (seconds: number) =>
  Number.isFinite(seconds) && seconds >= 0 ? String(Math.floor(seconds * 1000) / 1000) : '';
