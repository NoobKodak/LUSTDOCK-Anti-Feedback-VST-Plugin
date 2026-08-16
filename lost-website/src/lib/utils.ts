import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class helper: clsx for conditionals, tailwind-merge so a later class
 *  beats an earlier one instead of both landing in the DOM. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
