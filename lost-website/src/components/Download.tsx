import { useEffect, useState } from "react";
import { Download as DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchRelease, recordDownload, type Release } from "@/lib/supabase";

export function useRelease(slug: string | undefined) {
  const [release, setRelease] = useState<Release | null>(null);

  useEffect(() => {
    if (!slug) {
      setRelease(null);
      return;
    }

    fetchRelease(slug).then(setRelease).catch(() => setRelease(null));
  }, [slug]);

  return release;
}

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  slug: string;
  /** Set on the confirmation and lookup pages so the download is tied to the order. */
  orderNumber?: string;
  email?: string;
  compact?: boolean;
}

type Platform = "windows" | "mac";

/*  What the visitor is most likely running.

    Used only to choose which tab opens, never to hide anything -- both are always one
    click away. Guessing wrong costs a click; guessing right means a Mac user learns
    there is no Mac build before downloading an .exe that cannot run, which is the whole
    reason this control exists.                                                        */
function guessPlatform(): Platform {
  if (typeof navigator === "undefined") return "windows";

  const hint = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const source = `${hint ?? ""} ${navigator.userAgent}`;

  // iPads report as Macintosh, which is close enough: neither runs a VST3.
  return /mac|iphone|ipad|ipod/i.test(source) ? "mac" : "windows";
}

/** The software itself. A key with nothing to unlock is not a product, so this sits on
 *  each product page, on the confirmation page and in the order lookup. */
export function DownloadPanel({ slug, orderNumber, email, compact }: Props) {
  const release = useRelease(slug);

  /*  Read once on mount rather than on every render, so the tab never changes underneath
      somebody who has already picked the other one.                                    */
  const [platform, setPlatform] = useState<Platform>(guessPlatform);

  if (!release) {
    return compact ? null : (
      <p className="t-body text-muted-foreground">
        No build has been published for this plug-in yet.
      </p>
    );
  }

  const start = () => {
    // Fire and forget: a logging failure must never stand between someone and the file.
    void recordDownload(release.version, orderNumber, email);
  };

  /*  Whether the file is ours to command.

      The `download` attribute is obeyed only for same-origin links. Point it at another
      host and every browser silently ignores it and navigates instead -- which for an
      .exe usually still downloads, but by way of a blank tab, and for anything the
      browser can render would display the file rather than save it.

      So a hosted build has to carry the instruction in its own response headers instead.
      Supabase Storage does that when the URL ends in `?download=`; the admin form says so
      where the URL is entered. All this flag does is stop us claiming an attribute that
      would not be honoured, and open the link cleanly when it is not.                  */
  const sameOrigin = release.url_path.startsWith("/");

  const linkProps = sameOrigin
    ? { href: release.url_path, download: true, onClick: start }
    : { href: release.url_path, rel: "noopener noreferrer", onClick: start };

  if (compact) {
    return (
      <Button asChild className="w-full">
        <a {...linkProps}>
          <DownloadIcon /> Download — {megabytes(release.size_bytes)}
        </a>
      </Button>
    );
  }

  /*  The two halves of the segmented control.

      Written as one function because the only differences are the label and which state
      it selects, and two near-identical blocks of Tailwind drift apart the moment either
      is touched.                                                                       */
  const tab = (value: Platform, label: string) => {
    const active = platform === value;

    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setPlatform(value)}
        className={
          "rounded-full px-5 py-1.5 text-sm font-bold tracking-[0.06em] transition-colors " +
          (active
            ? "bg-[#FFE500] text-black"
            : "text-black/55 hover:text-black hover:bg-black/5")
        }
      >
        {label}
      </button>
    );
  };

  return (
    <Card>
      <CardContent className="space-y-5">
        {/*  Not a dropdown. Two options, both worth seeing without a click -- and the one
            piece of information a Mac owner most needs is that a Mac build exists as a
            plan and not yet as a file.                                                 */}
        <div
          role="tablist"
          aria-label="Operating system"
          className="inline-flex gap-1 rounded-full border-[3px] border-black bg-white p-1"
        >
          {tab("windows", "Windows")}
          {tab("mac", "macOS")}
        </div>

        {platform === "windows" ? (
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-60 flex-1">
              <p className="text-sm font-bold break-all">{release.filename}</p>
              <p className="mt-1 t-small text-muted-foreground">
                Version {release.version} · Windows 10 / 11 64-bit · {megabytes(release.size_bytes)}
              </p>
            </div>

            <Button asChild>
              <a {...linkProps}>
                <DownloadIcon /> Download installer
              </a>
            </Button>
          </div>
        ) : (
          /*  No button, disabled or otherwise.

              A greyed-out Download is a thing to click at and wonder about. Saying plainly
              that the file does not exist yet answers the question the click was going to
              ask, and the licence note is the one that saves an email later: keys are not
              platform-specific, so buying today is not a wasted purchase.               */
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-60 flex-1">
              <p className="text-sm font-bold">macOS build — coming soon</p>
              <p className="mt-1 t-small text-muted-foreground">
                AU and VST3 for Apple silicon and Intel. Not ready yet, and there is no
                date worth promising.
              </p>
            </div>

            <span className="rounded-full border-[3px] border-black bg-[#EFEFEF] px-6 py-2.5 text-sm font-bold tracking-[0.06em] text-black/55">
              Coming soon
            </span>
          </div>
        )}

        {platform === "mac" && (
          <p className="t-small text-muted-foreground">
            Your licence key is not tied to an operating system. Buy now and the same key
            will activate the Mac build when it lands.
          </p>
        )}

        {platform === "windows" && release.notes && (
          <p className="t-body text-muted-foreground">{release.notes}</p>
        )}
      </CardContent>
    </Card>
  );
}

