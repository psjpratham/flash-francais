// Versioned prompts for page-first extraction (provider: Gemini, see
// _shared/gemini.ts — DeepSeek is reserved for other, non-extraction work).
// Bump the version suffix (and PROMPT_VERSION) whenever wording changes
// meaningfully — page_extractions.prompt_version records exactly which
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

export const PROMPT_VERSION = 'card-philosophy-v9';

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

CARD RECIPES ARE EXAMPLES OF COMMON PATTERNS, NOT A CLOSED MENU. Use whichever produces the card that teaches this content best. When a pattern below is a poor fit, use "freeform" rather than forcing it — e.g. a "classify these words as masculine or feminine" exercise is a categorization task, so it should become "categorize", not be squeezed into "matching_pairs" just because both involve two columns.

UNDERSTAND INTENT BEFORE PICKING A RECIPE — this applies to every activity, not a special case for any one phrasing. An activity's surface framing — "À deux" (in pairs), "En groupe" (in groups), "Échangez", a conversational-sounding instruction — describes HOW students are grouped in the classroom, not WHAT the activity actually asks them to do. Never let that framing alone push you toward "speaking"/"listening" by name-association. Read past it to the underlying task: a pair-work activity built around filling blanks is "text_input"; one built around sorting or matching items is "categorize"/"matching_pairs"; one that hands each student a fixed set of questions to ask and answer is "dialogue" or a set of "text_input" cards; only an activity with no fixed answer shape at all — a genuinely open, unscripted exchange — is "speaking". If a single activity doesn't cleanly fit one recipe because it bundles several distinct tasks (e.g. "choose a topic, then answer these three questions about it, then discuss"), decompose it into multiple cards, each in whichever recipe actually fits that part, rather than forcing the whole thing into one generic or freeform card that doesn't actually teach or let the student practice it.

document recipes: "text", "vocabulary", "grammar_rule", "table", "dialogue"
  "text" -> ${RICH_TEXT_SCHEMA} plus optional "table": string[][]|null and optional "style": "heading"|"passage"|"instruction"|"example"|"note"|null
    Covers reading content that isn't better served by "vocabulary" or "grammar_rule": headings, paragraphs, instructions, examples, reference text. Use "bold"/"italic" ONLY when the source visibly uses that emphasis — never fabricate formatting, never emit raw HTML/Markdown.
  "vocabulary" -> { "title": string|null, "pairs": [ { "term": string, "translation": string|null, "example": string|null } ] }
    Use this — not a generic "text" list or a "table" — for ANY group of vocabulary terms (a themed word list, a "les sports"/"les loisirs" style grouping). This is a purpose-built card: term prominent, translation alongside, an example sentence if the source gives one. Never flatten a vocabulary group into plain paragraph text.
  "grammar_rule" -> { "rule": string, "examples": string[]|null }
    Use this — not generic "text" — for a single grammar point: one clear rule statement, then its example sentence(s) verbatim underneath. If a page has several distinct grammar points, give each its own grammar_rule card rather than bundling them into one long "text" card.
  "table" -> { "headers": string[]|null, "rows": string[][] }  — REAL tabular/grid data only (e.g. a verb-conjugation grid). Never use this for a diagram or hierarchy that isn't actually a table (e.g. a family tree) — those belong in "image_ref" (it's genuinely a picture) or "freeform" laid out to visually mirror the actual arrangement. Never use this for vocabulary — use "vocabulary" instead.
  "dialogue" -> { "turns": [ { "speaker": string|null, "text": string } ] }

interaction recipes: "single_choice", "multi_select", "text_input", "matching_pairs", "ordering", "categorize", "speaking", "listening", "dialogue" (with blanks), "freeform"
  "single_choice" -> { "prompt": string, "options": string[] }  — exactly ONE correct/selected option, including a single true/false statement (options ["vrai","faux"] or ["true","false"] matching the source's own words)
  "multi_select" -> { "prompt": string, "options": string[] }  — the source explicitly allows more than one selected option
  "text_input" -> { "prompt": string, "template": string|null, "fields": [ { "id": string, "label": string|null, "prefix": string|null, "suffix": string|null, "placeholder": string|null } ]|null, "long": boolean|null }
    ONE recipe for every kind of answer slot: a single short answer (just "prompt"), a blank in running text ("template", blank preserved exactly e.g. "____"), several small labeled slots ("fields"), or an open writing task ("prompt" + "long": true).
  "matching_pairs" -> { "prompt": string|null, "left": string[], "right": string[] }  — pairing two genuinely distinct lists (e.g. word <-> definition), not sorting items into named groups (use "categorize" for that).
  "ordering" -> { "prompt": string|null, "items": string[] }
  "categorize" -> { "prompt": string|null, "groups": string[], "items": string[] }  — sort each item into one of the named groups (e.g. groups ["masculin","féminin"], items ["chanteur","chanteuse","musicien","musicienne"]). Use this whenever the exercise is really "which bucket does this belong to", including a batch of true/false statements about DIFFERENT subjects that share one instruction (groups ["vrai","faux"], items = the statements) — though when each statement is its own numbered item expecting its own separate answer, prefer one single_choice card per statement instead (see SPLIT EVERY ITEM below); use "categorize" when the source visually presents them as one sorting task rather than separately numbered questions.
  "speaking" -> { "prompt": string, "note": string|null }
  "listening" -> { "prompt": string, "note": string|null }
  "dialogue" (as an interaction) -> same shape as the document recipe, but one or more turns contain a blank using the same markers as text_input's "template"
  "freeform" -> { "root": ComposedNode }  — for a layout none of the above fit (an embedded webpage/social-media mockup, a photo grid with captions). Compose it to visually mirror what the page actually shows (use "row"/"column"/"group" nesting to reflect real layout, never a flat unordered dump).
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

WHAT MAY FLEX AND WHAT MAY NEVER FLEX

- Interaction SHAPE, card boundaries, card count, and grouping may deviate freely from the literal print format — pick whatever produces the best, cleanest, most teachable card.
- The original French wording (source_text, prompt text, option text — every piece of actual language content) may NEVER deviate from the numbered source lines. Not to simplify, not to correct a typo, not to improve phrasing. Verbatim only.

TRANSLATION

Every card also gets a "translation" field: a faithful, natural English translation of that card's own content (its prompt/text/options, as applicable), which you generate yourself. This is the one place you are creating new text rather than copying it — keep it entirely separate from source_text, and never let it influence or replace the French wording anywhere else on the card. Use null only when a card has nothing to translate (e.g. a bare image_ref with no caption). A card with any real content (non-empty source_text) must always get a translation — never leave it null just because the wording seemed simple or you were running low on room in your response.

TAGS

You are given a list of EXISTING TAGS below — the current shared pool, grown across every page processed so far. Assign each card 0-4 tags from that list describing its actual topic/skill (a vocabulary theme like "food-and-drink", a grammar point like "present-tense", a skill like "listening-comprehension"), so cards teaching the same thing across different pages and units end up grouped together. Prefer an existing tag whenever one genuinely fits, even if it's not a perfect match. Propose a new tag (same short kebab-case style) only when nothing existing fits AND the concept is broad enough to clearly recur on other pages — never a one-off, hyper-specific, or page-numbered tag (e.g. "unit-4-page-12" is never a tag). Tags are independent of "category": category is a single closed label for icon/color; tags are an open, growing, multi-value classification of content.

SKIP TRUE PAGE FURNITURE

Running page numbers, bare page footers, and purely decorative marks with zero learning content do not need their own card — skip them silently. A card whose entire content would be just a number (e.g. "38"), or a number plus its spelled-out form (e.g. "38 trente-huit"), is furniture — never create it. Never skip anything with actual content: vocabulary, grammar, exercises, instructions, examples, dialogue, notes, captions with real information, cultural asides.

DON'T REPEAT YOURSELF ACROSS FIELDS

"title", "instruction", and a card's own content are different fields for different information — never fill more than one of them with the same label. If a heading card's content already says "Grammaire", don't also set title to "Grammaire" — leave title null. If instruction would just restate the title or the card's own first line, leave instruction null instead. Each field you fill in should tell the learner something the others don't.

PREMIUM CARD QUALITY

Think of yourself as designing a small, complete flashcard, not chopping the page into fragments. A section heading with nothing under it, or a bare "see this image" reference floating alone, is not a finished card — fold it into whichever neighboring card it actually belongs to (as that card's title/instruction, or simply by not giving the heading its own card at all) rather than leaving it as an orphan. Prefer one complete, well-composed card over two thin ones.

NON-NEGOTIABLE RULES

1. Never fabricate, invent, answer, or improve wording. The original French content is always verbatim from the numbered source lines.
2. Do not translate the French content itself, and do not translate unless the source provides one — except for the dedicated "translation" field described above, which is separate, generated, English-only, and never touches source_text.
3. Never invent explanations, examples, choices, questions, or solutions that aren't in the source.
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
- no answers or invented content anywhere;
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
  /** The current shared tag pool (see TAGS in SYSTEM_PROMPT) — fetched fresh each run so every page sees whatever earlier pages have already contributed. */
  existingTags?: string[];
}): string {
  const imageOnly = !!input.imageOnly;
  return [
    'Generate learning cards from this single textbook page.',
    '',
    imageOnly
      ? 'This is an IMAGE-ONLY page: no numbered source lines were extracted (no embedded text layer found on this page). The attached page image is your ONLY source — for wording as well as structure. Transcribe the French text exactly as printed directly into source_text, leave source_line_ids as an empty array, and mark every block needs_review: true with review_reason "transcribed from page image, no OCR text layer available" (see the IMAGE-ONLY PAGES exception).'
      : 'Remember the central principle: the learner already sees this exact page image while reading your cards, so your job is to teach its content effectively, not reproduce it. The attached page image is PRIMARY for structure/order/card boundaries/recipe choice. Wording comes only from the numbered lines below.',
    '',
    'PAGE NUMBER',
    String(input.pageNumber),
    '',
    ...(imageOnly
      ? []
      : [
          'NUMBERED SOURCE LINES (best-effort reading order — the attached page image is authoritative for structure/order when they disagree; this text is the ONLY source for exact wording)',
          input.numberedSourceLines,
          '',
        ]),
    'DETECTED IMAGE REGIONS',
    JSON.stringify(input.imageRegions),
    '',
    'EXISTING TAGS (prefer these; propose a new one only when none fit — see TAGS)',
    input.existingTags?.length ? input.existingTags.join(', ') : '(none yet — this is the first page processed; propose whatever broad tags genuinely fit)',
    '',
    'CARD RECIPES',
    RECIPE_SCHEMA_SUMMARY,
    '',
    'Important:',
    '- Work only from this page. Do not use adjacent pages to add content.',
    imageOnly
      ? '- There are no numbered source lines on this page — transcribe wording directly from the image instead, and mark every block needs_review with the reason above; you still generate the translation field yourself.'
      : '- The image drives structure; the numbered lines are the only source for wording; you generate the translation field yourself.',
    ...(imageOnly ? [] : ['- Reference every meaningful (non-furniture) source line.']),
    '- Split every numbered/lettered item (including vrai/faux batteries) into its own card — never merge them.',
    '- Test each activity\'s actual underlying task against the recipe menu before picking one — a pair/group-work instruction ("À deux", "En groupe") describes classroom grouping, not an interaction type by itself. Decompose an activity that bundles several distinct tasks into multiple appropriately-reciped cards rather than forcing one generic/freeform card.',
    '- Use "categorize" for sorting-into-groups exercises rather than forcing matching_pairs; "vocabulary" for word groups; "grammar_rule" for grammar points — not generic "text".',
    '- Never repeat the same label across title/instruction/content, and never leave an orphan fragment card (lone heading, lone image reference) — fold it into its neighbor.',
    '- Never create a card whose entire content is just a page number.',
    '- Images should become image_ref cards using the supplied region metadata; a diagram/hierarchy that is really a picture (e.g. a family tree) belongs here too, not in "table".',
    '- Extract visible audio labels as unresolved audio_ref cards.',
    '- Return JSON matching the required schema only.',
    ...(input.adminInstructions ? ['', 'ADMIN INSTRUCTIONS', input.adminInstructions] : []),
  ].join('\n');
}

export const COMPLETENESS_AUDIT_SYSTEM_PROMPT = `You are auditing a set of learning cards generated from one textbook page for a French-reading app.

Remember the app's central principle: the learner sees the original page image at all times, so a card's job is to teach the content effectively, not reproduce the page. "Faithful" means faithful to content and wording — not to exact print layout or interaction format. Do not flag a card for using a different interaction shape, different card boundaries, or a different grouping than the literal print format — that's allowed by design. Only flag it if the WORDING (source_text) was altered, or if a recipe choice actively produces a worse card than an available alternative would (e.g. a categorization exercise forced into matching_pairs, or a diagram forced into "table" instead of "image_ref"/"freeform").

You are given the same page image (attached as a one-page PDF) the extraction pass had, the original numbered source lines, and the extracted cards. Compare all three and identify fidelity problems.

Do not rewrite the page. Do not add educational content. Do not suggest enrichment. Do not answer exercises. Do not mark harmless whitespace/line-break differences as errors. Do not flag a card for skipping true page furniture (bare page numbers, decorative marks) — that's intended.

Check for:
- meaningful (non-furniture) source lines that are missing or duplicated;
- altered or improved wording anywhere in source_text — this is the one thing that must never happen;
- a translation field that leaked into or altered source_text, or that's missing on a card that clearly has content to translate;
- card order/grouping mistakes — use the page image as ground truth (e.g. content that visually belongs together wrongly split/merged/reordered relative to what the image actually shows);
- content mapped to a recipe that produces a worse card than another recipe would have (categorize vs matching_pairs, image_ref/freeform vs table for a diagram);
- exercise choices, blanks, or labels that were lost;
- dialogue speaker/order mistakes;
- missing audio or image references;
- invented content not supported by the source;
- single_choice used where the source allows multiple answers, or multi_select used where it allows only one;
- a freeform tree using a primitive type outside the allowed list, or one that doesn't visually mirror the actual page layout it's representing;
- a visible section number, title, or instruction that wasn't captured in the corresponding card's fields;
- a card whose prompt still concatenates multiple numbered/lettered items (including an incomplete vrai/faux battery) that should have been split, one card per item.

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
}): string {
  return [
    'The same page image (one-page PDF) is attached again — use it as ground truth for card structure/order.',
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
- restore correct card order and grouping (use the page image to determine what's actually correct, especially for reading_order_issues);
- split a card flagged by merged_subquestion_issues into one card per item;
- switch to a better-fitting recipe only when the audit flagged the current one as wrong (composed_activity_misuse, choice_intent_errors, incorrect_component_mappings) — never change a recipe that wasn't flagged;
- add or fix a translation only when flagged by translation_issues — never touch source_text while doing so;
- restore dropped section_number/title/instruction metadata flagged by the audit;
- restore dropped or invented rich-text emphasis flagged by the audit;
- never answer exercises; never enrich; never translate the French content itself (only the dedicated translation field); never guess image content; never guess audio filenames;
- every meaningful (non-furniture) source line must be represented;
- source_text/source_line_ids must still be copied verbatim from the numbered source lines, never transcribed fresh from the image;
- return JSON only, matching the same output contract as the original extraction (page_number, detected_language, blocks, page_warnings, unresolved_references).`;

export function buildRepairUserPrompt(input: {
  numberedSourceLines: string;
  imageRegions: ImageRegionInput[];
  currentExtractionJson: unknown;
  auditJson: unknown;
  adminInstructions?: string | null;
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
- WRONG RECIPE FOR THE CONTENT: a vocabulary group sitting in a generic "text" card should become "vocabulary". A single grammar point sitting in a generic "text" card should become "grammar_rule". A sorting-into-groups exercise squeezed into "matching_pairs" should become "categorize".
- MISSING CATEGORY: set "category" (vocabulary/grammar/culture/reading/exercise/audio/writing, or null) on cards where it's obviously one of these and currently null.
- MISSING OR POOR TAGS: set "tags" on any card with real content and no tags (or only weak/mismatched ones), preferring the EXISTING TAGS list below over inventing a new one.
- MISSING TRANSLATION: any card with real content (non-empty source_text) but a null translation — add one; never leave it null except for a card with genuinely nothing to translate.
- LEFTOVER FURNITURE: a card whose entire content is just a page number — remove it entirely.

ABSOLUTE LIMITS — THESE NEVER CHANGE DURING POLISH:
- Never alter, paraphrase, or "improve" any source_text or French wording anywhere. If a fix requires touching wording, don't make that fix.
- Never touch source_line_ids in a way that would misattribute lines.
- Never invent new content, answers, or explanations.
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
