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

/** The software itself. A key with nothing to unlock is not a product, so this sits on
 *  each product page, on the confirmation page and in the order lookup. */
export function DownloadPanel({ slug, orderNumber, email, compact }: Props) {
  const release = useRelease(slug);

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

  if (compact) {
    return (
      <Button asChild className="w-full">
        <a href={release.url_path} download onClick={start}>
          <DownloadIcon /> Download — {megabytes(release.size_bytes)}
        </a>
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="min-w-60 flex-1">
            <p className="text-sm font-bold break-all">{release.filename}</p>
            <p className="mt-1 t-small text-muted-foreground">
              Version {release.version} · Windows 10 / 11 64-bit · {megabytes(release.size_bytes)}
            </p>
          </div>

          <Button asChild>
            <a href={release.url_path} download onClick={start}>
              <DownloadIcon /> Download installer
            </a>
          </Button>
        </div>

        {release.notes && (
          <p className="t-body text-muted-foreground">{release.notes}</p>
        )}
      </CardContent>
    </Card>
  );
}

