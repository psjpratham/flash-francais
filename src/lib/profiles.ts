import type { NoteType } from '../types';

/** How a chip's field value should be rendered in the panel. Omitted -> plain text (with a small array fallback, which also mis-renders a 2-item array as a translation 'pair' — 'list' sidesteps that for a plain list of independent strings, e.g. flashcard examples, which aren't fr/en pairs like the legacy manual-card 'examples' shape is). */
export type ChipAs = 'table' | 'pair' | 'examples' | 'list';

export interface ProfileChip {
  label: string;
  field: string;
  as?: ChipAs;
}

export interface Profile {
  chips: ProfileChip[];
}

/** Ported 1:1 from the old prototype's PROFILES object. */
export const PROFILES: Record<NoteType, Profile> = {
  basic: {
    chips: [{ label: 'Tip', field: 'tip' }],
  },
  vocab: {
    chips: [
      { label: 'Gender', field: 'gender' },
      { label: 'Examples', field: 'examples', as: 'examples' },
      { label: 'Note', field: 'note' },
      { label: 'Tip', field: 'tip' },
    ],
  },
  anki: {
    chips: [
      { label: 'IPA', field: 'ipa' },
      { label: 'Forms', field: 'decl' },
      { label: 'Examples', field: 'examples', as: 'examples' },
      { label: 'Wiktionary', field: 'wiktionary' },
      { label: 'Tip', field: 'tip' },
    ],
  },
  grammar: {
    chips: [
      { label: 'Rule', field: 'rule' },
      { label: 'Table', field: 'table', as: 'table' },
      { label: 'Examples', field: 'examples', as: 'examples' },
      { label: 'Tip', field: 'tip' },
    ],
  },
  phrase: {
    chips: [
      { label: 'Register', field: 'register' },
      { label: 'Reply', field: 'reply', as: 'pair' },
      { label: 'Examples', field: 'examples', as: 'examples' },
      { label: 'Tip', field: 'tip' },
    ],
  },
  culture: {
    chips: [
      { label: 'Detail', field: 'detail' },
      { label: 'Tip', field: 'tip' },
    ],
  },
  phonetics: {
    chips: [
      { label: 'Letters', field: 'letters' },
      { label: 'Rule', field: 'rule' },
      { label: 'Tip', field: 'tip' },
    ],
  },
};

/** Chip spec for a textbook_extraction-origin 'flashcard' card's `content.detail` — same shape/fields as PROFILES.anki's chips, just a standalone export since flashcard cards are keyed by CardRecipe, not NoteType, so they don't live in the PROFILES map above. */
export const FLASHCARD_CHIPS: ProfileChip[] = [
  { label: 'IPA', field: 'ipa' },
  { label: 'Examples', field: 'examples', as: 'list' },
  { label: 'Wiktionary', field: 'wiktionary' },
  { label: 'Rule', field: 'rule' },
  { label: 'Table', field: 'table', as: 'table' },
  { label: 'Register', field: 'register' },
  { label: 'Note', field: 'note' },
  { label: 'Tip', field: 'tip' },
];
