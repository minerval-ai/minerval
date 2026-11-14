import { ArgumentText } from "./ArgumentText";
import { HeldPart } from "./claim/HeldPart";
import type { Block } from "@/lib/published-page/shape";

/**
 * Assessment prose (issue #203): a summary or reasoning trace, split on blank
 * lines into paragraphs, with the same inline conventions as argument written
 * forms: [[claim:<id>]] references linked (resolving to canonical text via
 * `texts` when the claim is in the decomposition), bare source URLs linked.
 * Assessments written before the convention are plain prose and render
 * exactly as they always did.
 */
export function AssessmentText({
  content,
  texts,
  blocks,
  categories,
}: {
  content: string;
  texts?: Map<string, string>;
  /**
   * A published page's paragraphs (docs/published-pages.md): each is its
   * author's text, or a part that is held, which stands in its place. Given
   * in place of `content`, with the categories its removals are marked with.
   */
  blocks?: Block[];
  categories?: string[];
}) {
  if (blocks) {
    return (
      <>
        {blocks.map((b, i) =>
          b.held ? (
            <HeldPart key={i} held={b.held} />
          ) : (
            b.text.split(/\n{2,}/).map((para, j) => (
              <p key={`${i}-${j}`}>
                <ArgumentText content={para} texts={texts} categories={categories} />
              </p>
            ))
          ),
        )}
      </>
    );
  }
  return (
    <>
      {content.split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          <ArgumentText content={para} texts={texts} />
        </p>
      ))}
    </>
  );
}
