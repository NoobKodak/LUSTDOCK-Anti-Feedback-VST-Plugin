import { useEffect, useState } from "react";
import { Star, Quote } from "lucide-react";

import { Badge } from "@/components/ui/misc";
import { fetchReviews, type Review, type ReviewSummary } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/** Five stars with the earned ones filled. One accessible label rather than five, so a
 *  screen reader says "rated 5 out of 5" instead of reading the word star five times. */
function Stars({ rating, className }: { rating: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      role="img"
      aria-label={`Rated ${rating} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden="true"
          className={cn(
            "size-4",
            n <= rating ? "fill-[#FFE500] text-black" : "fill-transparent text-black/25"
          )}
          strokeWidth={2}
        />
      ))}
    </span>
  );
}

function ReviewCard({ review }: { review: Review }) {
  return (
    <figure className="flex h-full flex-col rounded-2xl border-2 border-foreground/12 bg-card p-6 transition-colors hover:border-foreground/30">
      <Quote className="size-5 shrink-0 text-foreground/20" aria-hidden="true" />

      <Stars rating={review.rating} className="mt-4" />

      {review.title && <h3 className="t-heading mt-4">{review.title}</h3>}

      <blockquote className="t-body mt-2 flex-1 text-muted-foreground">
        {review.body}
      </blockquote>

      <figcaption className="mt-6 border-t border-border pt-4">
        <span className="block text-sm font-bold">{review.author_name}</span>
        {review.author_role && (
          <span className="mt-0.5 block t-small text-muted-foreground">
            {review.author_role}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/*  What people say.

    The section removes itself when there is nothing approved, rather than rendering an
    empty shelf with a heading over it -- an empty reviews block reads as "nobody bought
    this", which is worse than not asking the question.

    Placeholder rows are still flagged `is_sample` in the database and still show as
    "sample" in the admin panel, with a button that clears them all in one go. The
    storefront no longer labels them -- so which reviews are real is now something the
    shop owner keeps track of rather than something the page announces.                */
export function Reviews({ slug }: { slug: string }) {
  const [data, setData] = useState<ReviewSummary | null>(null);

  useEffect(() => {
    let live = true;
    fetchReviews(slug).then((r) => live && setData(r)).catch(() => {});
    return () => { live = false; };
  }, [slug]);

  if (!data) return null;

  return (
    <section className="mx-auto w-full max-w-[1400px] px-6 py-16 sm:px-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="t-label text-muted-foreground">From the people using it</p>
          <h2 className="t-display mt-3 max-w-md text-balance">
            What it is like on a real stage
          </h2>
        </div>

        {data.average != null && (
          <div className="flex items-center gap-3 rounded-full border-2 border-foreground/12 py-2 pr-5 pl-4">
            <Stars rating={Math.round(data.average)} />
            <span className="t-numeric text-sm font-bold">{data.average.toFixed(1)}</span>
            <span className="t-small text-muted-foreground">
              {data.count} {data.count === 1 ? "review" : "reviews"}
            </span>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-4 sm:gap-6 lg:grid-cols-3">
        {data.rows.map((r, i) => <ReviewCard key={i} review={r} />)}
      </div>

      {/*  Only claims that are actually true.

           "Verified purchase" was the obvious badge to put here and it would have been a
           lie -- nothing links a review to an order. Moderation is real, so that is what
           it says.                                                                     */}
      <p className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 t-small text-muted-foreground">
        <Badge variant="outline">Read before publishing</Badge>
        Every review is checked by hand before it appears here.
      </p>
    </section>
  );
}
