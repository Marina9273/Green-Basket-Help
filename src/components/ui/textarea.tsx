import * as React from "react"

import { cn } from "@/lib/utils"
import { useTranslation } from 'react-i18next'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, required, onInvalid, onInput, ...props }, ref) => {
    const { t } = useTranslation('common')

    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        required={required}
        onInvalid={(e) => {
          if (required) {
            e.preventDefault();
            e.currentTarget.setCustomValidity(t('validation.requiredField'));
          }
          if (onInvalid) onInvalid(e);
        }}
        onInput={(e) => {
          e.currentTarget.setCustomValidity('');
          if (onInput) onInput(e);
        }}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
