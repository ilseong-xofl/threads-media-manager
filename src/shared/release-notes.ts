/**
 * What changed in each version, for the staff (2026-11-26, the user's call). After an update, the
 * first signed-in screen shows the notes this PC has not seen, once, in a modal.
 *
 * Newest first. Every released version needs an entry (a test fails without one for the
 * package version); write it in plain Korean for the staff, not for developers.
 */
export interface ReleaseNote {
  /** `major.minor.patch`, as in package.json. */
  version: string;
  added?: readonly string[];
  changed?: readonly string[];
  fixed?: readonly string[];
}

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '0.1.17',
    added: ['업데이트한 뒤 처음 실행하면 이 창에서 바뀐 점을 알려 줍니다.'],
  },
  {
    version: '0.1.16',
    added: [
      '일상 탭의 [멘트 관리]에서 광고 문구(멘트)를 브랜드 → 제품 아래에 저장해 두고 다시 쓸 수 있습니다.',
      '수동 등록·초안 수정 창에서 브랜드·제품·멘트를 고르면 그 멘트가 본문에 들어갑니다.',
      '같은 창 왼쪽 아래의 [멘트 등록]으로 지금 쓴 본문을 새 멘트로 바로 저장할 수 있습니다.',
      '일상 글에 이미지·영상을 붙일 수 있습니다. 창 맨 위에서 20개까지 넣고 순서를 바꾸거나 뺄 수 있으며, 첨부가 있으면 본문을 비워도 됩니다.',
      '등록 완료한 일상 글도 이 PC에서 지울 수 있습니다. Threads에 올라간 글은 그대로입니다.',
    ],
    changed: [
      '페르소나는 한 화면에 3개씩 보이고, 이름 줄의 화살표를 누르면 이름이 3개씩 넘어갑니다.',
      '일상 카드 맨 위에 첨부한 이미지·영상이 보입니다. 초안 카드는 첨부를 눌러도 초안 수정이 열립니다.',
      '글 쓰는 창의 [취소]·[저장]은 창 아래에 고정됩니다.',
      '화면 위에 뜨는 알림은 성공하면 5초, 그 밖에는 10초 뒤에 저절로 닫힙니다.',
    ],
    fixed: ['서버가 계정 토큰을 읽지 못하면 어느 계정인지 이름과 함께 알려 줍니다.'],
  },
];

export const validVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The notes to show on this launch: newer than `seen` and not newer than `current`. `seen` is null
 * on a PC that has no record. A new install records its own version as it installs, so no record
 * means a PC that ran a version from before the notes, and every note up to `current` shows.
 */
export function releaseNotesToShow(
  notes: readonly ReleaseNote[],
  current: string,
  seen: string | null,
): ReleaseNote[] {
  if (!validVersion(current)) return [];
  return notes.filter(
    (note) =>
      compareVersions(note.version, current) <= 0 &&
      (seen === null || compareVersions(note.version, seen) > 0),
  );
}
