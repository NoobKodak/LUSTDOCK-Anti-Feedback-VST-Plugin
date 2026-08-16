import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-11 w-full min-w-0 rounded-lg border-2 border-input bg-background px-3.5 py-2 text-sm transition-[color,box-shadow]",
        "placeholder:text-muted-foreground/60 selection:bg-primary selection:text-primary-foreground",
        "focus-visible:border-ring",
        "aria-invalid:border-destructive",
        "disabled:pointer-events-none disabled:opacity-50",
        "file:inline-flex file:border-0 file:bg-transparent file:text-sm",
        className
      )}
      {...props}
    />
  );
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-24 w-full rounded-lg border-2 border-input bg-background px-3.5 py-2.5 text-sm transition-[color,box-shadow]",
        "placeholder:text-muted-foreground/60",
        "focus-visible:border-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Input, Textarea };
