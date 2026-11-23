"use client";
/**
 * All buttons. Minimum 44px tall (thumb rule). `href` renders a Next Link.
 */
import Link from "next/link";
import Icon from "./icons.js";

const VARIANTS = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2",
  tertiary: "bg-transparent text-accent border border-accent hover:bg-accent-soft",
  text: "bg-transparent text-accent hover:bg-accent-soft",
  danger: "bg-danger text-white hover:brightness-110 dark:text-[#2a0e0b]",
  "danger-text": "bg-transparent text-danger hover:bg-danger-soft",
};

/**
 * @param {object} props
 * @param {"primary"|"secondary"|"tertiary"|"text"|"danger"|"danger-text"} [props.variant]
 * @param {"md"|"lg"} [props.size]
 * @param {boolean} [props.loading]
 * @param {string} [props.loadingLabel]
 * @param {string} [props.icon] icon name
 * @param {boolean} [props.fullWidth]
 * @param {string} [props.href]
 */
export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingLabel,
  icon,
  fullWidth = false,
  href,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}) {
  const classes = [
    "inline-flex items-center justify-center gap-2 rounded-md font-semibold select-none",
    "transition-[filter,background-color] duration-[var(--dur-fast)]",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    size === "lg" ? "min-h-[52px] px-5 text-[17px]" : "min-h-[44px] px-4 text-[16px]",
    fullWidth ? "w-full" : "",
    VARIANTS[variant] || VARIANTS.primary,
    className,
  ].join(" ");
  const content = (
    <>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={20} /> : null}
      <span className="min-w-0">{loading && loadingLabel ? loadingLabel : children}</span>
    </>
  );
  if (href && !disabled) {
    return (
      <Link href={href} className={classes} {...rest}>
        {content}
      </Link>
    );
  }
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {content}
    </button>
  );
}

/**
 * Icon-only 44×44 button; `label` is required and becomes aria-label.
 * @param {{icon:string, label:string, pressed?:boolean, size?:number}} props
 */
export function IconButton({ icon, label, pressed, size = 22, className = "", type = "button", ...rest }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={`inline-flex items-center justify-center w-11 h-11 min-w-11 rounded-md text-text hover:bg-surface-2 disabled:opacity-50 ${pressed ? "bg-accent-soft text-accent" : ""} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
