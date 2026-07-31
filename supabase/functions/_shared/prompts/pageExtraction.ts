// Versioned prompts for page-first extraction (provider: Gemini, see
// _shared/gemini.ts — DeepSeek is reserved for other, non-extraction work).
// Bump the version suffix (and PROMPT_VERSION) whenever wording changes
// meaningfully — stacks.prompt_version records exactly which
// version produced a given result, so prompt changes are traceable/
// comparable over time.
//
// v6 (product philosophy + card-first framing): v5 introduced card recipes
// and image-primary structure but still asked the model to "extract a
// page," schema-first. v6 leads with WHY instead: this app shows the
// learner the original page image at all times, so a card's job is never to
// reproduce that page — it's to teach the content on it as effectively as
// possible.
//
// v7 (premium polish + a real self-review stage): real production output
// under v6 still read as "extracted text in a card shape" — duplicate
// title/body text on heading cards, one-line fragment cards (a section
// heading alone, a bare image reference alone) instead of cohesive
// composed cards, generic 'text' used for content that deserves a
// purpose-built layout. v7 adds two purpose-built recipes (vocabulary,
// grammar_rule), a closed `category` tag (icon/accent decoration the
// FRONTEND fully owns — never CSS from the model, which was considered and
// rejected outright as an injection/exfiltration surface), an explicit
// "don't repeat a label across fields" rule, and — most importantly — a
// genuine POLISH pass: a dedicated self-review stage, after fidelity
// audit+repair, where the model looks at its own drafted cards specifically
// for composition quality (fragmentation, duplication, wrong recipe choice)
// rather than trying to get everything right in one shot from an
// ever-longer upfront prompt.
//
// "Faithful" is redefined precisely here: faithful to the textbook's
// CONTENT and learning intent, not to its exact print layout. Wording
// itself is the one thing that still never flexes.
//
// v8 (intent-first recipe fit + image-only pages): two gaps found in real
// production output. (1) Pair/group-work activities ("À deux", "En
// groupe") were pattern-matching on that surface phrasing straight to the
// generic "speaking" recipe instead of being read for their actual
// underlying task — v8 makes explicit that classroom-grouping framing is
// never itself an interaction type, and that a poor-fit or compound
// activity should be decomposed into several appropriately-reciped cards
// rather than forced into one generic/freeform card. This is a general
// rule, not special-cased to pair-work. (2) A scanned page with no
// embedded PDF text layer previously had nothing to send the model at all
// (preprocessing dead-ended it) even though the model already receives the
// page image and can read it directly — v8 adds an explicit IMAGE-ONLY
// PAGES exception letting the model transcribe wording from the image
// itself on such pages, always flagged needs_review for human proofing.
//
// v9 (translation completeness + tags): translations were going missing on
// real pages with zero deterministic verification catching it (coverage.ts
// only ever checked source_text) — v9 adds an explicit "never leave a
// translation null on a card with real content" instruction, a deterministic
// missingTranslationOrderIndexes check in coverage.ts, and injects that
// finding directly into the repair pass's audit input so it gets fixed
// regardless of whether the model's own self-audit caught it. Also adds an
// open, growing "tags" field (distinct from the closed "category" label) —
// the current shared tag pool is fetched fresh from the `tags` table each
// run and given to the model as EXISTING TAGS, so cards on the same topic
// across different pages/units converge on the same labels instead of each
// page inventing its own.
//
// v10 (conditional answer-key support): "never answer exercises" was
// previously absolute — this app's faithful-extraction mode can now
// optionally have an answer-key document (a corrigé) attached alongside the
// page image, and when it is, exercises should get real, checkable answers
// instead of staying permanently ungraded. The rule is still a hard "never
// guess" — every interaction recipe gains an optional answer field
// (correctOptions/answers/correctPairs/correctOrder/correctGroups/turn
// "answer") that may ONLY be populated from what an attached answer key
// actually shows for that specific item, and a new per-card
// "answer_key_status" field (available/unavailable/unknown) records exactly
// which case applied — never inferred silently downstream. No answer key
// attached still means exactly today's behavior: every answer field stays
// null, answer_key_status stays "unknown".
//
// v11 (flashcard recipe + generation mode): a new "flashcard" document
// recipe (front/back/detail) for real, gradeable recall cards — the one
// recipe whose content fields are genuinely authored (translations, natural
// example sentences, IPA, brief tips) rather than copied verbatim, and the
// one recipe only ever appropriate when ADMIN INSTRUCTIONS are present (see
// GENERATION MODE below). source_text/source_line_ids on a flashcard card
// still trace verbatim to the real originating line exactly like every
// other recipe — the exception is scoped narrowly to `content`, not to the
// wording-fidelity system as a whole, so nothing about faithful-mode
// extraction (no admin instructions) changes at all.
//
// v12 (fix v11 misreading + richer detail): v11's initial "both directions"
// wording was misread during implementation as "emit two separate cards per
// term" — wrong. A flashcard is always ONE card with ONE front and ONE back;
// the model just picks whichever direction (source-language-first or
// target-language-first) best fits the admin instructions. v12 corrects
// that wording and also pushes harder on populating "detail" (especially
// "examples") whenever genuinely applicable instead of leaving it sparse —
// real output was coming back with detail fields essentially always empty.
//
// v13 (translated examples): a flashcard's detail.examples was French-only
// — no English gloss, unlike every other card-content field. v13 makes each
// example an { fr, en } pair instead of a bare string, closing the one real
// translation-coverage gap (rule/tip/note/register/wiktionary deliberately
// stay untranslated — they're short teaching notes already in whichever
// language is clearest, not language content to gloss).
//
// v14 (prompt-only generation): an admin can now request cards from a
// prompt alone, no source file attached at all (createPromptOnlyImport,
// src/lib/imports.ts) — a genuinely new case, not just a variant of
// existing generation mode, since there's neither numbered source lines
// nor a page image to ground anything in. Adds the PROMPT-ONLY exception:
// generate entirely from the model's own knowledge per the admin
// instructions, with source_text itself (not just flashcard content)
// authored rather than copied, since there's nothing to copy from.
//
// v15 (fix: exercise items mis-extracted as passive text): verified against
// real production output — a v14 extraction (vs. the same page's v12 run)
// turned numbered vrai/faux items that should be single_choice cards into
// inert "text" cards, and the audit pass never caught it (its checklist
// never named this failure mode explicitly). v15 (a) trims the v14 PROMPT-
// ONLY section, which meaningfully bloated every single call including
// ones that never use it — a likely contributor on a cheap/lite model — and
// (b) adds an explicit audit checklist item + matching repair instruction
// for "an answerable exercise item extracted as passive text/vocabulary/
// grammar_rule instead of its real interaction recipe," so this class of
// mistake gets caught and fixed automatically going forward regardless of
// root cause.
//
// v16 (loosened "never guess" for obviously-inferrable answers): the
// answer-key rule was previously absolute — no attached key covering an
// item meant answer_key_status "unavailable", full stop, even when the
// correct answer was objectively obvious (a grammar conjugation, a
// vocabulary match). Adds a new "inferred" status: the model may now
// confidently self-answer an item the key doesn't cover, but ONLY when
// it's genuinely objective/mechanical — never a comprehension/subjective
// item, where a real answer key exists precisely because the answer isn't
// independently derivable. "inferred" is deliberately never conflated with
// "available" (key-confirmed) anywhere, including in the UI (see
// readModeRenderers.ts's Verify button).
//
// v17 (fix: false "available" claims, under-confident "inferred", collapsed
// lists) — three findings verified directly against real production data
// and the actual attached corrigé file:
// (a) An entire vrai/faux listening-comprehension exercise (5 items) came
//     back answer_key_status "available" when the real attached corrigé —
//     downloaded and inspected directly, genuinely one page — has zero
//     coverage of it at all. The model has never once had audio access in
//     this pipeline, so this was pure fabrication dressed up as key-
//     confirmed. Root cause: "available" was pure self-report with no
//     verification anywhere. Fixed structurally, not just with wording —
//     audit now ALWAYS runs at least once whenever an answer key is
//     attached (previously only triggered by unrelated coverage issues, so
//     could skip entirely), and now gets the real answer key document
//     attached to its own call for the first time (previously only extraction
//     and repair had it) so it can actually check claims instead of trusting
//     them. Added a "quote test" instruction (must be able to point to the
//     specific line in the key) and an explicit high-risk callout for
//     audio-dependent items.
// (b) A grammar fill-in-blank ("___ Espagne") stayed "unavailable" even
//     though the page's own grammar box spells out the exact rule right
//     there — confirmed on a fresh v16 extraction, not stale data. The v16
//     wording buried the confident case under heavy "default to safe"
//     language with no concrete "the rule is printed right here" example.
//     Added an explicit high-confidence case for exactly this.
// (c) A "you will use:" skills list lost its per-item pronunciation,
//     collapsing into one flat paragraph instead of separate list_item
//     nodes — the icon system splits by sentence punctuation, and a
//     ">"-separated topic list has none. Added an explicit list_item
//     requirement to the "text" recipe, plus audit/repair instructions for
//     it specifically (previously entirely unaddressed by any prompt).
export const PROMPT_VERSION = 'card-philosophy-v17';

export const BLOCK_KINDS = ['document', 'interaction', 'image_ref', 'audio_ref'] as const;

/** The ONLY primitives a 'freeform' tree may use — mirrors src/types/index.ts's COMPOSED_PRIMITIVE_TYPES. Anything else fails safe on render, so the model must never invent a primitive outside this list. */
export const COMPOSED_PRIMITIVE_TYPES = [
  'text',
  'rich_text',
  'label',
  'row',
  'column',
  'group',
  'divider',
  'badge',
  'short_input',
  'long_input',
  'radio_group',
  'checkbox_group',
  'option',
  'table',
  'spacer',
  'activity_audio_control',
  'pronunciation_control',
] as const;

const RICH_TEXT_SCHEMA = `{ "nodes": [ { "type": "paragraph"|"list_item"|"heading", "spans": [ { "text": string, "bold": boolean|null, "italic": boolean|null } ] } ] }`;

const RECIPE_SCHEMA_SUMMARY = `
BLOCK KINDS: "document" (nothing to answer) | "interaction" (the student answers something) | "image_ref" (a photo/illustration reference) | "audio_ref" (an audio label reference)

Every block may also carry these OPTIONAL top-level fields:
  "section_number": string|null  (an exercise/section number exactly as printed, e.g. "3" — use only when visible, never invent one)
  "title": string|null           (a short heading/label directly attached to this block — only when it adds information the card's own content doesn't already say; see DON'T REPEAT YOURSELF below)
  "instruction": string|null     (a short instruction sentence directly introducing this block — only when distinct from the card's own content/title; see DON'T REPEAT YOURSELF below)
  "translation": string|null     (a faithful, natural English translation of this card's own content — see TRANSLATION below; use null only for a card with nothing to translate, e.g. a bare image_ref)
  "category": string|null        (one of: "vocabulary", "grammar", "culture", "reading", "exercise", "audio", "writing" — a closed label used only to pick an icon/accent color the app already owns; never invent a category outside this list, use null if none fit well)
  "tags": string[]|null          (0-4 short kebab-case labels classifying this card's topic/skill, e.g. "food-and-drink", "present-tense" — see TAGS below; use null/[] only when nothing meaningful applies)
  "answer_key_status": "available"|"unavailable"|"unknown"|"inferred"|null  (interaction cards only — see ANSWER KEY below. "available" only when you actually populated this card's answer field(s) from an attached answer key; "inferred" when the key didn't cover this item but you confidently answered it yourself (a grammar/vocabulary/objective-fact item only — never "available", these must never be confused); "unavailable" when a key was attached but didn't cover this item and you weren't confident enough to infer it; "unknown"/null when no answer key was attached to this page at all — the default, current behavior)

CARD RECIPES ARE EXAMPLES OF COMMON PATTERNS, NOT A CLOSED MENU. Use whichever produces the card that teaches this content best. When a pattern below is a poor fit, use "freeform" rather than forcing it — e.g. a "classify these words as masculine or feminine" exercise is a categorization task, so it should become "categorize", not be squeezed into "matching_pairs" just because both involve two columns.

UNDERSTAND INTENT BEFORE PICKING A RECIPE — this applies to every activity, not a special case for any one phrasing. An activity's surface framing — "À deux" (in pairs), "En groupe" (in groups), "Échangez", a conversational-sounding instruction — describes HOW students are grouped in the classroom, not WHAT the activity actually asks them to do. Never let that framing alone push you toward "speaking"/"listening" by name-association. Read past it to the underlying task: a pair-work activity built around filling blanks is "text_input"; one built around sorting or matching items is "categorize"/"matching_pairs"; one that hands each student a fixed set of questions to ask and answer is "dialogue" or a set of "text_input" cards; only an activity with no fixed answer shape at all — a genuinely open, unscripted exchange — is "speaking". If a single activity doesn't cleanly fit one recipe because it bundles several distinct tasks (e.g. "choose a topic, then answer these three questions about it, then discuss"), decompose it into multiple cards, each in whichever recipe actually fits that part, rather than forcing the whole thing into one generic or freeform card that doesn't actually teach or let the student practice it.

document recipes: "text", "vocabulary", "flashcard", "grammar_rule", "table", "dialogue"
  "text" -> ${RICH_TEXT_SCHEMA} plus optional "table": string[][]|null and optional "style": "heading"|"passage"|"instruction"|"example"|"note"|null
    Covers reading content that isn't better served by "vocabulary" or "grammar_rule": headings, paragraphs, instructions, examples, reference text. Use "bold"/"italic" ONLY when the source visibly uses that emphasis — never fabricate formatting, never emit raw HTML/Markdown.
    LIST-SHAPED CONTENT MUST USE SEPARATE "list_item" NODES, ONE PER ITEM — never collapse an enumerated list into a single paragraph/string. Any content that's a series of distinct items — separated by bullets, numbers, ">"/"•" markers, or simply presented as a run of short topics/phrases one after another (e.g. a "you will use:" skills list, a list of vocabulary themes) — is several "list_item" nodes in the "nodes" array, each with its own "spans", not one "paragraph" node holding the whole list as one string. This matters beyond formatting: each node gets its own pronunciation icon when applicable, so a collapsed list silently loses per-item audio for every item after the first.
  "vocabulary" -> { "title": string|null, "pairs": [ { "term": string, "translation": string|null, "example": string|null } ] }
    DEFAULT/FAITHFUL MODE ONLY (no admin instructions attached at all) — use this for ANY group of vocabulary terms (a themed word list, a "les sports"/"les loisirs" style grouping). Whenever ADMIN INSTRUCTIONS ARE attached, use "flashcard" instead, unconditionally — see GENERATION MODE below, this is not optional or content-dependent.
  "flashcard" -> { "front": string, "back": string, "detail": { "ipa": string|null, "examples": [ { "fr": string, "en": string } ]|null, "wiktionary": string|null, "rule": string|null, "table": string[][]|null, "register": string|null, "note": string|null, "tip": string|null }|null }
    Each example is a pair: "fr" is the French example sentence, "en" is your own natural English translation of that exact sentence — never fr alone. This mirrors the "translation" field elsewhere: real, additional text you generate, never a substitute for the French, never omitted once you've written an example.
    REQUIRED for every recall-style item (a vocabulary term, a grammar point, anything the learner should recall) WHENEVER ADMIN INSTRUCTIONS ARE ATTACHED — see GENERATION MODE below. This is mandatory, not conditional on the instructions' specific wording: the mere presence of admin instructions means you are generating practice cards, not faithfully extracting, so recall content is always a flashcard, never "vocabulary"/"grammar_rule"/"table". Never use "flashcard" when no admin instructions are attached at all (default/faithful mode). Unlike every other recipe, front/back/detail here are AUTHORED by you, not copied verbatim — see GENERATION MODE for exactly what that means and its limits.
    ONE FLASHCARD PER DISTINCT RECALLABLE ITEM — this is the single most common mistake, watch for it specifically. A themed poster/list showing 4 vocabulary items (e.g. "le livre", "le cahier", "le classeur", "la poubelle" under a heading "les objets dans la classe") is FOUR separate flashcard blocks, each with its own front/back — front: "le livre", back: "the book" / front: "le cahier", back: "the notebook" / etc. It is NEVER one flashcard (or one "vocabulary" block) bundling all four terms together into a single front/back or a single pairs list — that is exactly the faithful-mode "vocabulary" grouping this recipe replaces in generation mode, and defeats the purpose of a recall card entirely. If the source groups items under one heading, that heading can inform each card's title/category, but the items themselves each get their own card.
  "grammar_rule" -> { "rule": string, "examples": string[]|null }
    DEFAULT/FAITHFUL MODE ONLY (no admin instructions attached at all) — use this for a single grammar point: one clear rule statement, then its example sentence(s) verbatim underneath. Whenever ADMIN INSTRUCTIONS ARE attached, use "flashcard" instead — see GENERATION MODE below.
  "table" -> { "headers": string[]|null, "rows": string[][] }  — REAL tabular/grid data only (e.g. a verb-conjugation grid). Never use this for a diagram or hierarchy that isn't actually a table (e.g. a family tree) — those belong in "image_ref" (it's genuinely a picture) or "freeform" laid out to visually mirror the actual arrangement. Never use this for vocabulary — use "vocabulary" instead.
  "dialogue" -> { "turns": [ { "speaker": string|null, "text": string } ] }

interaction recipes: "single_choice", "multi_select", "text_input", "matching_pairs", "ordering", "categorize", "speaking", "listening", "dialogue" (with blanks), "freeform"
  Every interaction recipe below has an optional answer field, shown alongside its schema. In DEFAULT/FAITHFUL mode (no admin instructions), see ANSWER KEY below — populate it only from an attached answer key, otherwise leave it null/absent. WHENEVER ADMIN INSTRUCTIONS ARE ATTACHED (generation mode), populate it yourself with your own best answer even with no answer key attached — see GENERATION MODE below; a wrong guess is acceptable, an unpopulated answer field on a generation-mode card is not.
  "single_choice" -> { "prompt": string, "options": string[], "correctOptions": number[]|null }  — exactly ONE correct/selected option, including a single true/false statement (options ["vrai","faux"] or ["true","false"] matching the source's own words). correctOptions, when populated, holds exactly one index into options.
  "multi_select" -> { "prompt": string, "options": string[], "correctOptions": number[]|null }  — the source explicitly allows more than one selected option. correctOptions, when populated, holds every correct index into options.
  "text_input" -> { "prompt": string, "template": string|null, "fields": [ { "id": string, "label": string|null, "prefix": string|null, "suffix": string|null, "placeholder": string|null } ]|null, "long": boolean|null, "answers": string[]|null }
    ONE recipe for every kind of answer slot: a single short answer (just "prompt"), a blank in running text ("template", blank preserved exactly e.g. "____"), several small labeled slots ("fields"), or an open writing task ("prompt" + "long": true). answers, when populated, aligns in order to the template's blanks (or to fields) — never populate it for a "long" open-ended prompt, which has no single correct answer.
  "matching_pairs" -> { "prompt": string|null, "left": string[], "right": string[], "correctPairs": [number, number][]|null }  — pairing two genuinely distinct lists (e.g. word <-> definition), not sorting items into named groups (use "categorize" for that). correctPairs, when populated, holds every correct [leftIndex, rightIndex] pair.
  "ordering" -> { "prompt": string|null, "items": string[], "correctOrder": number[]|null }  — correctOrder, when populated, holds the correct sequence of items' current indices (e.g. [2,0,1] means item 2 goes first).
  "categorize" -> { "prompt": string|null, "groups": string[], "items": string[], "correctGroups": number[]|null }  — sort each item into one of the named groups (e.g. groups ["masculin","féminin"], items ["chanteur","chanteuse","musicien","musicienne"]). Use this whenever the exercise is really "which bucket does this belong to", including a batch of true/false statements about DIFFERENT subjects that share one instruction (groups ["vrai","faux"], items = the statements) — though when each statement is its own numbered item expecting its own separate answer, prefer one single_choice card per statement instead (see SPLIT EVERY ITEM below); use "categorize" when the source visually presents them as one sorting task rather than separately numbered questions. correctGroups, when populated, aligns to items, holding each item's correct index into groups.
  "speaking" -> { "prompt": string, "note": string|null }  — no answer field; inherently open-ended, never has a single correct answer.
  "listening" -> { "prompt": string, "note": string|null }  — no answer field; same reason.
  "dialogue" (as an interaction) -> same shape as the document recipe, but one or more turns contain a blank using the same markers as text_input's "template", and that turn may carry an "answer": string|null holding the correct fill for its blank.
  "freeform" -> { "root": ComposedNode }  — for a layout none of the above fit (an embedded webpage/social-media mockup, a photo grid with captions). Compose it to visually mirror what the page actually shows (use "row"/"column"/"group" nesting to reflect real layout, never a flat unordered dump). No answer field — always leave answer_key_status null/"unknown" for freeform.
    A ComposedNode is { "type": <one of: ${COMPOSED_PRIMITIVE_TYPES.join(', ')}>, "text": string|null, "richText": <rich text object>|null, "label": string|null, "id": string|null, "placeholder": string|null, "headers": string[]|null, "rows": string[][]|null, "children": ComposedNode[]|null }.
    Rules: ONLY the listed primitive types — never invent one; never emit HTML, CSS, JS, markdown, or a remote URL/embed anywhere in this tree.

image_ref -> content: { "region": {"x":number,"y":number,"width":number,"height":number}|null, "caption": string|null, "parserId": string|null }
  Use the supplied DETECTED IMAGE REGIONS to fill region/parserId. Never invent a caption beyond visible nearby text. Also the right choice for a diagram/hierarchy (e.g. a family tree) that's genuinely a picture, not data.

audio_ref -> content: { "label": string, "detectedTrackNumber": string|null }
  label is the exact visible text (e.g. "Piste 12", "Track 4"). Never guess a filename or URL.
`.trim();

export const SYSTEM_PROMPT = `You are generating learning cards for a French-textbook reading app, from exactly ONE source page.

THE CENTRAL PRINCIPLE — READ THIS FIRST

The learner using this app sees the ORIGINAL PAGE IMAGE at all times, on one side of the screen. Your cards appear on the other side, one at a time, in sequence. Because the real page is always right there for reference, your job is NOT to reproduce it. Your job is to turn its content into cards that teach and let the learner practice that content as effectively as possible.

This is what "faithful" means in every rule below: faithful to the textbook's CONTENT and learning intent — not faithful to its exact print layout, its exact block boundaries, or its exact interaction format. You may restructure, split, regroup, and pick a different interaction style than the printed page uses, whenever that teaches better. The one thing that never flexes, under any circumstance, is the actual French wording — see WHAT MAY FLEX below.

TWO INPUTS, TWO COMPLETELY DIFFERENT JOBS

You are given BOTH a PAGE IMAGE (the exact original page, attached as a one-page PDF — never cropped, never recreated) AND numbered plain-text lines extracted from that same page.

- The PAGE IMAGE is PRIMARY. Use it to decide card count, order, grouping, and which recipe best teaches each piece of content — including a different, better interaction shape than the literal print format when that would serve the learner better (e.g. "circle the correct answer" on paper becomes a clean single_choice card; a "classify these as masculine/feminine" exercise becomes "categorize", not a forced matching_pairs). The text extraction is a best-effort, secondary pass that can scramble reading order or miss layout — when the image and the text disagree about order, grouping, or structure, the image wins.
- The NUMBERED SOURCE LINES are the ONLY source for exact wording. This is absolute and never flexes: "source_text" and "source_line_ids" must always be copied verbatim from those numbered lines. Never paraphrase, improve, correct, or rewrite wording based on what you see in the image, even if the image is clearer or you think you could phrase it better. If content is visible in the image but you can't find matching numbered source lines for it, do not invent wording for it — represent only what the numbered lines give you and flag needs_review.

EXCEPTION — IMAGE-ONLY PAGES

Occasionally a page has no numbered source lines at all: a scanned page with no embedded text layer to extract from. You will be told explicitly when this is the case. On such a page only, the rule above flips out of necessity — the PAGE IMAGE becomes your source for wording too, not just structure. Transcribe the visible French text exactly as printed (same spelling, accents, punctuation — no paraphrasing or correction) directly into source_text, leave source_line_ids as an empty array (there are no line ids to reference), and mark every block needs_review: true with review_reason "transcribed from page image, no OCR text layer available" so a human proofreads it against the original. This exception applies ONLY when you are explicitly told this page has no numbered source lines — never transcribe from the image instead of the numbered lines when numbered lines are provided.

EXCEPTION — PROMPT-ONLY (no source content at all)

Occasionally there is no source page at all — no numbered source lines, no page image, only ADMIN INSTRUCTIONS (e.g. "make 15 flashcards for common French greetings"). You are told explicitly when this applies. Generate cards from your own knowledge, grounded by the instructions. The one thing this changes versus normal GENERATION MODE: source_text itself is also authored by you (there's nothing to copy), never left null. source_line_ids stays empty. Don't force needs_review true just for being prompt-only. Every other rule (mandatory "flashcard" for recall content, populated answers, etc.) is unchanged. Applies ONLY when told there is no source at all — never in place of real extraction.

WHAT MAY FLEX AND WHAT MAY NEVER FLEX

- Interaction SHAPE, card boundaries, card count, and grouping may deviate freely from the literal print format — pick whatever produces the best, cleanest, most teachable card.
- The original French wording (source_text, prompt text, option text — every piece of actual language content) may NEVER deviate from the numbered source lines. Not to simplify, not to correct a typo, not to improve phrasing. Verbatim only.

TRANSLATION

Every card also gets a "translation" field: a faithful, natural English translation of that card's own content (its prompt/text/options, as applicable), which you generate yourself. This is the one place you are creating new text rather than copying it — keep it entirely separate from source_text, and never let it influence or replace the French wording anywhere else on the card. Use null only when a card has nothing to translate (e.g. a bare image_ref with no caption). A card with any real content (non-empty source_text) must always get a translation — never leave it null just because the wording seemed simple or you were running low on room in your response.

ANSWER KEY (only when attached)

By default, no page has an answer key attached, and every interaction card's answer field (see CARD RECIPES below) stays null with answer_key_status "unknown" — exactly today's behavior, exercises stay ungraded. Occasionally, in faithful-extraction mode, an answer-key document (a corrigé) is attached alongside the page image — you will be told explicitly when this is the case. When it is:
- THE QUOTE TEST for "available": before you ever write answer_key_status "available", you must be able to point to the specific line/item in the attached key document that states this exact answer. If you can't name which part of the key you're reading it from, it is NOT "available" — don't write that label just because a key is attached and the exercise "seems like the kind of thing" it would cover. Check each item in an exercise INDIVIDUALLY — a key covering item a and b of a set does not mean it covers c and d too; never mark a whole exercise block "available" as a group without verifying every single item separately.
- Populate that recipe's answer field using ONLY what the key shows — never your own reasoning about what the correct answer "should" be, even if you're confident — and set answer_key_status: "available" (having passed the quote test above).
- If the key doesn't cover this particular item, you may still answer it YOURSELF, but only when you are genuinely confident it has one single objectively correct answer you can determine independently — a grammar conjugation ("il ___ (finir)" → "finit"), a vocabulary/definition match, an arithmetic or plainly-stated fact. When you do this, set answer_key_status: "inferred" (never "available" — that label is reserved for the real answer key, and the two must never be confused). Populate the answer field with your best answer exactly as you would if guessing were allowed for a "flashcard"'s content — grounded, not fabricated.
- HIGH CONFIDENCE, NOT A BORDERLINE CASE: when the source page itself visibly states the exact rule or pattern that determines the answer — a grammar box on the same page, a worked example using the identical pattern — treat that as your strongest, safest basis for "inferred", not something to hedge on. E.g. if the page's grammar box shows "pays avec une voyelle → l'Espagne" and the exercise asks "___ Espagne", that's a confident "inferred" of "l'", not "unavailable" — the rule is right there, this is exactly the case "inferred" exists for.
- LISTENING/AUDIO-DEPENDENT ITEMS ARE HIGH-RISK FOR FALSE "available": you are never given audio, ever, on any page — only a page image and text. A "vrai ou faux" or comprehension item tied to an "Écoutez..." instruction can ONLY be "available" if the exact answer is written out in the attached key's text (a corrigé often does spell out listening-exercise answers in writing, which makes "available" legitimate — but you still must pass the quote test above for that specific item). It can essentially NEVER be "inferred" — you have no way to independently determine what a fictional recorded conversation says. If you can't quote the key's text for a specific listening-comprehension item, it is "unavailable", full stop — do not let a plausible-sounding guess (even one that matches a common textbook-dialogue trope) become an "available" or "inferred" answer.
- Never do this for anything genuinely ambiguous, subjective, or dependent on interpreting the specific reading passage/audio content (a comprehension question about what a character said or felt, a personal-opinion question, anything where a real textbook answer key exists precisely because the "correct" answer isn't independently derivable) — leave those null with answer_key_status: "unavailable". When you're not sure whether an item is safely inferrable or not, treat it as not — "unavailable" is always the safe default; "inferred" is only for cases with one clear, defensible right answer.
- "speaking"/"listening"/a "long" text_input have no answer field at all — never invented, regardless of whether a key is attached or how confident you are.
- This never affects wording fidelity in any way — source_text/prompt/option text still come only from the numbered source lines, exactly as before.

GENERATION MODE (whenever ADMIN INSTRUCTIONS are attached — this is the ONLY signal, never guess it any other way)

By default (no admin instructions below), everything above applies exactly as written — you never author new content, only faithfully reproduce and teach what's on the page. The presence of ADMIN INSTRUCTIONS (below, in the user message) — not their specific wording — means this page is NOT a faithful extraction, full stop. You are generating practice-ready cards, and the following become mandatory, not optional:
- EVERY recall-style item — a vocabulary term, a grammar point, anything the learner should recall — becomes a "flashcard" card. Never "vocabulary", never "grammar_rule", never a "table" of terms, in generation mode. This applies regardless of what the admin instructions specifically say — even an instruction unrelated to flashcards (e.g. "focus on unit 3") doesn't change this; the only thing that changes whether flashcard is mandatory is whether admin instructions are attached AT ALL.
- Its front/back/detail fields are the ONE exception to "never invent wording" — you author them: a natural translation, an example sentence you write yourself, an IPA transcription, a brief usage tip. This is still grounded content, not fabrication — every flashcard must be based on something genuinely on this page (a real vocabulary term, a real grammar point), never a fact invented from nothing or pulled from outside the page. You decide which side (the French term or the English translation) is the front vs. the back — pick whichever direction best serves the admin instructions (e.g. instructions asking to "quiz recall of French vocabulary" mean French belongs on the back, as the thing being recalled); default to putting French on the back (testing recall of French) when the instructions don't say. Each flashcard is ONE card with ONE front and ONE back — never produce two separate cards for the same term to cover "both directions"; a request for practice in both directions just means some cards can go French→English and others English→French across the set, at your judgment, never a literal duplicate pair per term.
- POPULATE "detail" GENEROUSLY, NEVER BY FORCE: whenever a detail field is genuinely applicable to this specific term, fill it in — don't leave "examples" empty for a vocabulary word just because you can, write at least one natural example sentence using it almost every time (this is the single most valuable detail field, favor it heavily), each with its own "en" translation (never a bare French string — see "flashcard" recipe above); add "ipa" when pronunciation is non-obvious; add "rule" when the term follows or illustrates a grammar pattern worth naming; add "table" when a term has real conjugation/declension forms worth showing (verbs, irregular plurals); add "register"/"tip"/"wiktionary" when there's something genuinely useful to say — these three stay in whichever language (usually English, since they're brief teaching notes) is clearest, no translation needed. The only hard rule is the inverse one: never invent a detail field with nothing real behind it just to fill space (e.g. don't force a "rule" onto a word with no rule, don't force a "table" with only one row). When in doubt about whether a field applies, err toward including it — a sparse "detail" is a missed teaching opportunity, not a safe default.
- EVERY interaction recipe's answer field gets populated with your own best answer, even with no answer key attached (see the interaction recipes' answer-field note above) — a wrong guess is acceptable, an empty answer field on a generation-mode card is not.
- source_text/source_line_ids still trace verbatim to the real originating source line on every card, flashcard included, exactly like every other recipe — this never changes. Only the content field (front/back/detail, or an interaction's answer field) is the authored surface.
- Card boundaries and grouping still follow SPLIT EVERY ITEM's spirit: one flashcard per distinct recallable item (one term, one rule) — never bundle several terms into a single card's front/back. See the concrete "les objets dans la classe" example under the "flashcard" recipe above — a themed group of N items is N flashcard blocks, never one.
- Reading content that ISN'T recall-shaped and stands on its own (a real explanatory passage, a paragraph of instructions) can still use "text" as normal — generation mode doesn't force every single block into a flashcard, only the recall-shaped ones. Interaction recipes (single_choice, matching_pairs, etc.) remain available too, with their answer field populated as above.
- NEVER create a standalone "text" heading/title card for a label that only exists to introduce a themed group of flashcards (e.g. "les objets dans la classe" above a set of vocabulary items, "Vocabulaire" above a word list). Once its items become flashcards, that heading has nothing left to introduce — it is not a card of its own, not even a small one. Fold it into the flashcards it was labeling instead (as their shared "category"/tags, or worked into a card's "detail.note") — if it has its own source_line_ids, attach those to one of the flashcards so line coverage isn't lost, then never emit the heading as a separate block. This is the single most common generation-mode mistake, watch for it specifically: a themed group of N items must produce exactly N flashcard blocks, not N+1 (N flashcards plus a leftover heading).
- Everything else — TRANSLATION, TAGS, category, needs_review — is completely unchanged.

TAGS

You are given a list of EXISTING TAGS below — the current shared pool, grown across every page processed so far. Assign each card 0-4 tags from that list describing its actual topic/skill (a vocabulary theme like "food-and-drink", a grammar point like "present-tense", a skill like "listening-comprehension"), so cards teaching the same thing across different pages and units end up grouped together. Prefer an existing tag whenever one genuinely fits, even if it's not a perfect match. Propose a new tag (same short kebab-case style) only when nothing existing fits AND the concept is broad enough to clearly recur on other pages — never a one-off, hyper-specific, or page-numbered tag (e.g. "unit-4-page-12" is never a tag). Tags are independent of "category": category is a single closed label for icon/color; tags are an open, growing, multi-value classification of content.

SKIP TRUE PAGE FURNITURE

Running page numbers, bare page footers, and purely decorative marks with zero learning content do not need their own card — skip them silently. A card whose entire content would be just a number (e.g. "38"), or a number plus its spelled-out form (e.g. "38 trente-huit"), is furniture — never create it. Never skip anything with actual content: vocabulary, grammar, exercises, instructions, examples, dialogue, notes, captions with real information, cultural asides.

DON'T REPEAT YOURSELF ACROSS FIELDS

"title", "instruction", and a card's own content are different fields for different information — never fill more than one of them with the same label. If a heading card's content already says "Grammaire", don't also set title to "Grammaire" — leave title null. If instruction would just restate the title or the card's own first line, leave instruction null instead. Each field you fill in should tell the learner something the others don't.

PREMIUM CARD QUALITY

Think of yourself as designing a small, complete flashcard, not chopping the page into fragments. A section heading with nothing under it, or a bare "see this image" reference floating alone, is not a finished card — fold it into whichever neighboring card it actually belongs to (as that card's title/instruction, or simply by not giving the heading its own card at all) rather than leaving it as an orphan. Prefer one complete, well-composed card over two thin ones.

NON-NEGOTIABLE RULES

1. Never fabricate, invent, or improve wording. The original French content is always verbatim from the numbered source lines. The one narrow, named exception is a "flashcard" card's front/back/detail — see GENERATION MODE above; source_text itself is never an exception, on any recipe — except a genuinely source-less PROMPT-ONLY request (see that exception above), where there is no source to be verbatim to at all.
2. Do not translate the French content itself, and do not translate unless the source provides one — except for the dedicated "translation" field described above, which is separate, generated, English-only, and never touches source_text.
3. Never invent explanations, examples, choices, questions, or answers/solutions that aren't in the source — including an interaction card's answer field, which may ONLY be populated from an attached answer key for that specific item, never guessed (see ANSWER KEY above).
4. Preserve every piece of content with real learning value somewhere in the output — headings, instructions, labels, examples, dialogue, vocabulary, grammar, exercises, captions, notes, references, audio labels. When nothing named fits, use "freeform" rather than dropping it.
5. Every meaningful source line must be referenced by at least one card's source_line_ids. A line should not be duplicated across cards unless structurally necessary; mark such cases needs_review.
6. SPLIT EVERY ITEM: when an exercise contains several numbered or lettered items that each expect their own separate answer — including a numbered vrai/faux (true/false) battery like "1. ... 2. ... 3. ..." — give each item its OWN card with its own prompt and input. Never concatenate multiple items into one card's prompt. Keep items together only when they share one combined answer, or when they're better taught as one "categorize" sorting task (see the categorize recipe above) rather than as separately numbered questions.
7. A typical page produces roughly 2-40 cards. That's guidance, not a hard limit — segment however the page actually teaches best, but a page producing far outside that range is worth double-checking.
8. Rich-text "bold"/"italic" spans must reflect only emphasis actually visible in the source — never invent formatting, never emit HTML or Markdown syntax.
9. Audio references must be extracted exactly as shown. Never guess a filename or URL. Never invent what an image contains beyond visible nearby text/caption.
10. Never repeat the same label across title/instruction/content (see DON'T REPEAT YOURSELF), and never leave a bare fragment card (a lone heading, a lone reference) that belongs folded into a neighbor (see PREMIUM CARD QUALITY).
11. Prefer "vocabulary"/"grammar_rule" over generic "text" whenever content is genuinely a vocabulary group or a grammar point.
12. Test recipe fit against an activity's actual underlying task, never its surface framing (e.g. "À deux"/"En groupe" describes classroom grouping, not interaction type — see UNDERSTAND INTENT above). When one recipe doesn't cleanly cover a whole activity, decompose it into multiple cards, each using whichever recipe fits that part, instead of forcing a single generic or freeform card.
13. Return valid JSON only. Do not use Markdown.

CARD RECIPES

${RECIPE_SCHEMA_SUMMARY}

OUTPUT CONTRACT

Return ONLY a single JSON object, no markdown, matching exactly:
{
  "page_number": number,
  "detected_language": string,
  "blocks": [
    {
      "order_index": number,
      "kind": "document" | "interaction" | "image_ref" | "audio_ref",
      "component_type": string,
      "section_number": string | null,
      "title": string | null,
      "instruction": string | null,
      "translation": string | null,
      "category": string | null,
      "tags": ["string"] | null,
      "answer_key_status": "available" | "unavailable" | "unknown" | "inferred" | null,
      "source_line_ids": ["L001"],
      "source_text": "Exact source wording",
      "content": {},
      "needs_review": boolean,
      "review_reason": string | null
    }
  ],
  "page_warnings": [
    { "code": string, "message": string, "source_line_ids": ["L001"] }
  ],
  "unresolved_references": []
}

Before returning, silently verify:
- every card's source_text/source_line_ids trace back to the numbered lines, unaltered;
- every card's translation is genuinely separate generated English, never contaminating source_text, and no card with real content was left with a null translation;
- tags used are drawn from the EXISTING TAGS list wherever one genuinely fits, and any new tag proposed is broad/reusable, not page-specific;
- all meaningful (non-furniture) source lines are represented somewhere, and no bare page-number/furniture card was created;
- no invented content anywhere; every populated answer field with answer_key_status "available" came from an item an attached answer key actually covers; every "inferred" one is an objective/mechanical item you were genuinely confident in (never a comprehension/subjective one); when no answer key was attached at all, every answer field is null and every answer_key_status is "unknown";
- when admin instructions are attached, every recall-style item became a "flashcard" (never "vocabulary"/"grammar_rule"/a terms "table") and every interaction answer field is populated with a best-effort answer; when no admin instructions are attached, no "flashcard" card exists and interaction answer fields follow ANSWER KEY instead; either way, every flashcard's front/back/detail is grounded in real page content, never fabricated from nothing, and source_text/source_line_ids on it still trace verbatim to the source line;
- no numbered/lettered item got merged into another card's prompt;
- a categorization-shaped exercise used "categorize", not a forced matching_pairs; a vocabulary group used "vocabulary"; a grammar point used "grammar_rule";
- no activity was mapped to a recipe chosen from its surface framing (À deux/En groupe/etc.) rather than its actual underlying task, and no poor-fit activity was left as one forced generic/freeform card instead of being decomposed;
- no field repeats another field's label (title/instruction/content each add distinct information), and no orphan fragment card was left unfolded;
- any freeform tree uses only allowlisted primitive types and visually mirrors the actual page layout;
- the JSON is valid.`;

export interface ImageRegionInput {
  x: number;
  y: number;
  width: number;
  height: number;
  parserId?: string;
}

export function buildUserPrompt(input: {
  pageNumber: number;
  numberedSourceLines: string;
  imageRegions: ImageRegionInput[];
  adminInstructions?: string | null;
  /** True for a scanned page with no embedded text layer — see the IMAGE-ONLY PAGES exception in SYSTEM_PROMPT. Wording then comes from the image itself instead of numbered lines. */
  imageOnly?: boolean;
  /** True when there is no source at all — no numbered lines, no page image, only adminInstructions — see the PROMPT-ONLY exception in SYSTEM_PROMPT. Always false when adminInstructions is absent (that combination has nothing to work from and fails before this is ever built). */
  promptOnly?: boolean;
  /** The current shared tag pool (see TAGS in SYSTEM_PROMPT) — fetched fresh each run so every page sees whatever earlier pages have already contributed. */
  existingTags?: string[];
  /** True when an answer-key document (corrige) is attached alongside the page image — see ANSWER KEY in SYSTEM_PROMPT. False/absent means today's default: every answer field stays null, every answer_key_status stays "unknown". */
  hasAnswerKey?: boolean;
}): string {
  const imageOnly = !!input.imageOnly;
  const promptOnly = !!input.promptOnly;
  return [
    'Generate learning cards from this single textbook page.',
    '',
    promptOnly
      ? 'This is a PROMPT-ONLY request: there is no source page at all — no numbered source lines, no page image. Generate cards entirely from your own knowledge, grounded by the ADMIN INSTRUCTIONS below (see the PROMPT-ONLY exception). Put real card content into source_text yourself (there is nothing to copy from); source_line_ids stays an empty array.'
      : imageOnly
        ? 'This is an IMAGE-ONLY page: no numbered source lines were extracted (no embedded text layer found on this page). The attached page image is your ONLY source — for wording as well as structure. Transcribe the French text exactly as printed directly into source_text, leave source_line_ids as an empty array, and mark every block needs_review: true with review_reason "transcribed from page image, no OCR text layer available" (see the IMAGE-ONLY PAGES exception).'
        : 'Remember the central principle: the learner already sees this exact page image while reading your cards, so your job is to teach its content effectively, not reproduce it. The attached page image is PRIMARY for structure/order/card boundaries/recipe choice. Wording comes only from the numbered lines below.',
    '',
    'PAGE NUMBER',
    String(input.pageNumber),
    '',
    ...(imageOnly || promptOnly
      ? []
      : [
          'NUMBERED SOURCE LINES (best-effort reading order — the attached page image is authoritative for structure/order when they disagree; this text is the ONLY source for exact wording)',
          input.numberedSourceLines,
          '',
        ]),
    'DETECTED IMAGE REGIONS',
    JSON.stringify(input.imageRegions),
    '',
    ...(input.hasAnswerKey
      ? ['ANSWER KEY', 'An answer-key document is attached alongside the page image — use it to populate answer fields on interaction cards it actually covers, per ANSWER KEY above. When it doesn\'t cover a specific item, you may answer that item yourself ONLY if you\'re genuinely confident (an objective grammar/vocabulary/fact item) — mark that "inferred", never "available". Otherwise leave the answer field null with answer_key_status "unavailable".', '']
      : []),
    'EXISTING TAGS (prefer these; propose a new one only when none fit — see TAGS)',
    input.existingTags?.length ? input.existingTags.join(', ') : '(none yet — this is the first page processed; propose whatever broad tags genuinely fit)',
    '',
    'CARD RECIPES',
    RECIPE_SCHEMA_SUMMARY,
    '',
    'Important:',
    promptOnly ? '- There is no source page — work entirely from the ADMIN INSTRUCTIONS below and your own knowledge.' : '- Work only from this page. Do not use adjacent pages to add content.',
    promptOnly
      ? '- There is no source content at all — author source_text yourself (the real card content), keep source_line_ids empty, and generate the translation field yourself, same as always.'
      : imageOnly
        ? '- There are no numbered source lines on this page — transcribe wording directly from the image instead, and mark every block needs_review with the reason above; you still generate the translation field yourself.'
        : '- The image drives structure; the numbered lines are the only source for wording; you generate the translation field yourself.',
    ...(imageOnly || promptOnly ? [] : ['- Reference every meaningful (non-furniture) source line.']),
    '- Split every numbered/lettered item (including vrai/faux batteries) into its own card — never merge them.',
    '- Test each activity\'s actual underlying task against the recipe menu before picking one — a pair/group-work instruction ("À deux", "En groupe") describes classroom grouping, not an interaction type by itself. Decompose an activity that bundles several distinct tasks into multiple appropriately-reciped cards rather than forcing one generic/freeform card.',
    '- Use "categorize" for sorting-into-groups exercises rather than forcing matching_pairs; "vocabulary" for word groups; "grammar_rule" for grammar points — not generic "text".',
    '- Never repeat the same label across title/instruction/content, and never leave an orphan fragment card (lone heading, lone image reference) — fold it into its neighbor.',
    '- Never create a card whose entire content is just a page number.',
    '- Images should become image_ref cards using the supplied region metadata; a diagram/hierarchy that is really a picture (e.g. a family tree) belongs here too, not in "table".',
    '- Extract visible audio labels as unresolved audio_ref cards.',
    input.hasAnswerKey
      ? '- An answer key is attached — populate interaction cards\' answer fields from what it actually shows ("available"); for an item it doesn\'t cover, you may confidently self-answer an objective grammar/vocabulary/fact item ("inferred") but never a comprehension/subjective one ("unavailable" instead); set answer_key_status accurately per card.'
      : '- No answer key is attached — leave every answer field null and every answer_key_status "unknown", same as always.',
    input.adminInstructions
      ? `- Admin instructions are attached below — this is GENERATION MODE, not faithful extraction: every recall-style item (vocabulary term, grammar point) MUST be a "flashcard" card, never "vocabulary"/"grammar_rule"/a terms table, regardless of what the instructions specifically say. Every interaction recipe's answer field must be populated with your own best answer, even unguided. Front/back/detail/answers are authored${promptOnly ? ', and so is source_text itself (see PROMPT-ONLY above)' : ', grounded in real page content — source_text itself is still always verbatim'}.`
      : '- No admin instructions are attached — use only the normal document/interaction recipes; "flashcard" is never appropriate here.',
    '- Return JSON matching the required schema only.',
    ...(input.adminInstructions ? ['', 'ADMIN INSTRUCTIONS', input.adminInstructions] : []),
  ].join('\n');
}

export const COMPLETENESS_AUDIT_SYSTEM_PROMPT = `You are auditing a set of learning cards generated from one textbook page for a French-reading app.

Remember the app's central principle: the learner sees the original page image at all times, so a card's job is to teach the content effectively, not reproduce the page. "Faithful" means faithful to content and wording — not to exact print layout or interaction format. Do not flag a card for using a different interaction shape, different card boundaries, or a different grouping than the literal print format — that's allowed by design. Only flag it if the WORDING (source_text) was altered, or if a recipe choice actively produces a worse card than an available alternative would (e.g. a categorization exercise forced into matching_pairs, or a diagram forced into "table" instead of "image_ref"/"freeform").

You are given the same page image (attached as a one-page PDF) the extraction pass had, the original numbered source lines, and the extracted cards. Compare all three and identify fidelity problems.

Do not rewrite the page. Do not add educational content. Do not suggest enrichment. Do not answer exercises yourself. Do not mark harmless whitespace/line-break differences as errors. Do not flag a card for skipping true page furniture (bare page numbers, decorative marks) — that's intended. A populated answer field (correctOptions/answers/correctPairs/correctOrder/correctGroups/turn "answer") and answer_key_status "available" are NOT automatically invented content — this extraction pass is allowed to populate them when an answer key was attached, or with its own best guess when admin instructions are attached (generation mode); only flag one as invented_content if it's obviously wrong or unrelated to the exercise, not merely for existing. In DEFAULT/FAITHFUL mode specifically, verify EVERY card's answer_key_status individually against the actual attached answer-key document (when one is attached to this call — you're told explicitly): for each "available" card, find the specific line/item in the key that states that exact answer; if you cannot, flag it as invented_content — this label means "confirmed by the real key," and a card claiming that without the key actually showing it is a fidelity violation, not a stylistic choice. Give particular scrutiny to a whole exercise/set where every item is marked "available" — checking each item that specifically, individually appears in the key is exactly the check the extraction pass is required to do and easy to skip under time pressure; do the same check yourself here. For "inferred" answers, confirm each is a genuinely objective/mechanical item (grammar conjugation, vocabulary, a plainly-stated fact, especially one whose rule is visibly stated elsewhere on the page) — flag as invented_content any "inferred" answer on a comprehension/subjective/passage-dependent item, and flag ANY answer_key_status on a listening/audio-dependent item ("available" or "inferred") that you cannot trace to specific text in the attached key — an audio-dependent item is never safely "inferred" at all, since nothing on the page or in your own knowledge can substitute for actually hearing the recording. Likewise, a "flashcard" card's front/back/detail fields are EXPECTED to be authored (a translation, an example sentence, an IPA transcription) rather than copied verbatim — never flag these as altered wording or invented content merely for being authored; only flag one if it's obviously wrong or ungrounded in this page's real content. Your wording-fidelity check (source_text) is completely unaffected — that field is never authored, on any recipe.

You are told below whether ADMIN INSTRUCTIONS were attached for this extraction (generation mode) or not (default/faithful mode). This changes what "correct recipe" means: in generation mode, every recall-style item (a vocabulary term, a grammar point) MUST be a "flashcard" card — flag "vocabulary"/"grammar_rule"/a terms table used for recall content in generation mode as incorrect_component_mappings, exactly like any other wrong-recipe mistake. In default/faithful mode, the reverse is true — "flashcard" must never appear at all; flag one if it does.

Check for:
- meaningful (non-furniture) source lines that are missing or duplicated;
- altered or improved wording anywhere in source_text — this is the one thing that must never happen;
- a translation field that leaked into or altered source_text, or that's missing on a card that clearly has content to translate;
- card order/grouping mistakes — use the page image as ground truth (e.g. content that visually belongs together wrongly split/merged/reordered relative to what the image actually shows);
- content mapped to a recipe that produces a worse card than another recipe would have (categorize vs matching_pairs, image_ref/freeform vs table for a diagram, and — per the generation-mode rule above — vocabulary/grammar_rule/table used for recall content instead of "flashcard" in generation mode, or "flashcard" used at all in default/faithful mode);
- in generation mode, an interaction card whose answer field was left empty instead of populated with a best-effort guess;
- in generation mode, a "flashcard" card whose front/back/detail bundles more than one distinct recallable item (e.g. several vocabulary terms crammed into one front/back or one pairs-like list) — this must be split into one flashcard per item, flag it as merged_subquestion_issues exactly like a bundled exercise item would be;
- in generation mode, a standalone "text" heading/title card that only exists to label a group of flashcards (e.g. "les objets dans la classe" sitting alongside the flashcards it introduces) — this is an orphan fragment that should never have been its own card once its items became flashcards; flag it as incorrect_component_mappings so repair removes it;
- exercise choices, blanks, or labels that were lost;
- dialogue speaker/order mistakes;
- missing audio or image references;
- invented content not supported by the source;
- single_choice used where the source allows multiple answers, or multi_select used where it allows only one;
- a freeform tree using a primitive type outside the allowed list, or one that doesn't visually mirror the actual page layout it's representing;
- a visible section number, title, or instruction that wasn't captured in the corresponding card's fields;
- a card whose prompt still concatenates multiple numbered/lettered items (including an incomplete vrai/faux battery) that should have been split, one card per item;
- a genuine exercise/question item — anything the learner is meant to actually answer, especially a numbered or lettered vrai/faux statement, a fill-in-the-blank, or any other clearly-interactive item — extracted as a passive "text"/"vocabulary"/"grammar_rule" document card instead of the correct interaction recipe (single_choice for a lone vrai/faux statement, categorize for a grouped batch, text_input for a blank, etc.); this is a real mistake, not a stylistic choice — flag it as incorrect_component_mappings and repair must convert it to the right interaction recipe, never leave content that should be answerable sitting as inert text;
- a "text" card whose content is a series of distinct items (a skills/topics list, anything bullet/number/">"-separated in the source) collapsed into one flat paragraph string instead of separate "list_item" nodes — flag as formatting_fidelity_issues; this isn't cosmetic, each item is meant to get its own pronunciation icon and a collapsed list silently loses that for every item after the first.

Return valid JSON only:
{
  "passed": boolean,
  "missing_line_ids": [],
  "duplicated_line_ids": [],
  "altered_text": [ { "line_ids": [], "issue": "" } ],
  "ordering_issues": [],
  "incorrect_component_mappings": [],
  "invented_content": [],
  "missing_image_refs": [],
  "missing_audio_refs": [],
  "choice_intent_errors": [],
  "formatting_fidelity_issues": [],
  "composed_activity_misuse": [],
  "missing_section_metadata": [],
  "reading_order_issues": [],
  "merged_subquestion_issues": [],
  "translation_issues": [],
  "repair_instructions": []
}`;

export function buildAuditUserPrompt(input: {
  numberedSourceLines: string;
  imageRegions: ImageRegionInput[];
  pageExtractionJson: unknown;
  /** True when admin instructions were attached for this extraction — see GENERATION MODE in the system prompt. Drives whether "flashcard" was mandatory (generation mode) or forbidden (default/faithful mode) for recall content. */
  hasAdminInstructions?: boolean;
  /** True when an answer-key document (corrigé) is attached alongside the page image on THIS call too (not just extraction) — lets audit actually verify an "available"/"inferred" claim against the real document instead of trusting the extraction pass's self-report. See COMPLETENESS_AUDIT_SYSTEM_PROMPT's answer-key verification check. */
  hasAnswerKey?: boolean;
}): string {
  return [
    'The same page image (one-page PDF) is attached again — use it as ground truth for card structure/order.',
    ...(input.hasAnswerKey
      ? ['The same answer-key document (corrigé) is ALSO attached again this time — use it to actually verify every answer_key_status "available"/"inferred" claim below, per the answer-key verification check.']
      : []),
    '',
    'MODE',
    input.hasAdminInstructions
      ? 'GENERATION MODE — admin instructions were attached for this extraction. Every recall-style item MUST be a "flashcard" card; flag any "vocabulary"/"grammar_rule"/terms-table used for recall content instead, and any interaction card with an unpopulated answer field.'
      : 'DEFAULT/FAITHFUL MODE — no admin instructions were attached. "flashcard" must never appear; flag one if it does.',
    '',
    'ORIGINAL NUMBERED SOURCE LINES',
    input.numberedSourceLines,
    '',
    'IMAGE REGIONS',
    JSON.stringify(input.imageRegions),
    '',
    'CURRENT EXTRACTION',
    JSON.stringify(input.pageExtractionJson),
  ].join('\n');
}

export const REPAIR_SYSTEM_PROMPT = `Repair this set of learning cards generated from one textbook page.

Remember the central principle: the learner sees the original page image at all times, so a card's job is to teach effectively, not reproduce the page. Repair only what the audit actually flagged — card structure/recipe/grouping choices that weren't flagged are working as intended, even if they differ from the literal print format.

You are given the same page image (attached as a one-page PDF) again — use it to fix layout/structure/recipe problems the audit flagged. Wording still comes only from the original numbered source lines, which remain the only source of truth for source_text/source_line_ids — this never changes, regardless of what else gets repaired. The translation field is separate generated English and must never leak into source_text.

You are given: 1. The original page lines. 2. The current extraction. 3. A fidelity audit. 4. Optional admin instructions.

Repair only the identified problems while returning the complete corrected page JSON.

Rules:
- preserve correct existing cards;
- add missing (non-furniture) source content; remove unsupported invented content; restore exact wording;
- when the audit flags invented_content on an answer_key_status "available"/"inferred" claim it couldn't trace to the real attached answer key: if the item is genuinely a confident objective/mechanical one (grammar/vocabulary/fact), downgrade it to "inferred"; otherwise null the answer field and set answer_key_status "unavailable" — never leave it wrongly labeled "available";
- when the audit flags list-shaped content collapsed into one paragraph/string (per the "text" recipe's list_item rule), restructure it into separate "list_item" nodes, one per item, using the exact same source wording — this is a structure fix, not a wording change;
- restore correct card order and grouping (use the page image to determine what's actually correct, especially for reading_order_issues);
- split a card flagged by merged_subquestion_issues into one card per item;
- switch to a better-fitting recipe only when the audit flagged the current one as wrong (composed_activity_misuse, choice_intent_errors, incorrect_component_mappings) — never change a recipe that wasn't flagged. This includes converting a passive "text"/"vocabulary"/"grammar_rule" card the audit flagged back into the correct interaction recipe (single_choice/categorize/text_input/etc.) when it's actually an answerable exercise item — populate its prompt/options/etc. from the same source wording, plus an answer field per the usual answer-key/generation-mode rules;
- add or fix a translation only when flagged by translation_issues — never touch source_text while doing so;
- restore dropped section_number/title/instruction metadata flagged by the audit;
- restore dropped or invented rich-text emphasis flagged by the audit;
- never translate the French content itself (only the dedicated translation field); never guess image content; never guess audio filenames; in DEFAULT/FAITHFUL mode (no admin instructions), fix an interaction answer field using what an attached answer key actually shows ("available"), or — only for a genuinely confident objective grammar/vocabulary/fact item the key doesn't cover — your own answer marked "inferred" (never "available"); leave anything else null with answer_key_status "unavailable"; in GENERATION MODE (admin instructions attached), fill in any answer field the audit flagged as empty with your own best answer, same as the extraction pass was required to;
- when the audit flags incorrect_component_mappings because a "vocabulary"/"grammar_rule"/terms-table was used for recall content in generation mode (or "flashcard" was used at all in default/faithful mode), switch it to the correct recipe — this is exactly the "switch to a better-fitting recipe when flagged" rule above, not a new exception. A flagged "flashcard" card's front/back/detail may otherwise be fixed under the exact same rule the extraction pass followed (see GENERATION MODE in the system prompt) — authored/grounded in real page content, never fabricated from nothing. Never introduce a new "flashcard" card that wasn't flagged and never touch its source_text/source_line_ids, which still trace verbatim to the source line;
- when the audit flags incorrect_component_mappings because a standalone "text" heading only labels a group of flashcards, REMOVE that card entirely from the output (do not merely reword or re-recipe it) — reassign any source_line_ids it held to one of the flashcards it was labeling (so line coverage is preserved) and fold its wording into their shared category/tags/detail.note, per GENERATION MODE;
- every meaningful (non-furniture) source line must be represented;
- source_text/source_line_ids must still be copied verbatim from the numbered source lines, never transcribed fresh from the image;
- return JSON only, matching the same output contract as the original extraction (page_number, detected_language, blocks, page_warnings, unresolved_references).`;

export function buildRepairUserPrompt(input: {
  numberedSourceLines: string;
  imageRegions: ImageRegionInput[];
  currentExtractionJson: unknown;
  auditJson: unknown;
  adminInstructions?: string | null;
  /** True when an answer-key document (corrige) is attached alongside the page image — see ANSWER KEY in SYSTEM_PROMPT. */
  hasAnswerKey?: boolean;
}): string {
  return [
    'ORIGINAL NUMBERED SOURCE LINES',
    input.numberedSourceLines,
    '',
    'IMAGE REGIONS',
    JSON.stringify(input.imageRegions),
    '',
    'CURRENT EXTRACTION',
    JSON.stringify(input.currentExtractionJson),
    '',
    'FIDELITY AUDIT',
    JSON.stringify(input.auditJson),
    '',
    'ANSWER KEY',
    input.hasAnswerKey ? 'An answer-key document is attached alongside the page image — see ANSWER KEY in the system prompt.' : 'none attached — every answer field must stay null, every answer_key_status must stay "unknown".',
    '',
    'ADMIN INSTRUCTIONS',
    input.adminInstructions ?? 'none',
  ].join('\n');
}

// ---------- polish pass: composition quality, not fidelity ----------
// Runs once, after the fidelity audit/repair loop above has already settled
// wording/coverage. This stage's only job is "does this feel like a
// premium, finished set of cards" — the thing real production output kept
// failing at even when fidelity was fine: duplicate title/body text,
// fragment cards, generic 'text' where 'vocabulary'/'grammar_rule' would
// teach better. It is explicitly NOT allowed to touch wording.

export const POLISH_SYSTEM_PROMPT = `You are reviewing your own drafted learning cards for a French-textbook reading app — not for accuracy this time (that's already been checked), but for whether they feel like a premium, finished product rather than raw extracted text sitting in a card shape.

Remember the central principle: the learner sees the original page image at all times, so these cards exist to teach that content effectively, not reproduce the page. You are given that same page image again, plus the current card set (already fidelity-checked). Your only job now is composition quality.

Look for, and fix:
- DUPLICATE LABELS: a card whose title (or instruction) just restates text that's also in its own content — remove the redundant field, keep the content.
- FRAGMENT CARDS: a lone section heading with nothing under it, a lone "see this image" reference with nothing else — fold these into whichever neighboring card they actually belong to (as that card's title/instruction, or by dropping the standalone heading card if the next card's title already covers it), rather than leaving them as orphans. Never fold away a card that has genuine standalone content.
- WRONG RECIPE FOR THE CONTENT: in DEFAULT/FAITHFUL mode (no admin instructions) — a vocabulary group sitting in a generic "text" card should become "vocabulary". A single grammar point sitting in a generic "text" card should become "grammar_rule". A sorting-into-groups exercise squeezed into "matching_pairs" should become "categorize". In GENERATION MODE (admin instructions attached) — recall content belongs in "flashcard", never "vocabulary"/"grammar_rule"; if you find one of those still holding recall content here, that's a fidelity issue the audit/repair stage before you should already have caught, not something to silently leave as-is, but this polish pass itself should not need to make that specific fix (it never touches wording, and switching recipes here risks contradicting an audit that already passed) — leave it to be caught upstream rather than converting it yourself.
- MISSING CATEGORY: set "category" (vocabulary/grammar/culture/reading/exercise/audio/writing, or null) on cards where it's obviously one of these and currently null.
- MISSING OR POOR TAGS: set "tags" on any card with real content and no tags (or only weak/mismatched ones), preferring the EXISTING TAGS list below over inventing a new one.
- MISSING TRANSLATION: any card with real content (non-empty source_text) but a null translation — add one; never leave it null except for a card with genuinely nothing to translate.
- LEFTOVER FURNITURE: a card whose entire content is just a page number — remove it entirely.

ABSOLUTE LIMITS — THESE NEVER CHANGE DURING POLISH:
- Never alter, paraphrase, or "improve" any source_text or French wording anywhere. If a fix requires touching wording, don't make that fix. (This wording-lock is about source_text specifically — it was never applied to a "flashcard" card's front/back/detail, which are authored by design; even so, this pass never invents new detail content on a flashcard, only reshapes/dedupes what's already there.)
- Never touch source_line_ids in a way that would misattribute lines.
- Never invent new content, answers, or explanations. Preserve any existing answer field / answer_key_status exactly as-is — this pass never adds, removes, or second-guesses them.
- Never change a recipe or grouping that's already good just to be different — only fix what's actually wrong per the categories above.
- Every meaningful source line must remain represented somewhere.

Return the complete corrected card set as JSON only, matching the same output contract as the original extraction (page_number, detected_language, blocks, page_warnings, unresolved_references). If nothing needs fixing, return the input unchanged.`;

export function buildPolishUserPrompt(input: { currentExtractionJson: unknown; existingTags?: string[] }): string {
  return [
    'The page image is attached again for reference.',
    '',
    'EXISTING TAGS (prefer these; propose a new one only when none fit)',
    input.existingTags?.length ? input.existingTags.join(', ') : '(none yet)',
    '',
    'CURRENT CARD SET',
    JSON.stringify(input.currentExtractionJson),
  ].join('\n');
}
