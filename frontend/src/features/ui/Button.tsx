import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

/**
 * Canonical button (v2.5.57). Composes the `.btn*` recipes from index.css so
 * every call site shares one padding/radius/hover/disabled treatment and stays
 * on-theme (no hard-coded `text-white` / `hover:bg-indigo-*`). Defaults
 * `type="button"` so buttons inside forms don't submit by accident.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={[
        'btn',
        VARIANT_CLASS[variant],
        size === 'sm' ? 'btn-sm' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
});

export default Button;
