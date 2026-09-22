import type { CollectionView, PostLinkResult } from '../shared/contracts';

function validUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    !/^https?:\/\//i.test(value) ||
    /\s|\\/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  try {
    const url = new URL(value);
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !!authority &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !authority.includes('@')
    );
  } catch {
    return false;
  }
}

export async function openPostLink(
  view: CollectionView,
  input: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<PostLinkResult> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !('postKey' in input) ||
    typeof input.postKey !== 'string' ||
    !input.postKey ||
    input.postKey.length > 512 ||
    !('kind' in input) ||
    (input.kind !== 'original' && input.kind !== 'comment')
  )
    return {
      status: 'error',
      problem: { code: 'link_input', message: '열 링크의 게시글 정보를 확인하세요.' },
    };
  const post = view.snapshot?.posts.find((item) => item.key === input.postKey);
  if (!post)
    return {
      status: 'error',
      problem: {
        code: 'link_post_missing',
        message: '게시글을 찾을 수 없습니다. 목록을 새로고침하세요.',
      },
    };
  const url = input.kind === 'original' ? post.originalUrl : post.comment?.link;
  if (!validUrl(url))
    return {
      status: 'error',
      problem: {
        code: 'link_invalid',
        message: '등록된 링크가 올바른 http/https 주소인지 확인하세요.',
      },
    };
  try {
    // Preserve the registered URL exactly, including its query and fragment.
    await openExternal(url);
    return { status: 'opened' };
  } catch {
    return {
      status: 'error',
      problem: {
        code: 'link_open_failed',
        message: '브라우저에서 링크를 열지 못했습니다. 기본 브라우저 설정을 확인하세요.',
      },
    };
  }
}
