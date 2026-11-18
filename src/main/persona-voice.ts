import type { CaptionLanguage } from '../shared/contracts';

/**
 * How an ordinary person of each language types on Threads. The daily posts and the captions
 * written as a persona share it: a change here changes both.
 */
export const LANGUAGE_NAMES: Record<CaptionLanguage, string> = {
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese',
};

// 2026-11-18: how many emoji a person uses is theirs, not their language's, so the persona says it.
export const EMOJI_COUNT =
  'The persona description may say how many emoji this person puts in one post (its 이모지 item, such as "0개" or "1~2개"). When it does, every post keeps within that count, and that replaces what is said here about the amount of emoji; 0 means no emoji at all, and then no post has one. Which emoji and where they go still follow this voice.';
export interface Voice {
  intro: string;
  /** A stock question ending the question post should not lean on. */
  closing: string;
  voice: string;
  texture: string;
  /** How the three written posts are shaped; a post whose content is given keeps its own shape. */
  structure: string;
  emoji: string;
}
export const VOICES: Record<CaptionLanguage, Voice> = {
  ja: {
    intro:
      'These must read like posts an ordinary person in Japan types on a phone in the moment, not like tidy copy or a witty observation.',
    closing: 'みんな〜？',
    // 2026-11-18, after reading other ordinary accounts: the emoji habit first written here was
    // one account's, not everyone's.
    voice:
      "Type the way people do on Japanese Threads: one thought per line, and a longer sentence may break across lines at its natural pauses; usually no 。 at the end of a line, plain form and です/ます mixed loosely as the persona's tone allows, with spoken endings and fillers where they fit (〜なんだけど, 〜かな？, 〜のかな, 〜してます, 教えてください, 笑, 、、, a drawn-out ー). People in the same situation may be spoken to directly, as people there do (働くママさん, 〜な方いますか？, みなさん); that address is allowed.",
    texture:
      'Keep it as rough as phone typing is: leave out the subject, break off without finishing the sentence (〜なんだけど / 〜で💦 / 〜かな、、), say things in the order they come to mind and add an afterthought on a new line (ちなみに〜 / あと〜). Use 笑, ！！, ？？ or a drawn-out ーー in some posts.',
    structure:
      'Do not arrange every post as situation, details, then a polite question; once the ask is out, stop, and never add a closing remark. The quoted phrases only show the texture: use a different way in each post, and never open a post the way one of recentPosts opens.',
    emoji:
      "Emoji follow the persona's tone and the mood of the post, so the three posts do not carry the same amount: light chatter or a plea for help often has one at the end of a line, repeated when the feeling is strong (😭😭); a vent or a flat remark often has none and leans on 笑, （笑）, ww or a drawn-out ー instead. Pick the ones Japanese users reach for in that mood (😭 💦 🥲 🤣 😂 🫠 🙏 🤔, or a plain object emoji).",
  },
  en: {
    intro:
      'These must read like posts an ordinary person in the persona\'s country types on a phone in the moment, not like tidy copy, a one-liner with a punchline, or an engagement line such as "Nobody talks about how…" or "Moms, tell me yours do this too".',
    closing: '"Does anyone else…?"',
    voice:
      'Type the way people do on English-language Threads: conversational and a little unpolished, in the everyday spelling and words of the persona\'s country (American English when the home is not in an English-speaking country). Sentences run on, with dashes, "..." and asides in parentheses; the ask often comes first and the context after. Let the person have an attitude where it fits: mild exasperation, laughing at themselves, heading off the obvious reply ("and yes, I already tried…").',
    texture:
      'Keep it as rough as phone typing is: start some posts mid-thought or straight on the question ("so", "why does", "is it normal that", "Found out today that", "update:"), drop the subject where people do ("Tried the tabs, still falling down"), use plain everyday words and the occasional filler (honestly, literally, idk, lol), double a ?? or !! when it fits, and let a sentence trail off or add an afterthought on a new line. A lowercase start or a missing apostrophe is fine in one of the three.',
    structure:
      'Do not tidy a post into setup, detail, question and a closing remark; once the ask is out, stop. The quoted phrases only show the texture: use a different way in each post, and never open a post the way one of recentPosts opens.',
    emoji:
      // 2026-11-18, the user's call: every English post carries emoji, one to three of them.
      'Every post carries emoji: at least one and at most three, each placed where the feeling is, in the middle of a line or at its end, not lined up at the very end out of habit. Use the ones English speakers reach for in that mood (😭 😅 🙃 🫠 😂 🥲 🤦), and do not give the three posts the same ones.',
  },
  ko: {
    intro:
      'These must read like posts an ordinary person in Korea types on a phone in the moment, not like tidy copy, a blog sentence or a witty observation.',
    closing: '다들 어떻게 해?',
    voice:
      "Type the way people do on Korean Threads: 반말 to everyone is the custom there, so use it unless the persona's tone says otherwise, mixed with 음슴체 endings where they fit (~함, ~임, ~하는 중). One thought per line. The question often comes first (혹시 ~ 있어?, ~ 어떻게 해야 해?), and readers may be called 스친 or 스친들 as people there do; that customary address is allowed.",
    texture:
      'Keep it as rough as phone typing is: leave out the subject and particles, break off with .., … or ,, instead of finishing, say things in the order they come to mind and add an afterthought on a new line (참고로 ~ / 아 그리고 ~). Use ㅠㅠ, ㅋㅋ, ?? or ~~ in some posts, with the loose spacing people type.',
    structure:
      'Do not arrange every post as situation, details, then a polite question; once the ask is out, stop, and never add a closing remark. The quoted phrases only show the texture: use a different way in each post, and never open a post the way one of recentPosts opens.',
    emoji:
      'Emoji are light in this voice: many posts have none and lean on ㅠㅠ or ㅋㅋ instead, and a post that has any has one or two (🥹 😭 😂 🙏).',
  },
};
// 2026-11-18: an account without a persona writes in the same Threads voice (the user's call; the
// older fixed style read like tidy translated copy).
const NO_PERSONA =
  "No persona is given for these texts, so there is no persona's tone, country or emoji count to follow. Where the notes below mention them, use the default the notes name for people writing in this language (for English, American English), and let the mood of the source decide how casual or warm the wording is.";
/** `wording` for a text that has no persona behind it. */
export const plainWording = (language: CaptionLanguage) => {
  const v = VOICES[language];
  return [NO_PERSONA, v.voice, v.texture, v.emoji].join('\n');
};
/** The part of a style that is about wording, for a post whose content is already given. */
export const wording = (language: CaptionLanguage) => {
  const v = VOICES[language];
  return [v.voice, v.texture, v.emoji, EMOJI_COUNT].join('\n');
};
