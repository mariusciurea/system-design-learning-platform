import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-on-fill hover:bg-brand/90 shadow-sm',
  secondary: 'bg-elevated text-ink border border-line hover:border-brand/50 hover:text-brand',
  ghost: 'text-muted hover:bg-elevated hover:text-ink',
  danger: 'bg-danger text-on-fill hover:bg-danger/90 shadow-sm',
  success: 'bg-ok text-on-fill hover:bg-ok/90 shadow-sm',
  outline: 'border border-line text-ink hover:bg-elevated',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2.5',
  icon: 'h-9 w-9 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex select-none items-center rounded-xl font-medium transition-[color,background-color,border-color,transform] duration-150',
        // A press sinks the button a little: the click was felt before anything else changes.
        'active:scale-[0.97] disabled:active:scale-100',
        'disabled:cursor-not-allowed disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
