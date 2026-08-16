import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  /*  No global uppercase.

      The reference sets "BUY - $99.99" in caps and "Try the demo" in sentence case, and
      that difference is doing work: the caps mark the committing action, the sentence
      case marks the safe one. Forcing every label to caps would flatten that distinction
      and take the decision away from whoever writes the label.                          */
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-bold tracking-[0.06em] transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0",
  {
    variants: {
      variant: {
        /*  Both buttons are drawn the same way: a solid fill inside a hard black
            outline, like the hand-drawn artwork above them. The outline is what ties
            them to the illustration -- without it the yellow pill reads as a generic
            web button sitting under a cartoon.

            Colour alone carries the difference in weight: yellow for the committing
            action, grey for the safe one. Black on this yellow measures about 15:1, so
            the loudest control is also the most legible, rather than trading one for
            the other.                                                                 */
        default:
          "border-[3px] border-black bg-[#FFE500] text-black hover:bg-[#FFEE3A] active:translate-y-px",
        outline:
          "border-[3px] border-black bg-[#EFEFEF] text-black hover:bg-[#E4E4E4] active:translate-y-px",
        // The orange dome from the casing, flattened. For secondary actions.
        orange:
          "bg-primary text-primary-foreground shadow-[0_6px_18px_-4px_rgba(240,138,44,0.55),inset_0_1px_0_rgba(255,255,255,0.45)] hover:brightness-105 active:translate-y-px",
        destructive:
          "bg-destructive text-destructive-foreground hover:brightness-105",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "hover:bg-secondary",
        link: "text-foreground underline-offset-4 hover:underline rounded-none",
      },
      size: {
        default: "h-11 px-6 has-[>svg]:px-5",
        sm: "h-9 px-4 text-xs",
        // 175px tall in the 4686-wide Figma frame; 0.2988 of that is 52px.
        lg: "h-13 px-8 text-sm",
        icon: "size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
