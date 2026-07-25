import type { NoteType } from '../types';

/** How a chip's field value should be rendered in the panel. Omitted -> plain text (with a small array fallback). */
export type ChipAs = 'table' | 'pair' | 'examples';

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
