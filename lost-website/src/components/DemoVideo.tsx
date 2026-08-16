import { useRef, useState } from "react";
import { Play, Pause, RotateCcw, Volume2, VolumeX, Clapperboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

interface Props {
  src: string | null;
  poster: string | null;
  className?: string;
}

/*  The walkthrough.

    A plug-in that fights feedback is hard to sell in prose, because the thing it does is
    a sound that *stops happening*. So the clip carries its own controls rather than the
    browser's: the one control that matters here is sound, and a native control bar hides
    it behind a hover.

    When no clip has been published the section does not pretend. It renders the poster,
    says plainly that the clip is not up yet, and points at the demo build instead --
    which is a better answer than a play button that does nothing.                    */
export function DemoVideo({ src, poster, className }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);

  const toggle = () => {
    const el = video.current;
    if (!el) return;

    if (el.paused) {
      void el.play();
      /*  Unmute on the first real play. Browsers only allow autoplay while muted, so the
          clip starts silent -- but somebody who has deliberately pressed play on a video
          about *how something sounds* wants to hear it.                              */
      el.muted = false;
      setMuted(false);
    } else {
      el.pause();
    }
  };

  const restart = () => {
    const el = video.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play();
  };

  const toggleMute = () => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };

  //---------------------------------------------------------------- nothing to play
  if (!src) {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border-2 border-foreground/12 bg-card",
          className
        )}
      >
        {poster && (
          <img
            src={poster}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-25"
            draggable={false}
          />
        )}

        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <Clapperboard className="size-7 text-muted-foreground" aria-hidden="true" />
          <p className="t-heading">The walkthrough is not up yet</p>
          <p className="t-small max-w-sm text-muted-foreground">
            Rather than a staged clip, the demo build is the real thing &mdash; the same
            binary buyers get. Take it to a rehearsal and turn the wedge up.
          </p>
          <Button asChild variant="outline" className="mt-2">
            <a href="#download">Get the demo build</a>
          </Button>
        </div>
      </div>
    );
  }

  //------------------------------------------------------------------- a real clip
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border-2 border-foreground/12 bg-black",
        className
      )}
    >
      <video
        ref={video}
        src={src}
        poster={poster ?? undefined}
        playsInline
        muted={muted}
        preload="metadata"
        className="h-full w-full object-cover"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setProgress(el.duration ? (el.currentTime / el.duration) * 100 : 0);
        }}
        onClick={toggle}
      />

      {/* A big target while it is stopped, out of the way once it is running. */}
      {!playing && (
        <button
          type="button"
          onClick={toggle}
          aria-label="Play the walkthrough"
          className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/15"
        >
          <span className="flex size-16 items-center justify-center rounded-full border-[3px] border-black bg-[#FFE500] shadow-lg transition-transform group-hover:scale-105">
            <Play className="size-6 translate-x-0.5 fill-black text-black" />
          </span>
        </button>
      )}

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent p-3",
          "transition-opacity",
          playing ? "opacity-0 group-hover:opacity-100 focus-within:opacity-100" : "opacity-100"
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
        </button>

        <button
          type="button"
          onClick={restart}
          aria-label="Start again"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <RotateCcw className="size-4" />
        </button>

        {/* Presentational: the buttons either side are the controls. */}
        <div className="mx-1 h-1 flex-1 overflow-hidden rounded-full bg-white/25">
          <div className="h-full bg-[#FFE500]" style={{ width: `${progress}%` }} />
        </div>

        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      </div>

      {muted && playing && (
        <Badge className="absolute top-3 right-3 bg-black/70 text-white">
          Sound off &mdash; tap to hear it
        </Badge>
      )}
    </div>
  );
}
