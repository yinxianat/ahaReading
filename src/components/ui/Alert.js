"use client";
/**
 * Inline alert. Always pairs a message with an action or a dismiss (L-UX6).
 */
import Icon from "./icons.js";
import Button from "./Button.js";

const TONES = {
  info: "bg-accent-soft border-accent/30 text-text",
  neutral: "bg-surface-2 border-border text-text",
  warning: "bg-warning-soft border-warning/40 text-text",
  danger: "bg-danger-soft border-danger/40 text-text",
  success: "bg-success-soft border-success/40 text-text",
};
const ICON_TONE = { info: "text-accent", neutral: "text-muted", warning: "text-warning", danger: "text-danger", success: "text-success" };

/**
 * @param {object} props
 * @param {"info"|"warning"|"danger"|"success"|"neutral"} [props.tone]
 * @param {string} [props.title]
 * @param {{label:string, onClick?:() => void, href?:string, disabled?:boolean}} [props.action]
 * @param {{label:string, onClick?:() => void, href?:string}} [props.secondaryAction]
 * @param {() => void} [props.onDismiss]
 * @param {boolean} [props.compact]
 */
export default function Alert({ tone = "info", title, children, action, secondaryAction, onDismiss, compact = false, className = "", role }) {
  const icon = tone === "success" ? "check" : tone === "danger" || tone === "warning" ? "alert" : "info";
  return (
    <div
      role={role || (tone === "danger" ? "alert" : "status")}
      className={`relative flex gap-3 rounded-md border ${compact ? "p-3" : "p-4"} ${TONES[tone] || TONES.info} ${className}`}
    >
      <span className={`mt-0.5 ${ICON_TONE[tone]}`}>
        <Icon name={icon} size={20} />
      </span>
      <div className={`min-w-0 flex-1 break-anywhere ${onDismiss ? "pr-8" : ""}`}>
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="text-[15px] leading-snug">{children}</div>
        {action || secondaryAction ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {action ? (
              <Button variant="secondary" onClick={action.onClick} href={action.href} disabled={action.disabled}>
                {action.label}
              </Button>
            ) : null}
            {secondaryAction ? (
              <Button variant="text" onClick={secondaryAction.onClick} href={secondaryAction.href}>
                {secondaryAction.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute right-1 top-1 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:bg-black/5"
        >
          <Icon name="x" size={18} />
        </button>
      ) : null}
    </div>
  );
}
